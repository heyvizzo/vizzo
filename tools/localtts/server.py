"""Persistent local text-to-speech helper for the voice lab: Kokoro-82M (ONNX) or Piper.

Started by server/adapters/localTts.ts (`npm run dev`), one process per engine, models loaded once.
Same framed protocol as tools/mactts:
  stdin, one JSON per line:  {"id":"1","text":"Hello.","lang":"en","voice":"en_US-ryan-high"}   (lang: en | ro; voice optional)
                             {"cmd":"load","voice":"en_US-ryan-high"}   load + warm a voice ahead of use (Piper)
  stdout:                    {"id":"1","pcm":N}\\n + N bytes of PCM16 mono 24 kHz little-endian
                             {"id":"1","done":true,"voice":"…","ms":123}\\n
                             {"id":"1","error":"…"}\\n
                             {"ready":true,"engine":"…","voices":{…}}\\n   once, after the warm-up
Usage: .venv-tts/bin/python -I tools/localtts/server.py --engine kokoro|piper --models .models
"""
import argparse
import asyncio
import json
import os
import sys
import time

import numpy as np

RATE = 24000
OUT = sys.stdout.buffer


def emit(obj, data=None):
    OUT.write(json.dumps(obj).encode() + b"\n")
    if data:
        OUT.write(data)
    OUT.flush()


def to_pcm16(samples):
    """float32 [-1, 1] or int16 → PCM16 little-endian bytes."""
    a = np.asarray(samples)
    if a.dtype != np.int16:
        a = (np.clip(a, -1.0, 1.0) * 32767.0).astype("<i2")
    return a.astype("<i2").tobytes()


def resample_int16(pcm: bytes, rate: int) -> bytes:
    """Linear resampling of PCM16 mono to 24 kHz (Piper medium voices are 22.05 kHz)."""
    if rate == RATE:
        return pcm
    x = np.frombuffer(pcm, dtype="<i2").astype(np.float32)
    if not len(x):
        return b""
    n = int(round(len(x) * RATE / rate))
    y = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x)
    return np.clip(y, -32768, 32767).astype("<i2").tobytes()


def short_espeak_dir(data):
    """espeak-ng (in both Kokoro's espeakng_loader and Piper) can't use a data folder whose path is 160 bytes or longer:
    it silently falls back to the path it was built with (an error about /Users/runner/...). The packaged app's env sits
    under Application Support, which a long home folder can push past that, so then it gets a copy in the temp folder
    (resolved paths: a symlink doesn't do)."""
    data = str(data)
    if len(data.encode()) < 150:
        return data
    import hashlib
    import shutil
    import tempfile

    short = os.path.join(tempfile.gettempdir(), "espeak-" + hashlib.sha1(data.encode()).hexdigest()[:10])
    if not os.path.exists(os.path.join(short, "phontab")):
        part = short + ".part"
        shutil.rmtree(part, ignore_errors=True)
        shutil.copytree(data, part)
        shutil.rmtree(short, ignore_errors=True)
        os.replace(part, short)
    return short


def espeak_config():
    """Kokoro's espeak settings: its own data folder, moved to a short path if need be."""
    import espeakng_loader
    from kokoro_onnx import EspeakConfig

    data = espeakng_loader.get_data_path()
    short = short_espeak_dir(data)
    return None if short == data else EspeakConfig(data_path=short)


class KokoroEngine:
    # Kokoro has no Romanian voice: Romanian text is phonemized by espeak-ng ("ro") and read by the
    # Italian voice (closest phonology); English uses af_heart (Kokoro's top-rated voice).
    VOICES = {"en": ("af_heart", "en-us"), "ro": ("if_sara", "it")}

    def __init__(self, models):
        from kokoro_onnx import Kokoro

        d = os.path.join(models, "kokoro")
        self.k = Kokoro(os.path.join(d, "kokoro-v1.0.onnx"), os.path.join(d, "voices-v1.0.bin"), espeak_config=espeak_config())
        if os.environ.get("KOKORO_VOICE_EN"):
            self.VOICES = {**self.VOICES, "en": (os.environ["KOKORO_VOICE_EN"], "en-us")}

    def load(self, voice):
        pass  # all Kokoro voices live in one voices file, loaded at start

    async def speak(self, rid, text, lang, silent=False, voice_name=None):
        voice, klang = self.VOICES.get(lang, self.VOICES["en"])
        if voice_name and lang != "ro":
            voice = voice_name
        if lang == "ro":
            klang = "ro"  # espeak-ng Romanian phonemes, Italian voice
        async for samples, rate in self.k.create_stream(text, voice=voice, lang=klang):
            pcm = to_pcm16(samples)
            if rate != RATE:
                pcm = resample_int16(pcm, rate)
            if not silent and pcm:
                emit({"id": rid, "pcm": len(pcm)}, pcm)
        return voice


class PiperEngine:
    """Piper voices load on demand and stay cached (LRU, PIPER_CACHE voices, default 4). Romanian always
    uses ro_RO-mihai-medium (Piper's only Romanian voice); English uses the requested voice, else
    PIPER_VOICE, else en_US-lessac-high (falling back to -medium)."""

    RO = "ro_RO-mihai-medium"

    def __init__(self, models):
        from collections import OrderedDict

        from piper import PiperVoice
        from piper.phonemize_espeak import ESPEAK_DATA_DIR

        self.PiperVoice = PiperVoice
        self.espeak_dir = short_espeak_dir(ESPEAK_DATA_DIR)
        self.dir = os.path.join(models, "piper")
        self.cache = OrderedDict()
        self.max = int(os.environ.get("PIPER_CACHE", "4"))
        preferred = [os.environ.get("PIPER_VOICE"), "en_US-lessac-high", "en_US-lessac-medium"]
        self.default_en = next(v for v in preferred if v and self.exists(v))
        self.get(self.default_en)
        self.get(self.RO)

    def exists(self, name):
        return bool(name) and os.path.exists(os.path.join(self.dir, f"{name}.onnx"))

    def get(self, name):
        if name in self.cache:
            self.cache.move_to_end(name)
            return self.cache[name]
        voice = self.PiperVoice.load(os.path.join(self.dir, f"{name}.onnx"), espeak_data_dir=self.espeak_dir)
        self.cache[name] = voice
        while len(self.cache) > self.max:
            oldest = next(k for k in self.cache if k not in (self.default_en, self.RO))
            del self.cache[oldest]
        return voice

    def load(self, name):
        if self.exists(name):
            for _ in self.get(name).synthesize("Ready."):  # warm the ONNX session
                pass

    async def speak(self, rid, text, lang, silent=False, voice_name=None):
        name = self.RO if lang == "ro" else (voice_name if self.exists(voice_name) else self.default_en)
        voice = self.get(name)
        for chunk in voice.synthesize(text):  # one chunk per sentence
            pcm = resample_int16(chunk.audio_int16_bytes, chunk.sample_rate)
            if not silent and pcm:
                emit({"id": rid, "pcm": len(pcm)}, pcm)
            await asyncio.sleep(0)
        return name


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", choices=["kokoro", "piper"], required=True)
    ap.add_argument("--models", required=True)
    args = ap.parse_args()
    engine = KokoroEngine(args.models) if args.engine == "kokoro" else PiperEngine(args.models)
    # Warm-up: the first synthesis per language is the slow one.
    for lang, text in (("en", "Ready."), ("ro", "Gata.")):
        await engine.speak("_warm", text, lang, silent=True)
    emit({"ready": True, "engine": args.engine})

    loop = asyncio.get_running_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            return
        try:
            req = json.loads(line)
        except ValueError:
            continue
        if req.get("cmd") == "load":
            try:
                engine.load(req.get("voice"))
                emit({"loaded": req.get("voice")})
            except Exception as e:
                emit({"error": f"load {req.get('voice')}: {type(e).__name__}: {e}"})
            continue
        rid, text = req.get("id"), req.get("text", "")
        if not rid:
            continue
        t0 = time.perf_counter()
        try:
            voice = await engine.speak(rid, text, req.get("lang", "en"), voice_name=req.get("voice"))
            emit({"id": rid, "done": True, "voice": voice, "ms": int((time.perf_counter() - t0) * 1000)})
        except Exception as e:  # report and keep serving
            emit({"id": rid, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    asyncio.run(main())
