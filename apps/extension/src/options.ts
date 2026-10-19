import { applyThemePreference, loadThemePreference } from "../../../packages/ui/src/theme-runtime";
import { API_BASE, PRIVACY_URL, SUPPORT_URL } from "./config";
import { probeService } from "./status";
import { renderChecking, renderStatus } from "./statusView";
import { mountThemeControl } from "./themeControl";

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

function init(): void {
  applyThemePreference(loadThemePreference());
  mountThemeControl($("theme"));
  $("endpoint").textContent = new URL(API_BASE).host;
  $<HTMLAnchorElement>("support").href = SUPPORT_URL;
  $<HTMLAnchorElement>("privacy").href = PRIVACY_URL;
  const manifest = (globalThis as { chrome?: { runtime?: { getManifest?: () => { version?: string } } } }).chrome?.runtime?.getManifest?.();
  $("version").textContent = manifest?.version ? `v${manifest.version}` : "";
  $("refresh").addEventListener("click", () => void refresh());
  void refresh();
}

if (typeof document !== "undefined" && document.body?.classList.contains("options-page")) init();
