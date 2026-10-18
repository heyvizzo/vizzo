#!/usr/bin/env bash
# Compiles the on-device speech helpers (tools/mactts, tools/macstt) into dist-native/<name>-<source hash>, the name
# server/adapters/macTts.ts buildSwiftHelper looks for, so the packaged app doesn't need swiftc. `npm run dist` runs it.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist-native
mkdir -p dist-native
for name in mactts macstt; do
  src="tools/$name/main.swift"
  hash=$(shasum -a 1 "$src" | cut -c1-10)
  swiftc -O -o "dist-native/$name-$hash" "$src"
  echo "  dist-native/$name-$hash"
done
