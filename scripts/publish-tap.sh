#!/usr/bin/env bash
# Publishes a built DMG: uploads release/Vizzo-<v>-arm64.dmg to github.com/heyvizzo/vizzo
# as GitHub release v<v>, then writes the version and SHA-256 into the tap (heyvizzo/homebrew-app) Casks/vizzo.rb and pushes.
#   npm run release -- minor && bash scripts/publish-tap.sh        the version package.json now says
#   bash scripts/publish-tap.sh 0.2.0                              that version's DMG
# Needs gh (logged in to heyvizzo) and a clone of the tap at $TAP_DIR (default ../homebrew-app).
set -euo pipefail
cd "$(dirname "$0")/.."

v=${1:-$(node -p 'require("./package.json").version')}
dmg="release/Vizzo-$v-arm64.dmg"
tap=${TAP_DIR:-../homebrew-app}
cask="$tap/Casks/vizzo.rb"
[ -f "$dmg" ] || { echo "no $dmg: run npm run release first" >&2; exit 1; }
[ -f "$cask" ] || { echo "no tap clone at $tap (git clone git@github.com:heyvizzo/homebrew-app.git)" >&2; exit 1; }

sha=$(shasum -a 256 "$dmg" | cut -d' ' -f1)
echo "▸ release v$v"
if gh release view "v$v" --repo heyvizzo/vizzo >/dev/null 2>&1; then
  gh release upload "v$v" "$dmg" --repo heyvizzo/vizzo --clobber
else
  gh release create "v$v" "$dmg" --repo heyvizzo/vizzo --title "Vizzo $v" \
    --notes "Vizzo $v for Apple silicon, macOS 13+. Install with \`brew install heyvizzo/app/vizzo\`."
fi

echo "▸ cask $v $sha"
git -C "$tap" pull -q
sed -i '' -e "s/^  version \".*\"/  version \"$v\"/" -e "s/^  sha256 \".*\"/  sha256 \"$sha\"/" "$cask"
brew style "$tap" >/dev/null
git -C "$tap" commit -qam "Vizzo $v" && git -C "$tap" push -q
echo "✓ brew upgrade vizzo  (or: brew install heyvizzo/app/vizzo)"
