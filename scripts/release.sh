#!/usr/bin/env bash
# Builds a new DMG with the next version number: bumps package.json's version, typechecks and tests, builds
# (npm run dist), checks the result, and prints the DMG's path and SHA-256 (what a Homebrew cask needs).
#   npm run release                 0.1.0 → 0.1.1
#   npm run release -- minor        0.1.0 → 0.2.0
#   npm run release -- major        0.1.0 → 1.0.0
#   npm run release -- 0.3.2        that exact version
#   npm run release -- --skip-tests patch
# A failed step puts the old version back. Nothing is committed or tagged.
set -euo pipefail
cd "$(dirname "$0")/.."

bump="patch"
tests=1
for arg in "$@"; do
  case "$arg" in
    --skip-tests) tests=0 ;;
    patch|minor|major) bump="$arg" ;;
    [0-9]*.[0-9]*.[0-9]*) bump="$arg" ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg (patch, minor, major, x.y.z or --skip-tests)" >&2; exit 2 ;;
  esac
done

old=$(node -p 'require("./package.json").version')
# Restore package.json and package-lock.json's version if anything below fails.
restore() {
  echo "✗ release failed: version back to $old" >&2
  npm version "$old" --no-git-tag-version --allow-same-version >/dev/null
}
trap restore ERR

new=$(npm version "$bump" --no-git-tag-version | tr -d 'v')
echo "▸ version $old → $new"

if [ "$tests" = 1 ]; then
  echo "▸ typecheck"
  npx tsc --noEmit
  echo "▸ tests"
  npx vitest run --silent >/tmp/release-tests.log 2>&1 || { tail -40 /tmp/release-tests.log >&2; false; }
  grep -E "Test Files|Tests " /tmp/release-tests.log | sed 's/^/  /'
fi

echo "▸ build"
npm run dist 2>&1 | grep -E "built in|dist-native/|signing|building|⨯|[Ee]rror" | sed 's/^/  /'
[ "${PIPESTATUS[0]}" = 0 ]

dmg="release/Vizzo-$new-arm64.dmg"
app="release/mac-arm64/Vizzo.app"
echo "▸ check"
[ -f "$dmg" ] || { echo "no $dmg" >&2; false; }
codesign --verify --deep --strict "$app"
[ "$(plutil -extract CFBundleShortVersionString raw "$app/Contents/Info.plist")" = "$new" ] || { echo "the app says another version" >&2; false; }
# The on-device models download on demand: none may ship in the app.
models=$(find "$app" \( -name "*.onnx" -o -name "*.mlmodelc" -o -name ".venv-*" -o -path "*/.models/*" \) | head -1)
[ -z "$models" ] || { echo "a model file is in the app: $models" >&2; false; }
trap - ERR

echo
echo "✓ Vizzo $new"
echo "  $dmg ($(du -h "$dmg" | cut -f1 | tr -d ' '))"
echo "  sha256 $(shasum -a 256 "$dmg" | cut -d' ' -f1)"
