import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerFixture } from "../server/load.js";

/**
 * Riley's generated account-deletion fixtures from gendragoon-cloud-ssd PR #6
 * (fix/account-deletion @ 9d0f056, see SOURCE.json). Copied verbatim from
 * fixtures/account-deletion/. Kept apart from ../server, which is synced from
 * the PR #5 export (da39276) and is wiped by sync-server-fixtures.mjs.
 * Move these into ../server once PR #6 merges and the sync source moves.
 */
const root = dirname(fileURLToPath(import.meta.url));

export function loadDeletionFixture(name: string): ServerFixture {
  const parsed = JSON.parse(readFileSync(join(root, "account-deletion", `${name}.json`), "utf8")) as ServerFixture;
  if (!parsed?.request?.path || !parsed.response || typeof parsed.response.status !== "number") {
    throw new Error(`Fixture account-deletion/${name} is missing request/response`);
  }
  return parsed;
}
