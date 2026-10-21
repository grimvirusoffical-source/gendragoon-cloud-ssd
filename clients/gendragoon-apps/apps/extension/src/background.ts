/**
 * Minimal background script. The extension needs no persistent work, so it only registers an install listener.
 * (Chrome/Edge/Opera run it as a service worker; Firefox runs it as an event page.)
 */
interface RuntimeApi { runtime?: { onInstalled?: { addListener(cb: () => void): void } } }
const scope = globalThis as { browser?: RuntimeApi; chrome?: RuntimeApi };
const api = scope.browser ?? scope.chrome;
api?.runtime?.onInstalled?.addListener(() => {
  // Intentionally empty: first run needs no data. The theme choice lives in the popup's localStorage.
});
