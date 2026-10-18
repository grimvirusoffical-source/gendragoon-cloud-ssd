import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mergeSealedManifest, type ManifestMergeDocument, type ManifestMergeFile } from "../src/manifest-cas.js";

interface MergeVector {
  local: ManifestMergeDocument<ManifestMergeFile>;
  remote: ManifestMergeDocument<ManifestMergeFile>;
  lastSyncedVersion: number;
  nowMs: number;
  expected: ManifestMergeDocument<ManifestMergeFile>;
}

const directory = new URL("./vectors/manifest-merge/", import.meta.url);
const names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();

describe("manifest merge vectors", () => {
  it("covers the six cross-platform cases", () => {
    expect(names).toEqual([
      "clock-skew.json",
      "concurrent-delete-vs-edit.json",
      "delete-readd-same-path.json",
      "empty-remote-higher-version.json",
      "stale-device-pruned-through.json",
      "tombstone-pruning.json",
    ]);
  });

  for (const name of names) {
    it(name, () => {
      const vector = JSON.parse(readFileSync(new URL(name, directory), "utf8")) as MergeVector;
      expect(mergeSealedManifest(vector)).toEqual(vector.expected);
    });
  }
});
