export const DEFAULT_API_BASE: string;
export const FIREFOX_ID: string;
export const BROWSERS: string[];
export function baseManifest(version: string, apiBase?: string): Record<string, any>;
export function manifestFor(browser: string, version: string, apiBase?: string): Record<string, any>;
