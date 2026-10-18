import { readFileSync } from "node:fs";
import path from "node:path";

/** gendragoon-cloud-ssd PR #5, presignedUrl-only BYO verify. */
export const FIXTURE_SOURCE_SHA = "da3927627fee76103981714f9f8ffa954843b74b";

/** Later fixture areas, keyed by the directory under fixtures/. */
export const FIXTURE_SOURCE_SHA_BY_AREA: Record<string, string> = {
  /** cloud-ssd PR #6, including JSON singular-path and deletion retry. */
  "account-deletion": "9d0f056430450fa97ae513181c9fd48852fd63bf",
  "errors": "9d0f056430450fa97ae513181c9fd48852fd63bf",
  "storage-urls": "6af23999cbe6c22a64c7fcab7a9e2f55710aa1c1",
  /** cloud-ssd PR #9, nested kdf envelope. */
  "key-envelope": "24fba029b6674ee4410ececec11b0935ba713960",
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
  const expectedSha = FIXTURE_SOURCE_SHA_BY_AREA[area] ?? FIXTURE_SOURCE_SHA;
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
