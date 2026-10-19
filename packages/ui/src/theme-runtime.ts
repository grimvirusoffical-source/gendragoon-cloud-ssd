import { DEFAULT_THEME_PREFERENCE, resolveTheme, type ThemeName, type ThemePreference } from "./theme.js";

export const THEME_STORAGE_KEY = "gendragoon.theme";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "dark" || value === "light" || value === "system";
}

/** Saved preference, or dark (the default) when nothing valid is saved or storage is unavailable. */
export function loadThemePreference(storage?: StorageLike | null): ThemePreference {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
    const saved = store?.getItem(THEME_STORAGE_KEY);
    return isThemePreference(saved) ? saved : DEFAULT_THEME_PREFERENCE;
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

export function saveThemePreference(preference: ThemePreference, storage?: StorageLike | null): void {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
    store?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Private mode or blocked storage: the choice still applies for this session.
  }
}

export interface ThemeTarget {
  documentElement: { dataset: Record<string, string | undefined>; classList: { add(c: string): void; remove(c: string): void } };
}

/**
 * Apply a preference to the document. CSS handles `system` through prefers-color-scheme, so the
 * page also follows the OS live. A short .theme-anim class gives the switch a smooth cross-fade;
 * it is removed afterwards so normal interactions are not slowed by blanket transitions.
 */
export function applyThemePreference(
  preference: ThemePreference,
  doc: ThemeTarget | undefined = typeof document === "undefined" ? undefined : (document as unknown as ThemeTarget),
  options: { animate?: boolean } = {},
): void {
  if (!doc) return;
  const root = doc.documentElement;
  if (options.animate) {
    root.classList.add("theme-anim");
    setTimeout(() => root.classList.remove("theme-anim"), 400);
  }
  root.dataset.theme = preference;
}

export function currentTheme(preference: ThemePreference, matchMedia?: (query: string) => { matches: boolean }): ThemeName {
  const mm = matchMedia ?? (typeof window === "undefined" ? undefined : window.matchMedia?.bind(window));
  return resolveTheme(preference, mm?.("(prefers-color-scheme: light)").matches ?? false);
}
