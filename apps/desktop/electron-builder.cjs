const { signingFromEnv } = require("./nsis-signing.cjs");

const signing = signingFromEnv();
if (signing.certificateFile && !process.env.CSC_LINK) process.env.CSC_LINK = signing.certificateFile;
if (signing.certificatePassword && !process.env.CSC_KEY_PASSWORD) process.env.CSC_KEY_PASSWORD = signing.certificatePassword;

/** Mac is intentionally absent. The Mac product remains the SwiftUI app. */
module.exports = {
  appId: "com.gendragoon.cloudssd.windows",
  productName: "GenDragoon Cloud SSD",
  directories: { output: "release" },
  files: ["dist/**/*", "package.json"],
  asar: true,
  forceCodeSigning: signing.enabled && process.env.GENDRAGOON_NSIS_REQUIRE_SIGNATURE === "1",
  win: {
    target: [{ target: "nsis" }],
    signAndEditExecutable: signing.enabled,
    certificateFile: signing.certificateFile || undefined,
    certificatePassword: signing.certificatePassword || undefined,
  },
  nsis: {
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
