/**
 * Encrypted workspace setup stays off on core `091d892`.
 * Casey's report `runs/core-091d892-probe.md` found merge bugs in
 * `packages/core/src/manifest-cas.ts`: a higher-version empty remote drops
 * files that were never uploaded, `prunedThroughVersion` uses the wrong
 * counter, `lastSyncedVersion` defaults to 0 on a device that has only read,
 * a missing `writtenAtVersion` beats a delete, and two devices adding the
 * same path are both kept. The six shared vectors do not cover those cases.
 * Turn this on only after Avery's next core SHA fixes them and Casey clears it.
 */
export const ENCRYPTED_WORKSPACE_ENABLED = false;

/**
 * POST of a deletion support request. Riley's fixtures are vendored, and the
 * flag stays off until production has the webhook.
 * The path itself lives in `DELETION_SUPPORT_REQUEST_PATH`.
 */
export const DELETION_SUPPORT_ENDPOINT_ENABLED = false;

/**
 * Per-workspace labels from `isFree`, `grandfathered`, and `monthlyPriceCents`.
 * On now that cloud-ssd PR #5 fixtures at `4c3dd13` are vendored.
 */
export const WORKSPACE_PRICING_ENABLED = true;

/**
 * True only under Jest. Debug-only elements (e.g. `session-uid`) render behind
 * this, so a release or dev build never shows them. Read at call time so a test
 * can check the non-test branch.
 */
export function isTestBuild(): boolean {
  return process.env.NODE_ENV === "test";
}
