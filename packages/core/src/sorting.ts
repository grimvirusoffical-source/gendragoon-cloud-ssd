import sortMap from "../data/sort-map.json";

export const SORT_CATEGORIES = sortMap.categories;
export type SortCategory = (typeof SORT_CATEGORIES)[number];

export interface SortOverrides {
  extensions?: Record<string, SortCategory>;
  mimeTypes?: Record<string, SortCategory>;
}

export interface SortInput {
  name: string;
  mime?: string;
  kind?: "file" | "folder" | "app";
}

const categories = new Set<string>(SORT_CATEGORIES);

export function isSortCategory(value: string): value is SortCategory {
  return categories.has(value);
}

export function extensionOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

/**
 * Canonical map is packages/core/data/sort-map.json. User overrides win.
 * Extension is preferred over MIME. Application bundles are Apps.
 */
export function categorize(input: SortInput, overrides: SortOverrides = {}): SortCategory {
  if (input.kind === "app" || input.name.toLowerCase().endsWith(".app")) return "Apps";
  const extension = extensionOf(input.name);
  const mime = input.mime?.toLowerCase() ?? "";
  const userExt = extension ? overrides.extensions?.[extension] : undefined;
  if (userExt && isSortCategory(userExt)) return userExt;
  const userMime = mime ? overrides.mimeTypes?.[mime] : undefined;
  if (userMime && isSortCategory(userMime)) return userMime;
  if (extension) {
    const canonical = sortMap.extensions[extension as keyof typeof sortMap.extensions];
    if (canonical) return canonical;
  }
  if (mime) {
    const canonical = sortMap.mimeTypes[mime as keyof typeof sortMap.mimeTypes];
    if (canonical) return canonical;
  }
  return sortMap.defaultCategory;
}

export function applySortOverride(
  overrides: SortOverrides,
  change: { extension?: string; mime?: string; category: SortCategory },
): SortOverrides {
  if (!isSortCategory(change.category)) {
    throw new Error("Unknown sort category");
  }
  const next: SortOverrides = {
    extensions: { ...overrides.extensions },
    mimeTypes: { ...overrides.mimeTypes },
  };
  if (change.extension) {
    const extension = change.extension.startsWith(".") ? change.extension.toLowerCase() : `.${change.extension.toLowerCase()}`;
    next.extensions = { ...next.extensions, [extension]: change.category };
  }
  if (change.mime) {
    next.mimeTypes = { ...next.mimeTypes, [change.mime.toLowerCase()]: change.category };
  }
  if (!change.extension && !change.mime) {
    throw new Error("An extension or MIME type is required");
  }
  return next;
}
