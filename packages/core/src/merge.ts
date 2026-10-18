export interface MergeEntry {
  path: string;
  copied?: boolean;
  verified?: boolean;
}

export interface PlannedMergeEntry {
  sourcePath: string;
  targetPath: string;
}

export type MergePhase = "planning" | "copying" | "verified" | "blocked";

const RESERVED = new Set(["", ".", ".."]);

export function collisionLabel(workspaceName: string): string {
  const clean = workspaceName.replace(/[\\/]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("Workspace name is required");
  return clean;
}

/**
 * Move planning. The target's existing path is never renamed or overwritten.
 * A colliding incoming path becomes `name (from <source>)`, then
 * `name (from <source>) 2`, and so on.
 */
export function planIncomingPath(path: string, sourceWorkspaceName: string, taken: ReadonlySet<string>): string {
  const normalized = normalizeRelative(path);
  if (!taken.has(normalized)) return normalized;
  const label = collisionLabel(sourceWorkspaceName);
  const first = `${normalized} (from ${label})`;
  if (!taken.has(first)) return first;
  let suffix = 2;
  let candidate = `${normalized} (from ${label}) ${suffix}`;
  while (taken.has(candidate)) {
    suffix += 1;
    candidate = `${normalized} (from ${label}) ${suffix}`;
  }
  return candidate;
}

export function planMerge(
  entries: readonly { path: string }[],
  sourceWorkspaceName: string,
  targetPaths: Iterable<string>,
): PlannedMergeEntry[] {
  const taken = new Set(Array.from(targetPaths, (path) => normalizeRelative(path)));
  const planned: PlannedMergeEntry[] = [];
  for (const entry of entries) {
    const sourcePath = normalizeRelative(entry.path);
    const targetPath = planIncomingPath(sourcePath, sourceWorkspaceName, taken);
    taken.add(targetPath);
    planned.push({ sourcePath, targetPath });
  }
  return planned;
}

export function sourceDeletionAllowed(entries: readonly MergeEntry[]): boolean {
  return entries.length > 0 && entries.every((entry) => entry.copied === true && entry.verified === true);
}

export function mergePhase(entries: readonly MergeEntry[]): MergePhase {
  if (entries.length === 0) return "planning";
  if (entries.some((entry) => entry.copied !== true)) return "copying";
  if (entries.some((entry) => entry.verified !== true)) return "blocked";
  return "verified";
}

function normalizeRelative(path: string): string {
  const parts = path.split(/[/\\]/).filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => RESERVED.has(part))) {
    throw new Error("Merge path must be a relative file path");
  }
  return parts.join("/");
}
