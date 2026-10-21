import type { StorageUrlResponse } from "./api/types.js";
import { sealNamedFile, type SealedName } from "./seal.js";
import { assertStorageUrlResponse, putSignedObject, storageOperations } from "./storage.js";

/**
 * Seal a file with the workspace key, then PUT only the ciphertext.
 * The plaintext path is not part of the storage request.
 */
export async function uploadEncryptedObject(input: {
  workspaceId: string;
  path: string;
  plaintext: Uint8Array;
  workspaceKey: CryptoKey;
  storageUrls: (workspaceId: string, body: ReturnType<typeof storageOperations>) => Promise<StorageUrlResponse>;
  fetchImpl?: typeof fetch;
  chunkBytes?: number;
}): Promise<SealedName> {
  const sealed = await sealNamedFile({
    path: input.path,
    plaintext: input.plaintext,
    workspaceKey: input.workspaceKey,
    chunkBytes: input.chunkBytes,
  });
  const response = await input.storageUrls(
    input.workspaceId,
    storageOperations({ intent: "upload", oid: sealed.oid, locked: false }),
  );
  assertStorageUrlResponse(response);
  const link = response.urls.find((item) => item.object === sealed.oid) ?? response.urls[0];
  if (!link) throw new Error("Storage links are missing");
  await putSignedObject(link, sealed.ciphertext, input.fetchImpl);
  return sealed.entry;
}

/**
 * Write the replacement ciphertext, commit the manifest, and only then delete the previous object.
 * A failed commit leaves the old object and the local original in place.
 */
export async function replaceEncryptedObject(input: {
  workspaceId: string;
  previous: SealedName;
  path: string;
  plaintext: Uint8Array;
  workspaceKey: CryptoKey;
  storageUrls: (workspaceId: string, body: ReturnType<typeof storageOperations>) => Promise<StorageUrlResponse>;
  commit: (entry: SealedName) => Promise<void>;
  deleteOld: (oid: string) => Promise<void>;
  trashLocal?: () => Promise<void>;
  fetchImpl?: typeof fetch;
  chunkBytes?: number;
}): Promise<SealedName> {
  const sealed = await sealNamedFile({
    path: input.path,
    plaintext: input.plaintext,
    workspaceKey: input.workspaceKey,
    chunkBytes: input.chunkBytes,
    fileId: input.previous.fileId,
  });
  const response = await input.storageUrls(
    input.workspaceId,
    storageOperations({ intent: "put", oid: sealed.oid, locked: false }),
  );
  assertStorageUrlResponse(response);
  const link = response.urls.find((item) => item.object === sealed.oid) ?? response.urls[0];
  if (!link) throw new Error("Storage links are missing");
  await putSignedObject(link, sealed.ciphertext, input.fetchImpl);
  try {
    await input.commit(sealed.entry);
  } catch (error) {
    throw error instanceof Error ? error : new Error("Manifest commit failed");
  }
  await input.deleteOld(input.previous.oid);
  if (input.trashLocal) await input.trashLocal();
  return sealed.entry;
}
