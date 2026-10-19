/** Build-time constants. No secrets: the live API base is public, and the session is the user's own. */
declare const __API_BASE__: string | undefined;
const DEFAULT_API_BASE = "https://gendragoon-free-10068843866.us-central1.run.app";
/** Set at build time with GENDRAGOON_API_BASE; defaults to the live Cloud Run service. */
export const API_BASE = typeof __API_BASE__ === "string" && __API_BASE__ ? __API_BASE__ : DEFAULT_API_BASE;
export const SUPPORT_URL = "https://example.com/gendragoon/support"; // TODO(owner): real support URL before store submission
export const PRIVACY_URL = "https://example.com/gendragoon/privacy"; // TODO(owner): real privacy-policy URL before store submission
