import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { mergeSealedManifest, type ManifestMergeDocument, type ManifestMergeFile } from "@gendragoon/core";

interface MergeVector {
  local: ManifestMergeDocument<ManifestMergeFile>;
  remote: ManifestMergeDocument<ManifestMergeFile>;
  lastSyncedVersion: number;
  nowMs: number;
  expected: ManifestMergeDocument<ManifestMergeFile>;
}

const directory = path.resolve(__dirname, "../../../packages/core/test/vectors/manifest-merge");
const names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();

/**
 * The app merges through `mergeSealedManifest`, the same function `commitManifest` calls.
 * These six files are the shared contract in `packages/core/test/vectors/manifest-merge/`.
 * They pass on core `091d892` and do not cover the bugs in Casey's report
 * `runs/core-091d892-probe.md`, so `ENCRYPTED_WORKSPACE_ENABLED` stays off.
 */
describe("manifest merge vectors used by the app", () => {
  it("loads all six shared files", () => {
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
      const vector = JSON.parse(readFileSync(path.join(directory, name), "utf8")) as MergeVector;
      expect(mergeSealedManifest(vector)).toEqual(vector.expected);
    });
  }
});
