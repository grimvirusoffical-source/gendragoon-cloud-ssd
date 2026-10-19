export const DEFAULT_API_BASE: string;
export const FIREFOX_ID: string;
export const BROWSERS: string[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function baseManifest(version: string, apiBase?: string, issuer?: string): Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function manifestFor(browser: string, version: string, apiBase?: string, issuer?: string): Record<string, any>;
