"""Persistent local speech-to-text helper for the voice lab: Parakeet TDT 0.6B v3 (MLX) or Moonshine.

Started by server/adapters/localStt.ts (`npm run dev`), one process per engine, model loaded and warmed once.
Same framing as tools/macstt:
  stdin, one JSON header per line (a "pcm" header is followed by that many bytes):
    {"id":"1","cmd":"start","lang":"en"}     open a session
    {"id":"1","pcm":N}\\n + N bytes           PCM16 mono 24 kHz little-endian
    {"id":"1","cmd":"commit"}                end of audio: transcribe and send the result
    {"id":"1","cmd":"cancel"}                drop the session
  stdout, one JSON per line:
    {"id":"1","partial":"…"}                 the audio so far, re-transcribed every PARTIAL_EVERY seconds
    {"id":"1","final":true,"text":"…","words":[{"text","start","end"}],"ms":123}   (seconds from the first sample)
    {"id":"1","error":"…"}
    {"ready":true,"engine":"…"}              once, after the warm-up
Usage: .venv-stt/bin/python -I tools/localstt/server.py --engine parakeet|moonshine --models .models
"""
import argparse
import json
import os
import sys
import time

import numpy as np

RATE = 24000
OUT = sys.stdout.buffer
# Partials: re-run the whole clip while the key is held (both engines take ~0.1–0.3 s for a few seconds of
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

    def transcribe(self, audio, lang):
        a16 = self.resample_poly(audio, 2, 3).astype(np.float32)  # 24 kHz → 16 kHz
        if len(a16) < self.model.preprocessor_config.hop_length:
            return "", []
        r = self.model.generate(self.get_logmel(self.mx.array(a16), self.model.preprocessor_config))[0]
        words = []
        for s in r.sentences:
            for t in s.tokens:
                if t.text.startswith(" ") or not words:
                    words.append({"text": t.text.strip(), "start": t.start, "end": t.end})
                else:
                    words[-1]["text"] += t.text
                    words[-1]["end"] = t.end
        return r.text, [w for w in words if w["text"]]


class MoonshineEngine:
    """Moonshine Voice, English medium-streaming model (the catalogue has no Romanian), with word timestamps."""

    def __init__(self, models):
        from pathlib import Path

        from moonshine_voice.download import download_model_from_info, find_model_info
        from moonshine_voice.transcriber import Transcriber

        path, arch = download_model_from_info(find_model_info("en"), cache_root=Path(models) / "moonshine", include_word_timestamps=True)
        self.t = Transcriber(path, arch, options={"word_timestamps": "true"})

    def transcribe(self, audio, lang):
        tr = self.t.transcribe_without_streaming(audio, RATE)
        lines = [l for l in tr.lines if l.text and l.text.strip()]
        words = [{"text": w.word.strip(), "start": w.start, "end": w.end} for l in lines for w in (l.words or []) if w.word.strip()]
        return " ".join(l.text.strip() for l in lines), words


class Session:
    def __init__(self, lang):
        self.lang = lang
        self.chunks = []
        self.samples = 0
        self.last_partial = 0
        self.partial_text = ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", choices=["parakeet", "moonshine"], required=True)
    ap.add_argument("--models", required=True)
    args = ap.parse_args()
    engine = ParakeetEngine(args.models) if args.engine == "parakeet" else MoonshineEngine(args.models)
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
            if PARTIAL_EVERY > 0 and secs - s.last_partial >= PARTIAL_EVERY and secs <= PARTIAL_MAX:
                s.last_partial = secs
                try:
                    text, _ = engine.transcribe(to_float(b"".join(s.chunks)), s.lang)
                    if text and text != s.partial_text:
                        s.partial_text = text
                        emit({"id": rid, "partial": text})
                except Exception as e:  # a failed partial isn't fatal
                    print(f"partial failed: {e}", file=sys.stderr, flush=True)
            continue
        cmd = h.get("cmd")
        if cmd == "start":
            sessions[rid] = Session(h.get("lang", "en"))
        elif cmd == "cancel":
            sessions.pop(rid, None)
        elif cmd == "commit":
            s = sessions.pop(rid, None)
            if s is None:
                emit({"id": rid, "error": "no session"})
                continue
            t0 = time.perf_counter()
            try:
                text, words = engine.transcribe(to_float(b"".join(s.chunks)), s.lang) if s.samples else ("", [])
                emit({"id": rid, "final": True, "text": text, "words": words, "ms": int((time.perf_counter() - t0) * 1000)})
            except Exception as e:  # report and keep serving
                emit({"id": rid, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
