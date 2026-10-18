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

export type UpdateOutcome<TInstalled extends InstalledVersion = InstalledVersion> =
  | { outcome: "healthy"; version: string }
  | { outcome: "checksum_failed"; version: string }
  | { outcome: "rolled_back"; version: string }
  | { outcome: "deferred"; version: string; installed: TInstalled };

export interface UpdateHooks<TInstalled extends InstalledVersion = InstalledVersion> {
  manifest: ReleaseManifest;
  download: (manifest: ReleaseManifest) => Promise<Uint8Array>;
  install: (manifest: ReleaseManifest, bytes: Uint8Array) => Promise<TInstalled>;
  relaunch: (installed: TInstalled) => Promise<void>;
  healthCheck: () => Promise<boolean>;
  rollback: (previous: TInstalled | null) => Promise<void>;
  previous?: TInstalled | null;
  /** True while an upload or backup is still moving bytes. */
  transferActive?: () => boolean | Promise<boolean>;
  /** Synchronous, non-blocking. Hosts show "Updating..." here. There is no Restart button. */
  notifyUpdating?: () => void;
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
): Promise<UpdateOutcome<TInstalled>> {
  const bytes = await hooks.download(hooks.manifest);
  if (!verifySha256(bytes, hooks.manifest.sha256)) {
    return { outcome: "checksum_failed", version: hooks.manifest.version };
  }
  const installed = await hooks.install(hooks.manifest, bytes);
  hooks.notifyUpdating?.();
  if (await hooks.transferActive?.()) {
    return { outcome: "deferred", version: hooks.manifest.version, installed };
  }
  await hooks.relaunch(installed);
  const healthy = await hooks.healthCheck();
  if (!healthy) {
    await hooks.rollback(hooks.previous ?? null);
    return { outcome: "rolled_back", version: hooks.manifest.version };
  }
  return { outcome: "healthy", version: hooks.manifest.version };
}

/**
 * After a deferred install, relaunch as soon as the transfer is idle.
 * Hosts call this when the upload or backup finishes. There is no manual restart.
 */
export async function relaunchIfIdle<TInstalled extends InstalledVersion>(input: {
  deferred: TInstalled | null;
  transferActive: () => boolean | Promise<boolean>;
  relaunch: (installed: TInstalled) => Promise<void>;
}): Promise<"idle" | "waiting" | "relaunched"> {
  if (!input.deferred) return "idle";
  if (await input.transferActive()) return "waiting";
  await input.relaunch(input.deferred);
  return "relaunched";
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
