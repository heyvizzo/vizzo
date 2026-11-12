#!/usr/bin/env bash
# Sourced by the speech setup scripts. Only Settings' explicit confirmation authorizes installation.
ensure_uv() {
  command -v uv >/dev/null && return 0
  if [ "${VIZZO_INSTALL_UV:-0}" != "1" ]; then
    echo "uv is required (https://docs.astral.sh/uv/)" >&2
    return 1
  fi
  echo "Installing uv"
  # Keep shell profiles untouched; the app already searches ~/.local/bin.
  if ! curl -fsSL --retry 3 https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="$HOME/.local/bin" UV_NO_MODIFY_PATH=1 sh; then
    echo "Could not install uv. Check your internet connection and try again." >&2
    return 1
  fi
  export PATH="$HOME/.local/bin:$PATH"
  hash -r
  command -v uv >/dev/null || { echo "uv installation finished but uv could not be found." >&2; return 1; }
}
