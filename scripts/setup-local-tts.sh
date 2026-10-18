#!/usr/bin/env bash
# Local TTS models (offline): Kokoro-82M (ONNX) and Piper (en_US lessac + ro_RO mihai voices; more on demand).
# Creates .venv-tts (Python 3.12 via uv) and downloads models into .models/{kokoro,piper}. Idempotent.
#   npm run setup:local-tts [kokoro] [piper] [piper/<voice id>…]
# No argument: Kokoro and Piper. Settings → Install runs it for one engine, and picking a Piper voice that isn't
# downloaded runs it with piper/<voice id> (e.g. piper/en_US-ryan-high; the ids are server/ttsVoices.ts PIPER_CATALOG).
set -euo pipefail
# SPEECH_DATA_DIR: where the env and .models/ go (the packaged app's Application Support folder); else the repo.
cd "${SPEECH_DATA_DIR:-$(dirname "$0")/..}"
command -v uv >/dev/null || { echo "uv is required (https://docs.astral.sh/uv/)"; exit 1; }

ENGINES="${*:-kokoro piper}"
want() { [[ " $ENGINES " == *" $1 "* ]]; }

if want kokoro || want piper; then
  echo "Setting up Python"
  [ -x .venv-tts/bin/python ] || uv venv .venv-tts --python 3.12
  PKGS="onnxruntime numpy"
  want kokoro && PKGS="$PKGS kokoro-onnx>=0.4"
  want piper && PKGS="$PKGS piper-tts>=1.3"
  # shellcheck disable=SC2086
  uv pip install --python .venv-tts/bin/python --quiet $PKGS
fi

fetch() { # url dest
  if [ -s "$2" ]; then echo "  have $(basename "$2")"; return; fi
  mkdir -p "$(dirname "$2")"
  echo "Downloading $(basename "$2")"
  curl -fsSL --retry 3 -C - -o "$2.part" "$1" && mv "$2.part" "$2" # -C -: resume a cut-off download
}
K=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
P=https://huggingface.co/rhasspy/piper-voices/resolve/main
if want kokoro; then
  fetch "$K/kokoro-v1.0.onnx" .models/kokoro/kokoro-v1.0.onnx
  fetch "$K/voices-v1.0.bin" .models/kokoro/voices-v1.0.bin
fi
# Piper: English (lessac medium) and its only Romanian voice; any other voice by its id (lang_REGION-name-quality),
# which maps onto the voices repo's folders: en_US-ryan-high → en/en_US/ryan/high/en_US-ryan-high.
VOICES=""
want piper && VOICES="en_US-lessac-medium ro_RO-mihai-medium"
for a in $ENGINES; do
  case "$a" in piper/*) VOICES="$VOICES ${a#piper/}" ;; esac
done
for id in $VOICES; do
  [[ "$id" =~ ^[a-z]{2,3}_[A-Z]{2}-[a-z0-9_]+-(x_low|low|medium|high)$ ]] || { echo "not a Piper voice id: $id"; exit 1; }
  locale=${id%%-*}; rest=${id#*-}; name=${rest%-*}; quality=${rest##*-}
  v="${locale%%_*}/$locale/$name/$quality/$id"
  # The .json first: a voice counts as there once its .onnx is (server/ttsVoices.ts lists the .onnx.json with one).
  fetch "$P/$v.onnx.json" ".models/piper/$id.onnx.json"
  fetch "$P/$v.onnx" ".models/piper/$id.onnx"
done
echo "local TTS ready: $(du -sh .models 2>/dev/null | cut -f1) of models in .models/"
