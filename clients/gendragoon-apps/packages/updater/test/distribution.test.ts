import { describe, expect, it } from "vitest";
import { detectDistribution, updatePolicy } from "../src/index.js";

describe("detectDistribution", () => {
  it("defaults to the direct (GitHub) build", () => {
    expect(detectDistribution({ packaged: true })).toBe("direct");
    expect(detectDistribution()).toBe("direct");
  });
  it("Mac App Store: process.mas or the build flag, and nothing can override it", () => {
    expect(detectDistribution({ mas: true, packaged: true })).toBe("mas");
    expect(detectDistribution({ buildFlag: "mas", packaged: true, env: { GENDRAGOON_DISTRIBUTION: "direct", ROTTEN_APPLE_LAUNCHER: "0" } })).toBe("mas");
    expect(detectDistribution({ mas: true, env: { GENDRAGOON_DISTRIBUTION: "direct" } })).toBe("mas");
  });
  it("Rotten Apple: build flag or the launcher marker", () => {
    expect(detectDistribution({ buildFlag: "rotten-apple", packaged: true })).toBe("rotten-apple");
    expect(detectDistribution({ packaged: true, env: { ROTTEN_APPLE_LAUNCHER: "1" } })).toBe("rotten-apple");
  });
  it("env override works only for unpackaged runs", () => {
    expect(detectDistribution({ packaged: false, env: { GENDRAGOON_DISTRIBUTION: "mas" } })).toBe("mas");
    expect(detectDistribution({ packaged: true, env: { GENDRAGOON_DISTRIBUTION: "mas" } })).toBe("direct");
  });
  it("ignores unknown values", () => {
    expect(detectDistribution({ buildFlag: "weird", packaged: true, env: { GENDRAGOON_DISTRIBUTION: "nope" } })).toBe("direct");
  });
});

describe("updatePolicy", () => {
  it("direct self-updates with the full UI", () => {
    expect(updatePolicy("direct")).toMatchObject({ selfUpdate: true, ui: "full" });
  });
  it("Rotten Apple leaves updating to the launcher and shows a note only", () => {
    const p = updatePolicy("rotten-apple");
    expect(p.selfUpdate).toBe(false);
    expect(p.ui).toBe("managed");
    expect(p.note).toMatch(/launcher/i);
  });
  it("Mac App Store never self-updates and hides the UI", () => {
    expect(updatePolicy("mas")).toEqual({ distribution: "mas", selfUpdate: false, ui: "hidden" });
  });
});
