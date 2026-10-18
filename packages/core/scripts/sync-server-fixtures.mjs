#!/usr/bin/env node
/* global console, process */
/**
 * Re-copy fixtures/<area>/<case>.json from gendragoon-cloud-ssd into
 * packages/core/test/fixtures/server. Does not edit the JSON.
 *
 *   node packages/core/scripts/sync-server-fixtures.mjs [commit]
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dest = join(here, "../test/fixtures/server");
const sourceMeta = JSON.parse(readFileSync(join(dest, "SOURCE.json"), "utf8"));
const repo = sourceMeta.url;
const branch = sourceMeta.branch;
const commit = process.argv[2] || sourceMeta.commit;

const tmp = mkdtempSync(join(tmpdir(), "gd-server-fixtures-"));
try {
  run(["init", "-q"]);
  run(["remote", "add", "origin", repo]);
  run(["fetch", "--depth", "1", "origin", commit]);
  const head = spawnSync("git", ["rev-parse", "FETCH_HEAD"], { cwd: tmp, encoding: "utf8" });
  if (head.status !== 0) fail(head.stderr || head.stdout);
  const resolved = head.stdout.trim();
  run(["checkout", resolved, "--", "fixtures"]);
  const incoming = join(tmp, "fixtures");
  for (const entry of readdirSync(dest, { withFileTypes: true })) {
    if (entry.isDirectory()) rmSync(join(dest, entry.name), { recursive: true, force: true });
  }
  for (const entry of readdirSync(incoming, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const from = join(incoming, entry.name);
    const to = join(dest, entry.name);
    mkdirSync(to, { recursive: true });
    for (const file of readdirSync(from)) {
      if (!file.endsWith(".json")) continue;
      cpSync(join(from, file), join(to, file));
    }
  }
  writeFileSync(join(dest, "SOURCE.json"), `${JSON.stringify({
    repository: sourceMeta.repository,
    url: repo,
    branch,
    commit: resolved,
  }, null, 2)}\n`);
  const count = readdirSync(dest, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .reduce((sum, entry) => sum + readdirSync(join(dest, entry.name)).filter((name) => name.endsWith(".json")).length, 0);
  if (count === 0) fail("export contained no fixture JSON");
  console.log(`Synced ${count} fixtures from ${repo} @ ${resolved} (${branch})`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

function run(args) {
  const result = spawnSync("git", args, { cwd: tmp, encoding: "utf8" });
  if (result.status !== 0) fail(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
}

function fail(message) {
  console.error(String(message).trim());
  process.exit(1);
}
