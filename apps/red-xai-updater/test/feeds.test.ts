import { describe, expect, it } from "vitest";
import { DEFAULT_MAC_ASSET, RED_XAI_FEEDS } from "../src/feeds.js";

describe("Red-XAI feeds", () => {
  it("reads the existing public cloud-ssd releases feed", () => {
    const feed = RED_XAI_FEEDS[0];
    expect(feed?.repo).toBe("grimvirusoffical-source/gendragoon-cloud-ssd");
    expect(feed?.channel).toBe("stable");
    const pattern = new RegExp(feed?.assetPattern ?? "$^");
    expect(pattern.test(DEFAULT_MAC_ASSET)).toBe(true);
    expect(pattern.test("sha256.txt")).toBe(false);
    expect(pattern.test("install-macos.py")).toBe(false);
  });
});
