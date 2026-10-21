import { applyThemePreference, loadThemePreference } from "../../../packages/ui/src/theme-runtime";
import { mountThemeControl } from "./themeControl";
import { API_BASE, PRIVACY_URL, REDXAI_ISSUER, SUPPORT_URL } from "./config";
import { extensionRedirectUri, signIn, signOut, status, type AccountStatus, type ExtensionAuthDeps } from "./account";
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

type IdentityApi = {
  runtime?: { id?: string };
  identity?: { getRedirectURL?(path?: string): string; launchWebAuthFlow(details: { url: string; interactive: boolean }): Promise<string | undefined> };
  storage?: { session?: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void>; remove(key: string): Promise<void> } };
};

function authDeps(): ExtensionAuthDeps | null {
  const g = globalThis as { browser?: IdentityApi; chrome?: IdentityApi };
  const api = g.browser ?? g.chrome;
  const identity = api?.identity;
  const session = api?.storage?.session;
  if (!REDXAI_ISSUER || !identity || !session) return null;
  return {
    issuer: REDXAI_ISSUER,
    apiBase: API_BASE,
    redirectUri: extensionRedirectUri(identity, api?.runtime?.id),
    launchWebAuthFlow: async (url) => {
      const redirect = await identity.launchWebAuthFlow({ url, interactive: true });
      if (!redirect) throw new Error("cancelled");
      return redirect;
    },
    // Session storage: cleared when the browser closes, never synced.
    storage: { get: async (k) => (await session.get(k))[k], set: (k, v) => session.set({ [k]: v }), remove: (k) => session.remove(k) },
  };
}

const SETUP_TEXT: Record<string, string> = {
  account_setup_required: "Finish setting up Gendragoon in the desktop or mobile app (Terms and account details).",
  // Red-XAI keeps the Gendragoon Terms record; the hosted account page asks for the new version at the next sign-in.
  tos: "The Gendragoon Terms have changed. Sign out, then sign in again to read and agree to them on your Red-XAI account page.",
  tos_required: "The Gendragoon Terms have changed. Sign out, then sign in again to read and agree to them on your Red-XAI account page.",
  two_factor_setup_required: "Finish turning on two-factor sign-in in the Gendragoon app.",
  two_factor_required: "Confirm your two-factor code in the Gendragoon app.",
};

function renderAccount(box: HTMLElement, deps: ExtensionAuthDeps, current: AccountStatus): void {
  const button = (label: string, cls: string, run: () => Promise<AccountStatus | void>) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    b.addEventListener("click", async () => {
      b.disabled = true;
      b.setAttribute("aria-busy", "true");
      try {
        const next = await run();
        renderAccount(box, deps, next ?? { state: "signed-out" });
      } catch {
        renderAccount(box, deps, { state: "error", code: "sign_in_failed" });
      }
    });
    return b;
  };
  const text = (message: string) => Object.assign(document.createElement("p"), { className: "help", textContent: message });
  box.replaceChildren();
  if (current.state === "ready") {
    box.append(text(`Signed in as ${current.username}.`), button("Sign out", "btn-ghost", () => signOut(deps)));
    return;
  }
  if (current.state === "needs-setup") {
    box.append(text(SETUP_TEXT[current.reason] ?? SETUP_TEXT.account_setup_required!), button("Sign out", "btn-ghost", () => signOut(deps)));
    return;
  }
  if (current.state === "error") box.append(text(current.code === "sign_in_failed" ? "Sign-in didn't finish. Try again." : "Couldn't reach Gendragoon. Try again."));
  const row = document.createElement("div");
  row.className = "row";
  row.append(button("Sign in", "btn", () => signIn(deps, "sign-in")), button("Create account", "btn-ghost", () => signIn(deps, "sign-up")));
  box.append(text("Use your Red-XAI Account, the same one for every Red-XAI app."), row);
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
  const deps = authDeps();
  if (deps) void status(deps).then((current) => renderAccount($("account"), deps, current));
}

if (typeof document !== "undefined" && document.getElementById("status")) init();
