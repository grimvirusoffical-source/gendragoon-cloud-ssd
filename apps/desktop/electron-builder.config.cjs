const signing = Boolean(process.env.CSC_LINK || process.env.WIN_CSC_LINK);

/** Mac is intentionally absent. The Mac product remains the SwiftUI app. */
module.exports = {
  appId: "com.gendragoon.cloudssd.windows",
  productName: "GenDragoon Cloud SSD",
  directories: { output: "release" },
  files: ["dist/**/*", "package.json"],
  asar: true,
  forceCodeSigning: false,
  win: {
    target: [{ target: "nsis" }],
    signAndEditExecutable: signing,
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
    repo: "gendragoon-apps",
  },
};
