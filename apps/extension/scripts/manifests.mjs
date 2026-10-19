/** Per-browser MV3 manifests from one base. Exported for the build and the tests. */
export const DEFAULT_API_BASE = "https://gendragoon-free-10068843866.us-central1.run.app";
// TODO(owner): replace with the add-on id you register on AMO (an email-style or {uuid} id). Must stay stable after first publish.
export const FIREFOX_ID = "gendragoon-cloud-ssd@gendragoon.app";

export function baseManifest(version, apiBase = DEFAULT_API_BASE) {
  return {
    manifest_version: 3,
    name: "GenDragoon Cloud SSD",
    short_name: "GenDragoon",
    version,
    description: "GenDragoon Cloud SSD in your browser: check service status and see where files will be sorted. Dark, Light and System themes.",
    icons: { 16: "icons/gendragoon-16.png", 32: "icons/gendragoon-32.png", 48: "icons/gendragoon-48.png", 128: "icons/gendragoon-128.png" },
    action: {
      default_title: "GenDragoon Cloud SSD",
      default_popup: "popup.html",
      default_icon: { 16: "icons/gendragoon-16.png", 32: "icons/gendragoon-32.png", 48: "icons/gendragoon-48.png" },
    },
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
