import { applyThemePreference, loadThemePreference } from "../../../packages/ui/src/theme-runtime";
import { mountThemeControl } from "./themeControl";
import { API_BASE, PRIVACY_URL, SUPPORT_URL } from "./config";
import { sortCategoryFor } from "./sorter";
import { probeService } from "./status";
import { renderChecking, renderStatus } from "./statusView";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function refresh(): Promise<void> {
  const status = $("status");
  const button = $<HTMLButtonElement>("refresh");
  button.disabled = true;
  renderChecking(status);
  try {
    renderStatus(status, await probeService(API_BASE));
  } finally {
    status.removeAttribute("aria-busy");
    button.disabled = false;
  }
}

function openSettings(): void {
  const api = (globalThis as { browser?: { runtime?: { openOptionsPage?: () => unknown } }; chrome?: { runtime?: { openOptionsPage?: () => unknown } } });
  (api.browser ?? api.chrome)?.runtime?.openOptionsPage?.();
}

function init(): void {
  applyThemePreference(loadThemePreference());
  mountThemeControl($("theme"));
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
  $("open-settings").addEventListener("click", openSettings);
  void refresh();
}

if (typeof document !== "undefined" && document.getElementById("status")) init();
