const { signingFromEnv } = require("./nsis-signing.cjs");

const signing = signingFromEnv();
if (signing.certificateFile && !process.env.CSC_LINK) process.env.CSC_LINK = signing.certificateFile;
if (signing.certificatePassword && !process.env.CSC_KEY_PASSWORD) process.env.CSC_KEY_PASSWORD = signing.certificatePassword;

/** Mac is intentionally absent. The Mac product remains the SwiftUI app. */
module.exports = {
  appId: "com.gendragoon.cloudssd.windows",
  productName: "GenDragoon Cloud SSD",
  directories: { output: "release", buildResources: "build" },
  files: ["dist/**/*", "package.json", "build/icon.png"],
  asar: true,
  forceCodeSigning: signing.enabled && process.env.GENDRAGOON_NSIS_REQUIRE_SIGNATURE === "1",
  win: {
    icon: "build/icon.ico",
    target: [{ target: "nsis" }],
    // rcedit (embeds the icon) runs on Windows, or anywhere when a certificate is configured; Linux without Wine cannot run it.
    signAndEditExecutable: signing.enabled || process.platform === "win32",
    certificateFile: signing.certificateFile || undefined,
    certificatePassword: signing.certificatePassword || undefined,
  },
  linux: {
    icon: "build/icon.png",
    executableName: "gendragoon-cloud-ssd",
    artifactName: "GenDragoon-Cloud-SSD-${version}-linux-${arch}.${ext}",
    category: "Utility",
    maintainer: "GenDragoon <support@example.com>",
    target: [{ target: "AppImage" }, { target: "deb" }, { target: "tar.gz" }],
  },
  nsis: {
    installerIcon: "build/icon.ico",
    uninstallerIcon: "build/icon.ico",
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    artifactName: "GenDragoon-Cloud-SSD-Setup-${version}.${ext}",
  },
  publish: {
    provider: "github",
    owner: "grimvirusoffical-source",
    repo: "gendragoon-cloud-ssd",
  },
};
