import { readFileSync } from "node:fs";
import path from "node:path";

/** gendragoon-cloud-ssd PR #5 at the BYO, lock, and merge snapshot. */
export const FIXTURE_SOURCE_SHA = "da3927627fee76103981714f9f8ffa954843b74b";

/** cloud-ssd PR #6. Account deletion and errors are pinned here. */
export const DELETION_FIXTURE_SHA = "d33970cbf0175a74898c37a8a624a92b1c1a5a94";

/** Support fixtures that shipped with the deletion pin. */
export const SUPPORT_FIXTURE_SHA = DELETION_FIXTURE_SHA;

/**
 * cloud-ssd PR #6 head that adds `account-deletion/support-unauthorized.json`.
 * The rest of account deletion stays on `DELETION_FIXTURE_SHA`.
 */
export const SUPPORT_UNAUTHORIZED_SHA = "580e672230bf4cf458f4ec28dfcafb30860cc67f";

/** cloud-ssd PR #5 policy fixtures: fee waiver, grace, lapse, and make-hosted. */
export const WORKSPACE_POLICY_SHA = "0715b1a933a3ee3bb489e28a6122475403bb341d";

/** Same commit as `WORKSPACE_POLICY_SHA`. */
export const OWNER_FEE_WAIVED_SHA = WORKSPACE_POLICY_SHA;

/** Files whose source commit differs from the rest of their area. */
export const FIXTURE_SOURCE_SHA_BY_FILE: Record<string, string> = {
  "account-deletion/support-unauthorized.json": SUPPORT_UNAUTHORIZED_SHA,
  "workspaces/owner-fee-waived.json": WORKSPACE_POLICY_SHA,
  "workspaces/byo-register-ends-grandfathered.json": WORKSPACE_POLICY_SHA,
  "workspaces/byo-in-grace.json": WORKSPACE_POLICY_SHA,
  "workspaces/byo-lapsed-others-open.json": WORKSPACE_POLICY_SHA,
  "workspaces/make-hosted.json": WORKSPACE_POLICY_SHA,
  "workspace-lock/byo-lapsed.json": WORKSPACE_POLICY_SHA,
};

/** Later fixture areas, keyed by the directory under fixtures/. */
export const FIXTURE_SOURCE_SHA_BY_AREA: Record<string, string> = {
  /** cloud-ssd PR #6 at d33970c. `support-unauthorized` is newer; see FIXTURE_SOURCE_SHA_BY_FILE. */
  "account-deletion": DELETION_FIXTURE_SHA,
  "errors": DELETION_FIXTURE_SHA,
  /** cloud-ssd PR #7, manifest ifGeneration as a decimal string. */
  "storage-urls": "8267784a790bbe8418b3cbe36e8a4b91849b0e81",
  /** cloud-ssd PR #9 tip. Responses store salt, iv, and wrappedKey as unpadded base64url. */
  "key-envelope": "ee4f76f07bc798635002ae2c272fb47d83db7698",
  /** cloud-ssd PR #5 tip. List and create items carry isFree, grandfathered, and monthlyPriceCents. */
  "workspaces": "4c3dd13587fae1ddfa907ad2b84c0886d7794ade",
};

export interface FixtureFile<TBody> {
  sourceSha: string;
  sourcePath: string;
  request: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  };
  response: {
    status: number;
    body: TBody;
  };
}

/**
 * Reads a vendored `fixtures/<area>/<case>.json`.
 * The file starts with `Source-SHA` and `Source-Path` headers, then the
 * upstream `{request, response:{status, body}}` document.
 */
export function loadFixture<TBody>(rel: string): FixtureFile<TBody> {
  const text = readFileSync(path.join(__dirname, "fixtures", rel), "utf8");
  const lines = text.split(/\r?\n/);
  const sha = lines[0]?.startsWith("Source-SHA: ") ? lines[0].slice("Source-SHA: ".length).trim() : "";
  const sourcePath = lines[1]?.startsWith("Source-Path: ") ? lines[1].slice("Source-Path: ".length).trim() : "";
  const area = rel.split("/")[0] ?? "";
  const expectedSha = FIXTURE_SOURCE_SHA_BY_FILE[rel] ?? FIXTURE_SOURCE_SHA_BY_AREA[area] ?? FIXTURE_SOURCE_SHA;
  if (sha !== expectedSha) {
    throw new Error(`Fixture ${rel} source SHA is ${sha || "missing"}`);
  }
  if (sourcePath !== `fixtures/${rel}`) {
    throw new Error(`Fixture ${rel} source path is ${sourcePath || "missing"}`);
  }
  if (lines[2] !== "") throw new Error(`Fixture ${rel} is missing the header break`);
  const parsed = JSON.parse(lines.slice(3).join("\n")) as FixtureFile<TBody>;
  if (!parsed.request || !parsed.response || typeof parsed.response.status !== "number") {
    throw new Error(`Fixture ${rel} is not a {request, response} document`);
  }
  return { ...parsed, sourceSha: sha, sourcePath };
}
