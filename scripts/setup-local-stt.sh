#!/usr/bin/env bash
# Local STT models (offline): Parakeet TDT 0.6B v3 (MLX), Moonshine medium (English) and WhisperKit large-v3 turbo.
# Creates .venv-stt (Python 3.12 via uv), installs whisperkit-cli (Homebrew), and downloads the models into
# .models/{parakeet,moonshine,whisperkit}. Apple SpeechTranscriber needs nothing: macOS installs its model on first use.
# Rumble 2 Flash uses its own PyTorch environment. Install it explicitly with
# npm run setup:local-stt -- rumble-2-flash, or from Settings.
# Idempotent. With no arguments, installs Parakeet, Moonshine and WhisperKit.
set -euo pipefail
source "$(dirname "$0")/ensure-uv.sh"
# SPEECH_DATA_DIR: where the env and .models/ go (the packaged app's Application Support folder); else the repo.
cd "${SPEECH_DATA_DIR:-$(dirname "$0")/..}"

ENGINES="${*:-parakeet moonshine whisperkit}"
want() { [[ " $ENGINES " == *" $1 "* ]]; }

if want parakeet || want moonshine; then
  ensure_uv
  echo "Setting up Python"
  [ -x .venv-stt/bin/python ] || uv venv .venv-stt --python 3.12
  PKGS="numpy scipy"
  want parakeet && PKGS="$PKGS parakeet-mlx>=0.5"
  want moonshine && PKGS="$PKGS moonshine-voice>=0.1.5"
  # shellcheck disable=SC2086
  uv pip install --python .venv-stt/bin/python --quiet $PKGS
fi

if want parakeet; then
  echo "Downloading Parakeet TDT 0.6B v3"
  .venv-stt/bin/python -I -c "
from parakeet_mlx import from_pretrained
from_pretrained('mlx-community/parakeet-tdt-0.6b-v3', cache_dir='.models/parakeet')
"
fi
if want moonshine; then
  echo "Downloading Moonshine medium"
  .venv-stt/bin/python -I -c "
from pathlib import Path
from moonshine_voice.download import download_model_from_info, find_model_info
download_model_from_info(find_model_info('en'), cache_root=Path('.models/moonshine'), include_word_timestamps=True)
"
fi

if want rumble-2-flash; then
  if [[ "$(uname -s)" == "Darwin" ]] && { [[ "$(uname -m)" != "arm64" ]] || (( $(sw_vers -productVersion | cut -d. -f1) < 14 )); }; then
    echo "Rumble 2 Flash requires Apple silicon and macOS 14 or later." >&2
    exit 1
  fi
  ensure_uv
  echo "Setting up Python for Rumble 2 Flash"
  [ -x .venv-rumble/bin/python ] || uv venv .venv-rumble --python 3.12
  uv pip install --python .venv-rumble/bin/python --quiet numpy scipy 'torch>=2.9,<3' 'transformers>=5.23,<6'
  echo "Downloading Rumble 2 Flash"
  .venv-rumble/bin/python -I - <<'PY'
from huggingface_hub import snapshot_download

snapshot_download(
    "Reson8/Rumble-2-Flash",
    revision="a0c34287229103b706c670d70791683e34379732",
    local_dir=".models/rumble-2-flash",
    allow_patterns=["*.json", "chat_template.jinja", "merges.txt", "model.safetensors"],
    ignore_patterns=["ctc/*"],
)
PY
fi

if want whisperkit; then
  if ! command -v whisperkit-cli >/dev/null && [ ! -x /opt/homebrew/bin/whisperkit-cli ]; then
    command -v brew >/dev/null || { echo "Homebrew is required for WhisperKit (brew install whisperkit-cli)"; exit 1; }
    echo "Installing whisperkit-cli with Homebrew"
    brew install whisperkit-cli
  fi
  WK=.models/whisperkit/models/argmaxinc/whisperkit-coreml/openai_whisper-large-v3-v20240930_turbo
  if [ ! -d "$WK" ]; then
    # Downloads the model, then compiles it for the Neural Engine (a few minutes; Settings says so once the files are in).
    echo "Downloading WhisperKit large-v3 turbo"
    CLIP="$(mktemp -d)/clip.wav"
    say -o "$CLIP" --data-format=LEI16@16000 "Ready."
    PATH="/opt/homebrew/bin:$PATH" whisperkit-cli transcribe --model large-v3-v20240930_turbo \
      --download-model-path .models/whisperkit --download-tokenizer-path .models/whisperkit --audio-path "$CLIP" >/dev/null 2>&1 || true
    [ -d "$WK" ] || { echo "WhisperKit model download failed"; exit 1; }
  fi
fi
echo "local STT ready: $(du -sh .models/parakeet .models/moonshine .models/whisperkit .models/rumble-2-flash 2>/dev/null | awk '{print $2": "$1}' | tr '\n' ' ')"
