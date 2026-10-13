"""Persistent local text-to-speech helper for the voice lab: Kokoro-82M (ONNX) or Piper.

Started by server/adapters/localTts.ts (`npm run dev`), one process per engine, models loaded once.
Same framed protocol as tools/mactts:
  stdin, one JSON per line:  {"id":"1","text":"Hello.","lang":"en"}       (lang: en | ro)
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


class KokoroEngine:
    # Kokoro has no Romanian voice: Romanian text is phonemized by espeak-ng ("ro") and read by the
    # Italian voice (closest phonology); English uses af_heart (Kokoro's top-rated voice).
    VOICES = {"en": ("af_heart", "en-us"), "ro": ("if_sara", "it")}

    def __init__(self, models):
        from kokoro_onnx import Kokoro

        d = os.path.join(models, "kokoro")
        self.k = Kokoro(os.path.join(d, "kokoro-v1.0.onnx"), os.path.join(d, "voices-v1.0.bin"))
        if os.environ.get("KOKORO_VOICE_EN"):
            self.VOICES = {**self.VOICES, "en": (os.environ["KOKORO_VOICE_EN"], "en-us")}

    async def speak(self, rid, text, lang, silent=False):
        voice, klang = self.VOICES.get(lang, self.VOICES["en"])
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
    VOICES = {"en": "en_US-lessac-medium", "ro": "ro_RO-mihai-medium"}

    def __init__(self, models):
        from piper import PiperVoice

        d = os.path.join(models, "piper")
        self.voices = {lang: PiperVoice.load(os.path.join(d, f"{name}.onnx")) for lang, name in self.VOICES.items()}

    async def speak(self, rid, text, lang, silent=False):
        name = self.VOICES.get(lang, self.VOICES["en"])
        voice = self.voices.get(lang, self.voices["en"])
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
        rid, text = req.get("id"), req.get("text", "")
        if not rid:
            continue
        t0 = time.perf_counter()
        try:
            voice = await engine.speak(rid, text, req.get("lang", "en"))
            emit({"id": rid, "done": True, "voice": voice, "ms": int((time.perf_counter() - t0) * 1000)})
        except Exception as e:  # report and keep serving
            emit({"id": rid, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    asyncio.run(main())
