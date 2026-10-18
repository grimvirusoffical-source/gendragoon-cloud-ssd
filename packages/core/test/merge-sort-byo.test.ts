import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  LAUNCH_BYO_PROVIDERS,
  LATER_BYO_PROVIDERS,
  MemorySettingsStore,
  actionsForMode,
  applySortOverride,
  assertNotInsideApp,
  assessLock,
  byoMayActivate,
  categorize,
  libraryDestination,
  libraryKey,
  performOwnershipProof,
  planChunks,
  planIncomingPath,
  planMerge,
  proofMatches,
  sourceDeletionAllowed,
  toServerByoRegistration,
  transferMetadata,
  treeNode,
  updateSortMapping,
  type WorkspaceRecord,
} from "../src/index.js";

describe("sorting", () => {
  it("reads the canonical JSON map and lets settings override it", async () => {
    expect(categorize({ name: "vacation.jpg", mime: "image/jpeg" })).toBe("Pictures");
    expect(categorize({ name: "clip.mp4" })).toBe("Videos");
    expect(categorize({ name: "song.flac" })).toBe("Audio");
    expect(categorize({ name: "notes.pdf" })).toBe("Documents");
    expect(categorize({ name: "bundle.zip" })).toBe("Archives");
    expect(categorize({ name: "Grok Bot.app", kind: "app" })).toBe("Apps");
    expect(categorize({ name: "mystery.bin" })).toBe("Other");

    const store = new MemorySettingsStore();
    const saved = updateSortMapping(await store.load(), ".mp4", "Other");
    await store.save(saved);
    const loaded = await store.load();
    expect(categorize({ name: "clip.mp4", mime: "video/mp4" }, loaded.sortOverrides)).toBe("Other");
    expect(applySortOverride(loaded.sortOverrides, { mime: "image/png", category: "Documents" }).mimeTypes?.["image/png"]).toBe("Documents");
  });
});

describe("merge", () => {
  it("renames only the incoming path and never overwrites", () => {
    const taken = new Set(["Photos/cat.jpg", "Photos/cat.jpg (from Personal)"]);
    expect(planIncomingPath("Photos/dog.jpg", "Personal", taken)).toBe("Photos/dog.jpg");
    expect(planIncomingPath("Photos/cat.jpg", "Personal", taken)).toBe("Photos/cat.jpg (from Personal) 2");
    const planned = planMerge(
      [{ path: "Photos/cat.jpg" }, { path: "Notes/todo.txt" }],
      "Personal",
      ["Photos/cat.jpg"],
    );
    expect(planned).toEqual([
      { sourcePath: "Photos/cat.jpg", targetPath: "Photos/cat.jpg (from Personal)" },
      { sourcePath: "Notes/todo.txt", targetPath: "Notes/todo.txt" },
    ]);
    expect(planned.some((entry) => entry.targetPath === "Photos/cat.jpg")).toBe(false);
  });

  it("deletes the source only after every copy verifies", () => {
    expect(sourceDeletionAllowed([])).toBe(false);
    expect(sourceDeletionAllowed([{ path: "a", copied: true, verified: false }])).toBe(false);
    expect(sourceDeletionAllowed([{ path: "a", copied: true, verified: true }])).toBe(true);
  });
});

describe("tree and transfer", () => {
  it("shares one tree and hides upload in backup mode and while locked", () => {
    const file = treeNode({ path: "Notes/todo.txt", directory: false, sizeBytes: 12, mime: "text/plain" });
    expect(actionsForMode("upload", file).primaryLabel).toBe("Upload");
    expect(actionsForMode("backup", file)).toMatchObject({ canUpload: false, primaryLabel: "Make secure backup" });
    expect(actionsForMode("upload", file, { uploadsBlocked: true })).toMatchObject({
      canUpload: false,
      canBackup: false,
      canDownload: true,
      primaryLabel: null,
    });
    expect(() => assertNotInsideApp("/Apps/Demo.app/Contents/Info.plist")).toThrow(/complete application/);
  });

  it("plans 8 MiB resumable chunks and requires a package for folders and apps", () => {
    const plan = planChunks(8 * 1024 * 1024 + 10);
    expect(plan.chunkBytes).toBe(8 * 1024 * 1024);
    expect(plan.totalChunks).toBe(2);
    expect(plan.chunks[1]?.length).toBe(10);
    expect(transferMetadata({ name: "note.txt", sizeBytes: 4 })).toEqual({
      kind: "file",
      originalName: "note.txt",
      logicalBytes: 4,
    });
    expect(() => transferMetadata({ name: "Folder", kind: "folder", sizeBytes: 10 })).toThrow(/verified package/);
    const manifest = "a".repeat(64);
    expect(transferMetadata({
      name: "Demo.app",
      kind: "app",
      sizeBytes: 20,
      logicalBytes: 40,
      archiveFormat: "gendragoon-package-v1",
      manifestSha256: manifest,
    }).archiveFormat).toBe("gendragoon-package-v1");
  });

  it("keeps the library destination checks from the Mac upload helper", async () => {
    expect(() => libraryDestination("BAD", "bucket", "remote")).toThrow(/project ID/);
    expect(() => libraryDestination("valid-project", "1.2.3.4", "remote")).toThrow(/bucket/);
    const destination = libraryDestination("valid-project", "gen-bucket", "gdrive", "GenDragoon-App-Library");
    const folder = `${destination.bucket}/${destination.prefix}`;
    const material = [destination.project, destination.bucket, destination.remote, folder, "Demo.app"].join("|");
    const expected = createHash("sha256").update(material).digest("hex").slice(0, 18);
    expect(await libraryKey(destination, "Demo.app")).toBe(expected);
  });
});

describe("BYO", () => {
  it("launches S3-compatible providers and SFTP only", () => {
    expect(LAUNCH_BYO_PROVIDERS.map((provider) => provider.id)).toEqual([
      "aws", "r2", "b2", "wasabi", "minio", "gcs-s3", "sftp",
    ]);
    expect(LATER_BYO_PROVIDERS).toEqual(["azure-blob", "webdav", "gcs-native"]);
    expect(LAUNCH_BYO_PROVIDERS.find((provider) => provider.id === "gcs-s3")?.label).toMatch(/S3-compatible HMAC/);
  });

  it("stores only type, endpoint, and fingerprint, and refuses credentials", async () => {
    await expect(toServerByoRegistration({
      provider: "r2",
      endpoint: "https://key:secret@example.r2.cloudflarestorage.com",
      bucket: "library",
    })).rejects.toThrow(/credentials/);

    const record = await toServerByoRegistration({
      provider: "minio",
      endpoint: "https://s3.example.com/storage",
      bucket: "library",
    });
    expect(Object.keys(record).sort()).toEqual(["bucketFingerprint", "endpoint", "provider"]);
    expect(JSON.stringify(record)).not.toMatch(/secret|password|token/i);
    expect(record.endpoint).toBe("https://s3.example.com/storage");
    expect(record.bucketFingerprint).toHaveLength(64);

    await expect(toServerByoRegistration({
      provider: "aws",
      endpoint: "https://s3.amazonaws.com",
      bucket: "library",
      credentials: { secretAccessKey: "super-secret" },
    })).rejects.toThrow(/credential field/);

    await expect(toServerByoRegistration({
      provider: "gcs-native",
      endpoint: "https://storage.googleapis.com",
      bucket: "library",
    })).rejects.toThrow(/not available/);
  });

  it("proves control by writing, reading, and deleting the challenge", async () => {
    const objects = new Map<string, string>();
    const probe = {
      async write(key: string, body: string) { objects.set(key, body); },
      async read(key: string) { return objects.get(key) ?? ""; },
      async remove(key: string) { objects.delete(key); },
    };
    const challenge = { objectKey: ".gendragoon-verify/1", nonce: "nonce-1" };
    const proof = await performOwnershipProof(probe, challenge);
    expect(proof.readBack).toBe("nonce-1");
    expect(proof.cleaned).toBe(true);
    expect(objects.size).toBe(0);
    expect(proofMatches(challenge, proof.readBack)).toBe(true);
    expect(byoMayActivate(false)).toBe(false);
    expect(byoMayActivate(true)).toBe(true);
  });

  it("does not let a BYO workspace skip the shared lock", () => {
    const byo: WorkspaceRecord = {
      id: "byo",
      name: "VPS",
      kind: "byo",
      projectStatus: "pending_payment",
      feeIsOneTime: false,
      storage: { kind: "byo", storageTier: null, provider: "sftp", endpoint: "sftp://example", bucketFingerprint: "ab" },
    };
    expect(assessLock([byo], Date.parse("2026-10-18T00:00:00Z")).locked).toBe(true);
  });
});
