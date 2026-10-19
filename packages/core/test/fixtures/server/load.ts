import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `{ request, response: { status, body } }` as exported by the backend. */
export interface ServerFixture {
  request: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  };
  response: {
    status: number;
    body: unknown;
  };
}

const root = dirname(fileURLToPath(import.meta.url));

export function loadServerFixture(area: string, name: string): ServerFixture {
  const parsed = JSON.parse(readFileSync(join(root, area, `${name}.json`), "utf8")) as ServerFixture;
  if (!parsed?.request?.path || !parsed.response || typeof parsed.response.status !== "number") {
    throw new Error(`Fixture ${area}/${name} is missing request/response`);
  }
  return parsed;
}

export function listServerFixtures(): { area: string; name: string; fixture: ServerFixture }[] {
  const found: { area: string; name: string; fixture: ServerFixture }[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of readdirSync(join(root, entry.name))) {
      if (!file.endsWith(".json")) continue;
      const name = file.slice(0, -".json".length);
      found.push({ area: entry.name, name, fixture: loadServerFixture(entry.name, name) });
    }
  }
  return found.sort((a, b) => `${a.area}/${a.name}`.localeCompare(`${b.area}/${b.name}`));
}
