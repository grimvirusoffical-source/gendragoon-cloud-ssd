import { readFileSync } from "node:fs";
import path from "node:path";

/** gendragoon-cloud-ssd PR #5 at the BYO, lock, and merge snapshot. */
export const FIXTURE_SOURCE_SHA = "da3927627fee76103981714f9f8ffa954843b74b";

/** cloud-ssd PR #6 support fixtures. The rest of account-deletion stays on fff0a84. */
export const SUPPORT_FIXTURE_SHA = "d33970cbf0175a74898c37a8a624a92b1c1a5a94";

/** Files whose source commit differs from the rest of their area. */
export const FIXTURE_SOURCE_SHA_BY_FILE: Record<string, string> = {
  "account-deletion/support-received.json": SUPPORT_FIXTURE_SHA,
  "account-deletion/support-repeat.json": SUPPORT_FIXTURE_SHA,
  "account-deletion/support-bad-token.json": SUPPORT_FIXTURE_SHA,
  "account-deletion/support-rate-limited.json": SUPPORT_FIXTURE_SHA,
  "account-deletion/support-not-needed.json": SUPPORT_FIXTURE_SHA,
};

/** Later fixture areas, keyed by the directory under fixtures/. */
export const FIXTURE_SOURCE_SHA_BY_AREA: Record<string, string> = {
  /** cloud-ssd PR #6. Support cases are d33970c; see FIXTURE_SOURCE_SHA_BY_FILE. */
  "account-deletion": "fff0a84b6d75acb3a79cff7f146450c486efbe56",
  "errors": "fff0a84b6d75acb3a79cff7f146450c486efbe56",
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
