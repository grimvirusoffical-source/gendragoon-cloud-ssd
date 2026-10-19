import { applySortOverride, isSortCategory, type SortCategory, type SortOverrides } from "./sorting.js";

export interface Settings {
  schema: 1;
  sortOverrides: {
    extensions: Record<string, SortCategory>;
    mimeTypes: Record<string, SortCategory>;
  };
}

export const EMPTY_SETTINGS: Settings = {
  schema: 1,
  sortOverrides: { extensions: {}, mimeTypes: {} },
};

export interface SettingsStore {
  load(): Promise<Settings>;
  save(settings: Settings): Promise<void>;
}

export function validateSettings(value: Settings): Settings {
  if (value.schema !== 1) throw new Error("Unsupported settings schema");
  const extensions: Record<string, SortCategory> = {};
  const mimeTypes: Record<string, SortCategory> = {};
  for (const [key, category] of Object.entries(value.sortOverrides.extensions)) {
    if (!isSortCategory(category)) throw new Error(`Unknown category for ${key}`);
    extensions[key.toLowerCase()] = category;
  }
  for (const [key, category] of Object.entries(value.sortOverrides.mimeTypes)) {
    if (!isSortCategory(category)) throw new Error(`Unknown category for ${key}`);
    mimeTypes[key.toLowerCase()] = category;
  }
  return { schema: 1, sortOverrides: { extensions, mimeTypes } };
}

export class MemorySettingsStore implements SettingsStore {
  private value: Settings = structuredClone(EMPTY_SETTINGS);

  async load(): Promise<Settings> {
    return structuredClone(this.value);
  }

  async save(settings: Settings): Promise<void> {
    this.value = validateSettings(structuredClone(settings));
  }
}

export function updateSortMapping(settings: Settings, extension: string, category: SortCategory): Settings {
  const sortOverrides: SortOverrides = applySortOverride(settings.sortOverrides, { extension, category });
  return validateSettings({
    schema: 1,
    sortOverrides: {
      extensions: sortOverrides.extensions ?? {},
      mimeTypes: sortOverrides.mimeTypes ?? {},
    },
  });
}
