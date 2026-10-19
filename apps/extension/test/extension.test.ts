import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BROWSERS, DEFAULT_API_BASE, FIREFOX_ID, manifestFor } from "../scripts/manifests.mjs";
import { sortCategoryFor } from "../src/sorter";
import { probeService } from "../src/status";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const browser of BROWSERS as string[]) describe(`${browser} manifest`, () => {
  const m = manifestFor(browser, "0.1.0");
  it("is a valid MV3 manifest with required store fields", () => {
    expect(m.manifest_version).toBe(3);
    const messages = JSON.parse(readFileSync(path.join(root, "src/_locales/en/messages.json"), "utf8")) as Record<string, { message: string }>;
    expect(m.name).toBe("__MSG_extName__");
    expect(m.default_locale).toBe("en");
    expect(messages.extName!.message.length).toBeLessThanOrEqual(45);
    expect(messages.extShortName!.message.length).toBeLessThanOrEqual(12);
    expect(messages.extDescription!.message.length).toBeLessThanOrEqual(132);
    expect(m.options_ui).toEqual({ page: "options.html", open_in_tab: true });
    expect(existsSync(path.join(root, "src/options.html"))).toBe(true);
    expect(m.version).toMatch(/^\d+(\.\d+){0,3}$/);
    for (const size of ["16", "32", "48", "96", "128"]) expect(m.icons[size]).toBeTruthy();
    for (const [size, file] of Object.entries(m.icons as Record<string, string>)) {
      const png = readFileSync(path.join(root, file));
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      expect(png.readUInt32BE(16)).toBe(Number(size)); // real, full-resolution render at exactly this size
      expect(png.readUInt32BE(20)).toBe(Number(size));
    }
    expect(existsSync(path.join(root, "src/popup.html"))).toBe(true);
  });
  it("asks for no API permissions and only the one service host", () => {
    expect(m.permissions).toEqual([]);
    expect(m.host_permissions).toEqual([`${DEFAULT_API_BASE}/*`]);
    expect(m).not.toHaveProperty("content_scripts");
    expect(m).not.toHaveProperty("web_accessible_resources");
    expect(JSON.stringify(m)).not.toMatch(/<all_urls>|\*:\/\/\*\/\*|unsafe-eval/);
  });
  it("uses the background form the browser supports", () => {
    if (browser === "firefox") {
      expect(m.background).toEqual({ scripts: ["background.js"] });
      expect(m.browser_specific_settings.gecko.id).toBe(FIREFOX_ID);
      expect(m.browser_specific_settings.gecko.data_collection_permissions).toEqual({ required: ["none"] });
    } else {
      expect(m.background).toEqual({ service_worker: "background.js" });
      expect(m).not.toHaveProperty("browser_specific_settings");
    }
  });
});

describe("sorter", () => {
  it("uses the shared sort-map", () => {
    expect(sortCategoryFor("holiday.MP4")).toBe("Videos");
    expect(sortCategoryFor("notes.pdf")).toBe("Documents");
    expect(sortCategoryFor("Game.app")).toBe("Apps");
    expect(sortCategoryFor("weird.xyz")).toBe("Other");
    expect(sortCategoryFor("   ")).toBeNull();
  });
});

describe("service probe", () => {
  const json = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it("online, offline, not-ready and unreachable", async () => {
    expect((await probeService("https://x.test/", json(200, { ok: true }))).state).toBe("online");
    expect(await probeService("https://x.test", json(503, {}))).toEqual({ state: "offline", reason: "Service answered 503" });
    expect(await probeService("https://x.test", json(200, { ok: false }))).toEqual({ state: "offline", reason: "Service is not ready" });
    expect(await probeService("https://x.test", (async () => { throw new TypeError("net"); }) as unknown as typeof fetch)).toEqual({ state: "offline", reason: "Can't reach the service" });
  });
  it("sends no credentials", async () => {
    let seen: RequestInit | undefined;
    await probeService("https://x.test", (async (_u: unknown, init?: RequestInit) => { seen = init; return new Response("{\"ok\":true}"); }) as unknown as typeof fetch);
    expect(seen?.credentials).toBe("omit");
    expect(seen?.headers).toBeUndefined();
  });
  it("times out", async () => {
    const hang = ((_u: unknown, init?: RequestInit) => new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("a"), { name: "AbortError" }))))) as unknown as typeof fetch;
    expect(await probeService("https://x.test", hang, 20)).toEqual({ state: "offline", reason: "Timed out" });
  });
});

describe.each(["popup.html", "options.html"])("%s", (file) => {
  const html = readFileSync(path.join(root, "src", file), "utf8");
  it("has no inline script (MV3 CSP) and no remote resources", () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/https?:\/\//);
  });
});
