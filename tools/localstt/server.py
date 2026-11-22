"""Persistent local speech-to-text helper for Parakeet, Moonshine and Rumble 2 Flash.

Started by server/adapters/localStt.ts (`npm run dev`), one process per engine, model loaded and warmed once.
Same framing as tools/macstt:
  stdin, one JSON header per line (a "pcm" header is followed by that many bytes):
    {"id":"1","cmd":"start","lang":"en"}     open a session; "lang" null = detect, and "langs" (2+ codes)
                                             limits Rumble's detection to those languages
    {"id":"1","pcm":N}\\n + N bytes           PCM16 mono 24 kHz little-endian
    {"id":"1","cmd":"commit"}                end of audio: transcribe and send the result
    {"id":"1","cmd":"cancel"}                drop the session
  stdout, one JSON per line:
    {"id":"1","partial":"…"}                 the audio so far, re-transcribed every PARTIAL_EVERY seconds
    {"id":"1","final":true,"text":"…","words":[{"text","start","end"}],"ms":123}   (seconds from the first sample)
    Finals may include "language" (and "detected": what Rumble would have picked without the limit, when that
    differs); words is empty for engines without timestamps.
    {"id":"1","error":"…"}
    {"ready":true,"engine":"…"}              once, after the warm-up
Usage: <venv>/bin/python -I tools/localstt/server.py --engine parakeet|moonshine|rumble-2-flash --models .models
"""
import argparse
import json
import os
import sys
import time

import numpy as np

RATE = 24000
OUT = sys.stdout.buffer
# Partials: Parakeet and Moonshine re-run the whole clip while the key is held (~0.1–0.3 s for a few seconds of
# audio). Skipped past PARTIAL_MAX seconds, where a run would hold up the final.
PARTIAL_EVERY = float(os.environ.get("LOCAL_STT_PARTIAL_EVERY", "0.8"))
PARTIAL_MAX = 30.0


def emit(obj):
    OUT.write(json.dumps(obj).encode() + b"\n")
    OUT.flush()


def to_float(pcm: bytes):
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


class ParakeetEngine:
    """nvidia/parakeet-tdt-0.6b-v3 (25 European languages, detected; Romanian included). Tokens are
    subwords: one that starts with a space starts a new word."""

    REPO = "mlx-community/parakeet-tdt-0.6b-v3"

    def __init__(self, models):
        import mlx.core as mx
        from parakeet_mlx import from_pretrained
        from parakeet_mlx.audio import get_logmel
        from scipy.signal import resample_poly

        self.mx, self.get_logmel, self.resample_poly = mx, get_logmel, resample_poly
        self.model = from_pretrained(self.REPO, cache_dir=os.path.join(models, "parakeet"))

    def transcribe(self, audio, lang, langs=None):
        a16 = self.resample_poly(audio, 2, 3).astype(np.float32)  # 24 kHz → 16 kHz
        if len(a16) < self.model.preprocessor_config.hop_length:
            return "", [], None
        r = self.model.generate(self.get_logmel(self.mx.array(a16), self.model.preprocessor_config))[0]
        words = []
        for s in r.sentences:
            for t in s.tokens:
                if t.text.startswith(" ") or not words:
                    words.append({"text": t.text.strip(), "start": t.start, "end": t.end})
                else:
                    words[-1]["text"] += t.text
                    words[-1]["end"] = t.end
        return r.text, [w for w in words if w["text"]], None


class MoonshineEngine:
    """Moonshine Voice, English medium-streaming model (the catalogue has no Romanian), with word timestamps."""

    def __init__(self, models):
        from pathlib import Path

        from moonshine_voice.download import download_model_from_info, find_model_info
        from moonshine_voice.transcriber import Transcriber

        path, arch = download_model_from_info(find_model_info("en"), cache_root=Path(models) / "moonshine", include_word_timestamps=True)
        self.t = Transcriber(path, arch, options={"word_timestamps": "true"})

    def transcribe(self, audio, lang, langs=None):
        tr = self.t.transcribe_without_streaming(audio, RATE)
        lines = [l for l in tr.lines if l.text and l.text.strip()]
        words = [{"text": w.word.strip(), "start": w.start, "end": w.end} for l in lines for w in (l.words or []) if w.word.strip()]
        return " ".join(l.text.strip() for l in lines), words, None


class RumbleEngine:
    """Reson8 Rumble 2 Flash, with language detection and untimed batch transcripts.

    The model writes "language <Name><asr_text>" before the transcript. A pinned language is prefilled; a list of
    languages ("auto from the languages I speak") masks the name to those (or None, its answer for no speech), so the
    detection picks the most likely one of them in the same pass and the transcript follows it."""

    def __init__(self, models):
        import torch
        from scipy.signal import resample_poly
        from transformers import AutoModelForMultimodalLM, AutoProcessor, LogitsProcessorList
        from transformers.models.qwen3_asr.processing_qwen3_asr import LANGUAGE_CODE_TO_NAME

        path = os.path.join(models, "rumble-2-flash")
        self.torch, self.resample_poly, self.processors = torch, resample_poly, LogitsProcessorList
        self.names = LANGUAGE_CODE_TO_NAME
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        self.processor = AutoProcessor.from_pretrained(path, local_files_only=True)
        self.model = AutoModelForMultimodalLM.from_pretrained(path, local_files_only=True).to(device).eval()

    @staticmethod
    def code(lang):
        return "fil" if lang == "tl" else lang  # Transformers calls Filipino "fil".

    def limit(self, langs, prompt_len):
        """A logits processor that lets the language name be only one of `langs` (or None)."""
        tok = self.processor.tokenizer
        encode = lambda name: tok.encode(f"language {name}<asr_text>", add_special_tokens=False)
        seqs = [encode(self.names[c]) for c in map(self.code, langs) if c in self.names] + [encode("None")]
        # Each name's first token, for every language the model knows: what it would have picked without the limit.
        firsts = sorted({encode(n)[1] for n in self.names.values()})
        torch = self.torch
        state = {"top": None}

        def process(input_ids, scores):
            gen = input_ids[0, prompt_len:].tolist()
            nxt = {s[len(gen)] for s in seqs if len(gen) < len(s) and s[:len(gen)] == gen}
            if not nxt:
                return scores  # past the name: the transcript is free
            if len(gen) == 1:
                state["top"] = max(firsts, key=lambda t: scores[0, t].item())
            mask = torch.full_like(scores, float("-inf"))
            idx = torch.tensor(sorted(nxt), device=scores.device)
            mask[:, idx] = 0
            return scores + mask

        return process, state

    def transcribe(self, audio, lang, langs=None):
        a16 = self.resample_poly(audio, 2, 3)  # 24 kHz → 16 kHz
        inputs = self.processor.apply_transcription_request(a16, language=self.code(lang) if lang else None)
        inputs = inputs.to(self.model.device, dtype=self.model.dtype)
        limited = not lang and langs and len(langs) > 1
        extra, state = {}, None
        if limited:
            process, state = self.limit(langs, inputs["input_ids"].shape[-1])
            extra["logits_processor"] = self.processors([process])
        with self.torch.inference_mode():
            output = self.model.generate(**inputs, **extra)
        generated = output[:, inputs["input_ids"].shape[-1]:]
        parsed = self.processor.decode(generated, return_format="parsed")[0]
        language = parsed["language"] or lang
        if state and state["top"] is not None:
            heard = self.processor.tokenizer.decode([state["top"]]).strip()
            if language and not language.lower().startswith(heard.lower()):
                return parsed["transcription"], [], language, heard
        return parsed["transcription"], [], language


ENGINES = {
    "parakeet": ParakeetEngine,
    "moonshine": MoonshineEngine,
    "rumble-2-flash": RumbleEngine,
}


class Session:
    def __init__(self, lang, langs):
        self.lang = lang
        self.langs = langs
        self.chunks = []
        self.samples = 0
        self.last_partial = 0
        self.partial_text = ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", choices=ENGINES, required=True)
    ap.add_argument("--models", required=True)
    args = ap.parse_args()
    engine = ENGINES[args.engine](args.models)
    partials = args.engine != "rumble-2-flash"
    # Warm-up: the first run compiles kernels / allocates (Parakeet ~2.7 s); later ones are fast.
    t = np.linspace(0, 1, RATE, dtype=np.float32)
    engine.transcribe((0.1 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), "en")
    emit({"ready": True, "engine": args.engine})

    sessions = {}
    stdin = sys.stdin.buffer
    while True:
        line = stdin.readline()
        if not line:
            return
        try:
            h = json.loads(line)
        except ValueError:
            continue
        rid = h.get("id")
        if not rid:
            continue
        if "pcm" in h:
            data = stdin.read(int(h["pcm"]))
            s = sessions.get(rid)
            if s is None:
                continue
            s.chunks.append(data)
            s.samples += len(data) // 2
            secs = s.samples / RATE
            if partials and PARTIAL_EVERY > 0 and secs - s.last_partial >= PARTIAL_EVERY and secs <= PARTIAL_MAX:
                s.last_partial = secs
                try:
                    text = engine.transcribe(to_float(b"".join(s.chunks)), s.lang, s.langs)[0]
                    if text and text != s.partial_text:
                        s.partial_text = text
                        emit({"id": rid, "partial": text})
                except Exception as e:  # a failed partial isn't fatal
                    print(f"partial failed: {e}", file=sys.stderr, flush=True)
            continue
        cmd = h.get("cmd")
        if cmd == "start":
            sessions[rid] = Session(h.get("lang", "en"), h.get("langs") or None)
        elif cmd == "cancel":
            sessions.pop(rid, None)
        elif cmd == "commit":
            s = sessions.pop(rid, None)
            if s is None:
                emit({"id": rid, "error": "no session"})
                continue
            t0 = time.perf_counter()
            try:
                text, words, language, *heard = engine.transcribe(to_float(b"".join(s.chunks)), s.lang, s.langs) if s.samples else ("", [], None)
                result = {"id": rid, "final": True, "text": text, "words": words, "ms": int((time.perf_counter() - t0) * 1000)}
                if language:
                    result["language"] = language
                if heard:
                    result["detected"] = heard[0]
                emit(result)
            except Exception as e:  # report and keep serving
                emit({"id": rid, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
