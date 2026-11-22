#!/usr/bin/env bash
# Local TTS models (offline): Kokoro and Piper share .venv-tts; ZONOS3-Mini uses MLX in .venv-zonos3.
# Models and voices go under .models/, one folder per engine.
#   npm run setup:local-tts [kokoro] [piper] [piper/<voice id>…] [zonos3-mini]
# No argument: Kokoro and Piper. Settings → Install runs it for one engine, and picking a Piper voice that isn't
# downloaded runs it with piper/<voice id> (e.g. piper/en_US-ryan-high; the ids are server/ttsVoices.ts PIPER_CATALOG).
set -euo pipefail
source "$(dirname "$0")/ensure-uv.sh"
# SPEECH_DATA_DIR: where the env and .models/ go (the packaged app's Application Support folder); else the repo.
cd "${SPEECH_DATA_DIR:-$(dirname "$0")/..}"

ENGINES="${*:-kokoro piper}"
want() { [[ " $ENGINES " == *" $1 "* ]]; }

if want kokoro || want piper; then
  ensure_uv
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
if want zonos3-mini; then
  if [[ "$(uname -sm)" != "Darwin arm64" ]] || (( $(sw_vers -productVersion | cut -d. -f1) < 14 )); then
    echo "ZONOS3-Mini requires Apple silicon and macOS 14 or later." >&2
    exit 1
  fi
  ensure_uv
  echo "Setting up Python for ZONOS3-Mini"
  [ -x .venv-zonos3/bin/python ] || uv venv .venv-zonos3 --python 3.12
  uv pip install --python .venv-zonos3/bin/python --quiet mlx-audio==0.6.6 'soxr>=1,<2'
  echo "Downloading ZONOS3-Mini and preset voices"
  .venv-zonos3/bin/python -I - <<'PY'
from huggingface_hub import hf_hub_download, snapshot_download

repo = "mlx-community/ZONOS3-Mini"
revision = "c3b1320037be83fdbe57586bd6678573de1789f4"
directory = ".models/zonos3-mini"
snapshot_download(repo, revision=revision, local_dir=directory,
                  allow_patterns=["config.json", "model.safetensors", "tokenizer.json", "codec/*", "voices/*.npz"])
# Publish the index last so interrupted installs never offer a partial set of presets.
hf_hub_download(repo, "voices.json", revision=revision, local_dir=directory)
PY
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
