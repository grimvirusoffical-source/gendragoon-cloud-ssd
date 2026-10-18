import { createHash, timingSafeEqual } from "node:crypto";
import type { ReleaseManifest } from "./manifest.js";

export class ChecksumError extends Error {
  constructor() {
    super("Release checksum did not match");
    this.name = "ChecksumError";
  }
}

export interface InstalledVersion {
  version: string;
  location?: string;
}

export type UpdateOutcome =
  | { outcome: "healthy"; version: string }
  | { outcome: "checksum_failed"; version: string }
  | { outcome: "rolled_back"; version: string };

export interface UpdateHooks<TInstalled extends InstalledVersion = InstalledVersion> {
  manifest: ReleaseManifest;
  download: (manifest: ReleaseManifest) => Promise<Uint8Array>;
  install: (manifest: ReleaseManifest, bytes: Uint8Array) => Promise<TInstalled>;
  relaunch: (installed: TInstalled) => Promise<void>;
  healthCheck: () => Promise<boolean>;
  rollback: (previous: TInstalled | null) => Promise<void>;
  previous?: TInstalled | null;
}

export function verifySha256(bytes: Uint8Array, expectedHex: string): boolean {
  const actual = createHash("sha256").update(bytes).digest("hex");
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expectedHex.toLowerCase(), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verify, install, relaunch, then health-check. A failed check rolls back
 * to the previous version. A checksum failure does not install or relaunch.
 */
export async function runUpdate<TInstalled extends InstalledVersion>(
  hooks: UpdateHooks<TInstalled>,
): Promise<UpdateOutcome> {
  const bytes = await hooks.download(hooks.manifest);
  if (!verifySha256(bytes, hooks.manifest.sha256)) {
    return { outcome: "checksum_failed", version: hooks.manifest.version };
  }
  const installed = await hooks.install(hooks.manifest, bytes);
  await hooks.relaunch(installed);
  const healthy = await hooks.healthCheck();
  if (!healthy) {
    await hooks.rollback(hooks.previous ?? null);
    return { outcome: "rolled_back", version: hooks.manifest.version };
  }
  return { outcome: "healthy", version: hooks.manifest.version };
}

/**
 * Post-launch half of the cycle for hosts whose relaunch starts a new process.
 * Call on the next launch when a pending update marker exists.
 */
export async function settleHealth(input: {
  pending: boolean;
  healthCheck: () => Promise<boolean>;
  rollback: () => Promise<void>;
}): Promise<"idle" | "healthy" | "rolled_back"> {
  if (!input.pending) return "idle";
  const healthy = await input.healthCheck();
  if (!healthy) {
    await input.rollback();
    return "rolled_back";
  }
  return "healthy";
}
