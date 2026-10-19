import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ABOUT_OWNERSHIP, COPYRIGHT, PUBLISHER } from "../src/index.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => readFileSync(path.join(repo, p), "utf8");
const EXACT =
  "Gendragoon is developed and maintained by Red-XAI LLC. Red-XAI LLC is wholly owned by GRIM-VIRUS, an independent recording artist who leads development under the alias MainDirectory. © Red-XAI LLC. All rights reserved.";

describe("About / ownership copy", () => {
  it("is the exact approved wording", () => {
    expect(ABOUT_OWNERSHIP).toBe(EXACT);
    expect(COPYRIGHT).toBe("© Red-XAI LLC");
    expect(PUBLISHER).toBe("Red-XAI LLC");
  });
  it("the extension popup and options show the same copy", () => {
    expect(read("apps/extension/src/options.html")).toContain(EXACT);
    expect(read("apps/extension/src/popup.html")).toContain(EXACT);
  });
  it("package, Electron and iOS metadata carry the same owner", () => {
    for (const p of ["package.json", "apps/desktop/package.json", "apps/mobile/package.json", "apps/extension/package.json",
      "apps/red-xai-updater/package.json", "packages/core/package.json", "packages/ui/package.json", "packages/updater/package.json"]) {
      const author = (JSON.parse(read(p)) as { author: string | { name: string } }).author;
      expect(typeof author === "string" ? author : author.name, p).toBe(PUBLISHER);
    }
    expect(read("apps/desktop/electron-builder.cjs")).toContain(`copyright: "${COPYRIGHT}"`);
    const app = JSON.parse(read("apps/mobile/app.json")) as { expo: { ios: { infoPlist: Record<string, string> } } };
    expect(app.expo.ios.infoPlist.NSHumanReadableCopyright).toBe(COPYRIGHT);
    expect(read("apps/extension/scripts/manifests.mjs")).toContain(`author: "${PUBLISHER}"`);
  });
});
