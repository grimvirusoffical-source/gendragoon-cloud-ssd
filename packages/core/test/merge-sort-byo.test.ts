import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  LAUNCH_BYO_PROVIDERS,
  LATER_BYO_PROVIDERS,
  MemorySettingsStore,
  accountFromAssessment,
  actionsForMode,
  applySortOverride,
  assertNoCredentialFields,
  assertNotInsideApp,
  byoMayActivate,
  categorize,
  challengeObjectKey,
  libraryDestination,
  libraryKey,
  performOwnershipChallenge,
  planChunks,
  planIncomingPath,
  planMerge,
  registrationRequiresChallenge,
  sourceDeletionAllowed,
  toServerByoRegistration,
  transferMetadata,
  treeNode,
  updateSortMapping,
} from "../src/index.js";

describe("sorting", () => {
  it("reads the canonical JSON map and lets settings override it", async () => {
    expect(categorize({ name: "vacation.jpg", mime: "image/jpeg" })).toBe("Pictures");
    expect(categorize({ name: "clip.mp4" })).toBe("Videos");
    expect(categorize({ name: "phone.3gp" })).toBe("Videos");
    expect(categorize({ name: "phone.3gp", mime: "video/3gpp" })).toBe("Videos");
    expect(categorize({ name: "clip.bin", mime: "video/3gpp" })).toBe("Videos");
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
  it("launches S3-compatible providers only", () => {
    expect(LAUNCH_BYO_PROVIDERS.map((provider) => provider.id)).toEqual([
      "aws", "r2", "b2", "wasabi", "minio", "gcs-s3",
    ]);
    expect(LATER_BYO_PROVIDERS).toEqual(["sftp", "azure-blob", "webdav", "gcs-native"]);
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
      provider: "sftp",
      endpoint: "sftp://example",
      bucket: "library",
    })).rejects.toThrow(/not available/);
    await expect(toServerByoRegistration({
      provider: "gcs-native",
      endpoint: "https://storage.googleapis.com",
      bucket: "library",
    })).rejects.toThrow(/not available/);
  });

  it("writes the challenge object and sends only a device-generated presigned GET", async () => {
    const now = Date.parse("2026-10-18T00:00:00.000Z");
    const objects = new Map<string, string>();
    const writer = {
      async write(key: string, body: string) { objects.set(key, body); },
      async presignGet(key: string) {
        return `https://s3.example.com/library/${key}?X-Amz-Date=20261018T000000Z&X-Amz-Expires=300&X-Amz-Signature=device`;
      },
    };
    const first = await performOwnershipChallenge({
      challengeId: "c1",
      nonce: "nonce-1",
      writer,
      now,
    });
    const second = await performOwnershipChallenge({
      challengeId: "c2",
      nonce: "nonce-2",
      writer,
      now,
    });
    expect(registrationRequiresChallenge()).toBe(true);
    expect(challengeObjectKey("nonce-1")).toBe(".gendragoon-challenge/nonce-1");
    expect(objects.get(".gendragoon-challenge/nonce-1")).toBe("nonce-1");
    expect(objects.get(".gendragoon-challenge/nonce-2")).toBe("nonce-2");
    expect(first).toEqual({
      challengeId: "c1",
      presignedGetUrl: "https://s3.example.com/library/.gendragoon-challenge/nonce-1?X-Amz-Date=20261018T000000Z&X-Amz-Expires=300&X-Amz-Signature=device",
    });
    expect(second.presignedGetUrl).toContain(".gendragoon-challenge/nonce-2");
    expect(JSON.stringify(first)).not.toMatch(/secret|password|token/i);
    assertNoCredentialFields(first);
    expect(byoMayActivate(false)).toBe(false);
    expect(byoMayActivate(true)).toBe(true);
    await expect(performOwnershipChallenge({
      challengeId: "c3",
      nonce: "nonce-3",
      now,
      writer: {
        async write() { /* stored secret stays on the device */ },
        async presignGet(key: string) {
          return `https://key:secret@s3.example.com/${key}?X-Amz-Date=20261018T000000Z&X-Amz-Expires=300`;
        },
      },
    })).rejects.toThrow(/credentials/);
  });

  it("does not let a BYO workspace skip a server lock", () => {
    expect(accountFromAssessment({ locked: true, overCap: false, unpaidIds: ["byo"] })).toEqual({
      phase: "delete_or_merge",
      reason: "unpaid",
    });
  });
});
