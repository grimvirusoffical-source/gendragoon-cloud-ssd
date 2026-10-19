import { applyThemePreference, loadThemePreference, saveThemePreference } from "../../../packages/ui/src/theme-runtime";
import type { ThemePreference } from "../../../packages/ui/src/theme";
import { API_BASE, PRIVACY_URL, SUPPORT_URL } from "./config";
import { sortCategoryFor } from "./sorter";
import { probeService, type ServiceStatus } from "./status";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function renderStatus(target: HTMLElement, status: ServiceStatus): void {
  target.replaceChildren();
  const row = document.createElement("div");
  row.className = "row";
  const dot = document.createElement("span");
  dot.className = status.state === "online" ? "dot" : "dot off";
  const text = document.createElement("span");
  text.textContent = status.state === "online" ? `Online · ${status.ms} ms` : `Offline · ${status.reason}`;
  row.append(dot, text);
  target.append(row);
}

function renderTheme(): void {
  const group = $("theme");
  let current: ThemePreference = loadThemePreference();
  applyThemePreference(current);
  const options: [ThemePreference, string][] = [["dark", "Dark"], ["light", "Light"], ["system", "System"]];
  const draw = () => {
    group.replaceChildren(...options.map(([id, label]) => {
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

async function refresh(): Promise<void> {
  const status = $("status");
  renderStatus(status, await probeService(API_BASE));
}

function init(): void {
  applyThemePreference(loadThemePreference());
  renderTheme();
  const link = (id: string, href: string) => { $<HTMLAnchorElement>(id).href = href; };
  link("support", SUPPORT_URL);
  link("privacy", PRIVACY_URL);
  const manifest = (globalThis as { chrome?: { runtime?: { getManifest?: () => { version?: string } } } }).chrome?.runtime?.getManifest?.();
  $("version").textContent = manifest?.version ? `v${manifest.version}` : "";
  const input = $<HTMLInputElement>("filename");
  const result = $("sort-result");
  input.addEventListener("input", () => {
    const category = sortCategoryFor(input.value);
    result.replaceChildren();
    if (!category) {
      result.textContent = "Type a file name to see its GenDragoon type folder.";
      return;
    }
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = category;
    result.append("Goes in ", chip);
  });
  $("refresh").addEventListener("click", () => void refresh());
  void refresh();
}

if (typeof document !== "undefined" && document.getElementById("status")) init();
