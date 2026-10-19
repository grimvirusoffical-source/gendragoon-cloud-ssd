import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { contrastRatio, darkColors, lightColors, resolveTheme, themes } from "../src/theme.js";
import { applyThemePreference, loadThemePreference, saveThemePreference, THEME_STORAGE_KEY } from "../src/theme-runtime.js";
import { EmptyState, ErrorState, Skeleton, TransferStatus } from "../src/Feedback.js";
import { ThemeToggle } from "../src/ThemeToggle.js";

/** Text pairs that must clear WCAG AA 4.5:1 in both themes. */
const TEXT_PAIRS: [keyof typeof darkColors, keyof typeof darkColors][] = [
  ["text", "bg"], ["text", "card"], ["text", "sidebar"], ["muted", "bg"], ["muted", "card"], ["muted", "sidebar"],
  ["faint", "bg"], ["faint", "card"], ["nav", "sidebar"], ["kicker", "bg"], ["chip", "card"],
  ["onPurple", "purple"], ["onPurple", "purpleHot"], ["onPurple", "selected"], ["dangerText", "card"],
  ["danger", "bg"], ["danger", "card"], ["ok", "bg"], ["ok", "card"], ["warn", "bg"], ["bannerText", "bg"], ["chip", "preview"],
];
/** UI component boundaries need 3:1 (WCAG 1.4.11). */
const UI_PAIRS: [keyof typeof darkColors, keyof typeof darkColors][] = [["inputBorder", "input"], ["inputBorder", "card"], ["purple", "bg"], ["focus", "bg"], ["focus", "card"]];

describe.each(["dark", "light"] as const)("WCAG AA contrast, %s theme", (name) => {
  const palette = themes[name];
  it.each(TEXT_PAIRS)("%s on %s >= 4.5:1", (fg, bg) => {
    expect(contrastRatio(palette[fg], palette[bg])).toBeGreaterThanOrEqual(4.5);
  });
  it.each(UI_PAIRS)("%s on %s >= 3:1", (fg, bg) => {
    expect(contrastRatio(palette[fg], palette[bg])).toBeGreaterThanOrEqual(3);
  });
});

describe("theme model", () => {
  it("dark is near-black and the default", () => {
    expect(darkColors.bg).toBe("#0d0b14");
    expect(resolveTheme(undefined, true)).toBe("dark");
    expect(resolveTheme("garbage", true)).toBe("dark");
  });
  it("system follows the OS, light/dark are fixed", () => {
    expect(resolveTheme("system", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
  });
  it("both palettes define exactly the same tokens", () => {
    expect(Object.keys(lightColors).sort()).toEqual(Object.keys(darkColors).sort());
  });
});

describe("persistence", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
  };
  it("defaults to dark, saves and reloads a choice, ignores junk", () => {
    const store = memory();
    expect(loadThemePreference(store)).toBe("dark");
    saveThemePreference("light", store);
    expect(store.data.get(THEME_STORAGE_KEY)).toBe("light");
    expect(loadThemePreference(store)).toBe("light");
    store.data.set(THEME_STORAGE_KEY, "neon");
    expect(loadThemePreference(store)).toBe("dark");
    expect(loadThemePreference({ getItem: () => { throw new Error("blocked"); }, setItem: () => undefined })).toBe("dark");
  });
  it("applies data-theme to the document root", () => {
    const classes = new Set<string>();
    const doc = { documentElement: { dataset: {} as Record<string, string | undefined>, classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } } };
    applyThemePreference("system", doc, { animate: true });
    expect(doc.documentElement.dataset.theme).toBe("system");
    expect(classes.has("theme-anim")).toBe(true);
  });
});

describe("generated CSS", () => {
  const css = readFileSync(new URL("../src/tokens.css", import.meta.url), "utf8");
  it("has dark default, light override, system media query and reduced motion", () => {
    expect(css).toMatch(/:root,\s*:root\[data-theme="dark"\],\s*:root\[data-theme="system"\]/);
    expect(css).toContain(':root[data-theme="light"]');
    expect(css).toMatch(/@media \(prefers-color-scheme: light\)\s*\{\s*:root\[data-theme="system"\]/);
    expect(css).toContain("prefers-reduced-motion: reduce");
  });
  it("component CSS uses tokens only (no hard-coded text/background hex except the brand-mark gradient)", () => {
    const components = readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");
    const hex = components.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    expect(hex.sort()).toEqual(["#170c3d", "#3b21b8"]);
  });
});

describe("components", () => {
  it("ThemeToggle renders Dark/Light/System as a radiogroup with the saved one checked", () => {
    const html = renderToStaticMarkup(<ThemeToggle initial="light" />);
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(/data-testid="theme-light"[^>]*>Light/);
    expect(html).toMatch(/aria-checked="true"[^>]*class="active"[^>]*data-testid="theme-light"|class="active"[^>]*data-testid="theme-light"/);
    for (const label of ["Dark", "Light", "System"]) expect(html).toContain(label);
  });
  it("skeleton is hidden from AT; empty/error states and transfer states render", () => {
    expect(renderToStaticMarkup(<Skeleton lines={2} />)).toContain('aria-hidden="true"');
    expect(renderToStaticMarkup(<EmptyState title="Nothing here yet" detail="Upload something." />)).toContain("Nothing here yet");
    const err = renderToStaticMarkup(<ErrorState title="Could not load" onRetry={() => undefined} />);
    expect(err).toContain('role="alert"');
    expect(err).toContain("Try again");
    const t = renderToStaticMarkup(<TransferStatus phase="preloading" percent={30} />);
    expect(t).toContain("Pre-caching");
    expect(t).toContain("scaleX(0.3)");
    expect(renderToStaticMarkup(<TransferStatus phase="done" />)).not.toContain("progressbar");
  });
});
