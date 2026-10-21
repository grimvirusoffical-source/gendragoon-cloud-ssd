import { app, Menu, Tray } from "electron";
import { chooseRelease, fetchReleaseManifests, runUpdate } from "@gendragoon/updater";
import { RED_XAI_FEEDS } from "./feeds.js";

/**
 * Red-XAI Updater is the Mac menu-bar companion. It does not ship inside the
 * Windows NSIS installer. Tokens, if a feed is ever private, come from the
 * OS keychain through readToken and are never logged.
 */
async function checkAll(): Promise<string[]> {
  const lines: string[] = [];
  for (const feed of RED_XAI_FEEDS) {
    const manifests = await fetchReleaseManifests({
      repo: feed.repo,
      assetPattern: feed.assetPattern,
    });
    const chosen = chooseRelease(manifests, feed.channel);
    lines.push(chosen ? `${feed.id}: ${chosen.version}` : `${feed.id}: no ${feed.channel} release`);
  }
  return lines;
}

void app.whenReady().then(async () => {
  const tray = new Tray(await emptyIcon());
  const lines = await checkAll().catch(() => ["Feed check failed"]);
  tray.setToolTip("Red-XAI Updater");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: lines.join(" · "), enabled: false },
    {
      label: "Check again",
      click: () => {
        void checkAll();
      },
    },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
});

app.on("window-all-closed", () => {
  // The menu-bar app stays running without a window.
});

async function emptyIcon() {
  const { nativeImage } = await import("electron");
  return nativeImage.createFromBuffer(Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAYAAAAfSC3RAAAAHElEQVQokWNgGAVDBQyNjY2BgYGBQf8H/jMwMDAwAABQ1wH8m8m0nQAAAABJRU5ErkJggg==",
    "base64",
  ));
}

export { runUpdate };
