#!/usr/bin/env bash
# Makes build/icon.icns (16–1024 px) and web/public/favicon.png from build/vizzo.icon (the Icon Composer document).
# macOS 26+ shows the .icon itself (electron-builder compiles it into Assets.car); the .icns is for macOS 13–15, Finder
# and the DMG. actool renders the small sizes the way macOS lays them out, but stops at 256 px; the larger ones are
# Icon Composer's render, placed on the same grid (scripts/icon-compose.swift). Needs Xcode 26+.
#   npm run icon
set -euo pipefail
cd "$(dirname "$0")/.."

src=build/vizzo.icon
ictool="$(xcode-select -p)/../Applications/Icon Composer.app/Contents/Executables/ictool"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cp -R "$src" "$tmp/Icon.icon"
mkdir "$tmp/actool"
xcrun actool "$tmp/Icon.icon" --compile "$tmp/actool" --output-partial-info-plist "$tmp/actool/info.plist" --app-icon Icon \
  --include-all-app-icons --development-region en --target-device mac --minimum-deployment-target 13.0 --platform macosx >/dev/null
iconutil -c iconset "$tmp/actool/Icon.icns" -o "$tmp/small.iconset"

"$ictool" "$src" --export-image --output-file "$tmp/full.png" --platform macOS --rendition Default --width 1024 --height 1024 --scale 1 >/dev/null
swiftc -O scripts/icon-compose.swift -o "$tmp/compose"

set_=$tmp/icon.iconset
mkdir "$set_"
cp "$tmp/small.iconset/icon_16x16.png" "$set_/icon_16x16.png"
cp "$tmp/small.iconset/icon_16x16@2x.png" "$set_/icon_16x16@2x.png"
cp "$tmp/small.iconset/icon_16x16@2x.png" "$set_/icon_32x32.png"
"$tmp/compose" "$tmp/full.png" "$set_/icon_32x32@2x.png" 64
cp "$tmp/small.iconset/icon_128x128.png" "$set_/icon_128x128.png"
cp "$tmp/small.iconset/icon_128x128@2x.png" "$set_/icon_128x128@2x.png"
cp "$tmp/small.iconset/icon_128x128@2x.png" "$set_/icon_256x256.png"
"$tmp/compose" "$tmp/full.png" "$set_/icon_256x256@2x.png" 512
"$tmp/compose" "$tmp/full.png" "$set_/icon_512x512.png" 512
"$tmp/compose" "$tmp/full.png" "$set_/icon_512x512@2x.png" 1024
iconutil -c icns "$set_" -o build/icon.icns

# The favicon: the full-bleed render (no margin), small.
sips -z 64 64 "$tmp/full.png" --out web/public/favicon.png >/dev/null
echo "✓ build/icon.icns, web/public/favicon.png"
