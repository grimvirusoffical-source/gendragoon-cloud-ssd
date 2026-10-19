/** Per-browser MV3 manifests from one base. Exported for the build and the tests. */
export const DEFAULT_API_BASE = "https://gendragoon-free-10068843866.us-central1.run.app";
// TODO(owner): replace with the add-on id you register on AMO (an email-style or {uuid} id). Must stay stable after first publish.
export const FIREFOX_ID = "gendragoon-cloud-ssd@gendragoon.app";

/** Every size the four stores ask for: 16/32 toolbar and favicon, 48 management page, 96 Firefox, 128 store, 256/512 high-DPI. */
export const ICONS = { 16: "icons/gendragoon-16.png", 32: "icons/gendragoon-32.png", 48: "icons/gendragoon-48.png", 64: "icons/gendragoon-64.png", 96: "icons/gendragoon-96.png", 128: "icons/gendragoon-128.png", 256: "icons/gendragoon-256.png" };

export function baseManifest(version, apiBase = DEFAULT_API_BASE) {
  return {
    manifest_version: 3,
    name: "__MSG_extName__",
    short_name: "__MSG_extShortName__",
    version,
    description: "__MSG_extDescription__",
    default_locale: "en",
    author: "GenDragoon",
    icons: ICONS,
    action: {
      default_title: "__MSG_actionTitle__",
      default_popup: "popup.html",
      default_icon: { 16: "icons/gendragoon-16.png", 19: "icons/gendragoon-19.png", 24: "icons/gendragoon-24.png", 32: "icons/gendragoon-32.png", 38: "icons/gendragoon-38.png" },
    },
    options_ui: { page: "options.html", open_in_tab: true },
    // No API permissions. The host permission lets the popup call the public health route of this one service.
    permissions: [],
    host_permissions: [`${apiBase.replace(/\/+$/, "")}/*`],
  };
}

export function manifestFor(browser, version, apiBase) {
  const m = baseManifest(version, apiBase);
  if (browser === "chrome") return { ...m, minimum_chrome_version: "114", background: { service_worker: "background.js" } };
  if (browser === "edge") return { ...m, minimum_chrome_version: "114", background: { service_worker: "background.js" } };
  if (browser === "opera") return { ...m, minimum_chrome_version: "114", minimum_opera_version: "100", background: { service_worker: "background.js" } };
  if (browser === "firefox") {
    return {
      ...m,
      // Firefox MV3 uses an event page (background.scripts), not a service worker.
      background: { scripts: ["background.js"] },
      browser_specific_settings: {
        gecko: { id: FIREFOX_ID, strict_min_version: "128.0", data_collection_permissions: { required: ["none"] } },
      },
    };
  }
  throw new Error(`Unknown browser ${browser}`);
}

export const BROWSERS = ["chrome", "edge", "firefox", "opera"];
