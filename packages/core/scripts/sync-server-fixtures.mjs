#!/usr/bin/env node
/* global console, process */
/**
 * Re-copy fixtures/<area>/<case>.json from gendragoon-cloud-ssd.
 * Each source commit contributes only its areas. Policy fixtures stay on 568f223.
 * Does not edit the JSON.
 *
 *   node packages/core/scripts/sync-server-fixtures.mjs
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

const sources = [
  {
    branch: "fix/backend-workspace-policy",
    commit: "568f2236ffe2520758fb8f20cf22566aefc14cf3",
    areas: ["workspace-lock", "workspaces", "merge", "byo", "ownership"],
  },
  {
    branch: "fix/account-deletion",
    pullRequest: 6,
    commit: "fff0a84b6d75acb3a79cff7f146450c486efbe56",
    areas: ["account-deletion", "errors"],
  },
  {
    branch: "feat/workspace-key-envelope",
    pullRequest: 9,
    commit: "ee4f76f07bc798635002ae2c272fb47d83db7698",
    areas: ["key-envelope"],
  },
  {
    branch: "feat/scoped-bucket-auth",
    pullRequest: 7,
    commit: "8267784a790bbe8418b3cbe36e8a4b91849b0e81",
    areas: ["storage-urls"],
  },
];

const tmp = mkdtempSync(join(tmpdir(), "gd-server-fixtures-"));
try {
  run(["init", "-q"]);
  run(["remote", "add", "origin", repo]);
  for (const source of sources) {
    run(["fetch", "--depth", "1", "origin", source.commit]);
    const head = spawnSync("git", ["rev-parse", "FETCH_HEAD"], { cwd: tmp, encoding: "utf8" });
    if (head.status !== 0) fail(head.stderr || head.stdout);
    const resolved = head.stdout.trim();
    if (resolved !== source.commit) fail(`fetched ${resolved}, expected ${source.commit}`);
    run(["checkout", resolved, "--", "fixtures"]);
    for (const area of source.areas) {
      const from = join(tmp, "fixtures", area);
      const to = join(dest, area);
      rmSync(to, { recursive: true, force: true });
      mkdirSync(to, { recursive: true });
      for (const file of readdirSync(from)) {
        if (!file.endsWith(".json")) continue;
        cpSync(join(from, file), join(to, file));
      }
    }
    source.commit = resolved;
  }
  const deletion = join(dest, "account-deletion");
  const pr6 = join(here, "../test/fixtures/server-pr6/account-deletion");
  rmSync(pr6, { recursive: true, force: true });
  mkdirSync(pr6, { recursive: true });
  for (const file of readdirSync(deletion)) {
    if (file.endsWith(".json")) cpSync(join(deletion, file), join(pr6, file));
  }
  const pr6Commit = sources[1].commit;
  writeFileSync(join(here, "../test/fixtures/server-pr6/SOURCE.json"), `${JSON.stringify({
    repository: sourceMeta.repository,
    url: repo,
    branch: "fix/account-deletion",
    pullRequest: 6,
    commit: pr6Commit,
    paths: ["fixtures/account-deletion"],
  }, null, 2)}\n`);
  const cloud = join(here, "../test/fixtures/cloud-ssd");
  for (const area of ["storage-urls", "key-envelope"]) {
    const from = join(dest, area);
    const to = join(cloud, area);
    rmSync(to, { recursive: true, force: true });
    mkdirSync(to, { recursive: true });
    for (const file of readdirSync(from)) {
      if (file.endsWith(".json")) cpSync(join(from, file), join(to, file));
    }
  }
  writeFileSync(join(dest, "SOURCE.json"), `${JSON.stringify({
    repository: sourceMeta.repository,
    url: repo,
    branch: "fix/backend-workspace-policy",
    commit: sources[0].commit,
    sources,
  }, null, 2)}\n`);
  const count = readdirSync(dest, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .reduce((sum, entry) => sum + readdirSync(join(dest, entry.name)).filter((name) => name.endsWith(".json")).length, 0);
  if (count === 0) fail("export contained no fixture JSON");
  console.log(`Synced ${count} fixtures from ${repo}`);
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
