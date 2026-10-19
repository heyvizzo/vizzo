// electron-builder's afterPack hook (package.json build.afterPack), before signing. With mac.icon a .icon file, it
// makes the app's icon.icns from it with actool, which stops at 256 px: put back build/icon.icns, which has every size
// up to 1024 (scripts/build-icon.sh), for macOS 13–15 and Finder. macOS 26+ shows Assets.car (the .icon) either way.
const { copyFileSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async (context) => {
  if (context.electronPlatformName !== "darwin") return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  copyFileSync(join(context.packager.projectDir, "build", "icon.icns"), join(app, "Contents", "Resources", "icon.icns"));
};
