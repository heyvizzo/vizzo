#!/usr/bin/env bash
# Local TTS models (offline): Kokoro-82M (ONNX) and Piper (en_US lessac + ro_RO mihai voices).
# Creates .venv-tts (Python 3.12 via uv) and downloads models into .models/{kokoro,piper}. Idempotent.
#   npm run setup:local-tts
set -euo pipefail
cd "$(dirname "$0")/.."
command -v uv >/dev/null || { echo "uv is required (https://docs.astral.sh/uv/)"; exit 1; }

[ -x .venv-tts/bin/python ] || uv venv .venv-tts --python 3.12
uv pip install --python .venv-tts/bin/python --quiet "kokoro-onnx>=0.4" onnxruntime "piper-tts>=1.3" numpy

fetch() { # url dest
  if [ -s "$2" ]; then echo "  have $(basename "$2")"; return; fi
  mkdir -p "$(dirname "$2")"
  echo "  downloading $(basename "$2")"
  curl -fL --retry 3 -o "$2.part" "$1" && mv "$2.part" "$2"
}
K=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
P=https://huggingface.co/rhasspy/piper-voices/resolve/main
fetch "$K/kokoro-v1.0.onnx" .models/kokoro/kokoro-v1.0.onnx
fetch "$K/voices-v1.0.bin" .models/kokoro/voices-v1.0.bin
# Piper: the original two, plus the best-regarded English voices (high = least robotic, ~2x the size).
PIPER_VOICES="en/en_US/lessac/medium/en_US-lessac-medium ro/ro_RO/mihai/medium/ro_RO-mihai-medium
  en/en_US/lessac/high/en_US-lessac-high en/en_US/ryan/high/en_US-ryan-high en/en_US/ljspeech/high/en_US-ljspeech-high
  en/en_GB/cori/high/en_GB-cori-high en/en_US/amy/medium/en_US-amy-medium en/en_US/hfc_female/medium/en_US-hfc_female-medium
  en/en_US/hfc_male/medium/en_US-hfc_male-medium en/en_GB/alba/medium/en_GB-alba-medium
  en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium en/en_US/libritts_r/medium/en_US-libritts_r-medium"
[ "${PIPER_MINIMAL:-0}" = 1 ] && PIPER_VOICES="en/en_US/lessac/medium/en_US-lessac-medium ro/ro_RO/mihai/medium/ro_RO-mihai-medium"
for v in $PIPER_VOICES; do
  fetch "$P/$v.onnx" ".models/piper/$(basename $v).onnx"
  fetch "$P/$v.onnx.json" ".models/piper/$(basename $v).onnx.json"
done
echo "local TTS ready: $(du -sh .models | cut -f1) of models in .models/"
