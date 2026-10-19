import { useEffect, useState } from "react";
import type { ThemePreference } from "./theme.js";
import { applyThemePreference, loadThemePreference, saveThemePreference } from "./theme-runtime.js";

const OPTIONS: { id: ThemePreference; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "system", label: "System" },
];

/** Apply the saved theme before first paint. Call once at startup (before React renders). */
export function initTheme(): ThemePreference {
  const preference = loadThemePreference();
  applyThemePreference(preference);
  return preference;
}

/** Dark / Light / System segmented control. The choice is saved and applied immediately. */
export function ThemeToggle(props: { initial?: ThemePreference; onChange?: (preference: ThemePreference) => void }) {
  const [preference, setPreference] = useState<ThemePreference>(props.initial ?? (() => loadThemePreference()));
  useEffect(() => {
    applyThemePreference(preference);
  }, [preference]);
  function choose(next: ThemePreference) {
    if (next === preference) return;
    saveThemePreference(next);
    applyThemePreference(next, undefined, { animate: true });
    setPreference(next);
    props.onChange?.(next);
  }
  return (
    <div className="segmented" role="radiogroup" aria-label="Theme" data-testid="theme-toggle">
      {OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={preference === option.id}
          className={preference === option.id ? "active" : ""}
          data-testid={`theme-${option.id}`}
          onClick={() => choose(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
