import { applyThemePreference, loadThemePreference, saveThemePreference } from "../../../packages/ui/src/theme-runtime";
import type { ThemePreference } from "../../../packages/ui/src/theme";

const OPTIONS: [ThemePreference, string][] = [["dark", "Dark"], ["light", "Light"], ["system", "System"]];

/** Renders the Dark / Light / System radio group into `group` and persists the choice. Dark is the default. */
export function mountThemeControl(group: HTMLElement): void {
  let current: ThemePreference = loadThemePreference();
  applyThemePreference(current);
  const draw = () => {
    group.replaceChildren(...OPTIONS.map(([id, label]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(id === current));
      button.dataset.theme = id;
      if (id === current) button.className = "active";
      button.addEventListener("click", () => {
        current = id;
        saveThemePreference(id);
        applyThemePreference(id, undefined, { animate: true });
        draw();
      });
      return button;
    }));
  };
  draw();
}
