/** Mirrors native/Backend/transfer_v3.js item metadata and 8 MiB chunks. */

export const CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_FILE_BYTES = 5 * 1024 ** 4;
export const PACKAGE_FORMAT = "gendragoon-package-v1";

export type TransferKind = "file" | "folder" | "app";

export interface ChunkPlan {
  chunkBytes: number;
  totalChunks: number;
  chunks: { index: number; offset: number; length: number }[];
}

export interface TransferMetadata {
  kind: TransferKind;
  originalName: string;
  logicalBytes: number;
  archiveFormat?: typeof PACKAGE_FORMAT;
  manifestSHA256?: string;
}

const SHA = /^[a-f0-9]{64}$/;

function hasIllegalNameChar(value: string): boolean {
  if (value.includes("/") || value.includes("\\")) return true;
  for (const char of value) {
    if (char.charCodeAt(0) < 32) return true;
  }
  return false;
}

export function safeFileName(name: string): string {
  if (typeof name !== "string") throw new Error("File name must be a string");
  const normalized = name.trim().normalize("NFC");
  if (!normalized || normalized.length > 150 || normalized === "." || normalized === ".." || hasIllegalNameChar(normalized)) {
    throw new Error("Invalid file name");
  }
  return normalized;
}

export function planChunks(sizeBytes: number, chunkBytes = CHUNK_BYTES): ChunkPlan {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_FILE_BYTES) {
    throw new Error("File exceeds the transfer size limit");
  }
  if (sizeBytes === 0) return { chunkBytes, totalChunks: 0, chunks: [] };
  const totalChunks = Math.ceil(sizeBytes / chunkBytes);
  const chunks = Array.from({ length: totalChunks }, (_, index) => {
    const offset = index * chunkBytes;
    return { index, offset, length: Math.min(chunkBytes, sizeBytes - offset) };
  });
  return { chunkBytes, totalChunks, chunks };
}

export function transferMetadata(input: {
  name: string;
  kind?: TransferKind;
  sizeBytes: number;
  logicalBytes?: number;
  manifestSha256?: string;
  archiveFormat?: string | null;
}): TransferMetadata {
  const kind = input.kind ?? "file";
  if (kind !== "file" && kind !== "folder" && kind !== "app") {
    throw new Error("Invalid item kind");
  }
  const originalName = safeFileName(input.name);
  if (input.archiveFormat === undefined || input.archiveFormat === null) {
    if (kind !== "file" || input.manifestSha256 !== undefined || (input.logicalBytes !== undefined && input.logicalBytes !== input.sizeBytes)) {
      throw new Error("Folders and applications require a verified package");
    }
    return { kind, originalName, logicalBytes: input.sizeBytes };
  }
  if (input.archiveFormat !== PACKAGE_FORMAT || !SHA.test(input.manifestSha256 ?? "")) {
    throw new Error("Invalid package metadata");
  }
  if (!Number.isSafeInteger(input.logicalBytes) || (input.logicalBytes ?? -1) < 0 || (input.logicalBytes ?? 0) > MAX_FILE_BYTES) {
    throw new Error("Invalid package metadata");
  }
  if (kind === "app" && !originalName.toLowerCase().endsWith(".app")) {
    throw new Error("Invalid application package name");
  }
  return {
    kind,
    originalName,
    logicalBytes: input.logicalBytes ?? 0,
    archiveFormat: PACKAGE_FORMAT,
    manifestSHA256: input.manifestSha256,
  };
}
