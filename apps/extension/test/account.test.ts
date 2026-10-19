import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signIn, signOut, status, type ExtensionAuthDeps } from "../src/account";
import { manifestFor } from "../scripts/manifests.mjs";
import { startRedXaiMock, type RedXaiMock } from "../../../packages/core/test/redxai-mock";

let mock: RedXaiMock;
let clock = Date.parse("2026-10-19T12:00:00Z");
beforeAll(async () => { mock = await startRedXaiMock({ now: () => clock }); });
afterAll(async () => { await mock.close(); });

const API = "https://gendragoon.test";
function deps(me: () => Response): ExtensionAuthDeps & { stored: Map<string, unknown>; launched: string[] } {
  const stored = new Map<string, unknown>();
  const launched: string[] = [];
  return {
    stored, launched,
    issuer: mock.issuer, apiBase: API, redirectUri: "https://abcdefghijklmnop.chromiumapp.org/oauth2", now: () => clock,
    // Plays the browser's web auth flow: the mock's authorize answers with the redirect straight away.
    launchWebAuthFlow: async (url) => { launched.push(url); return (await fetch(url, { redirect: "manual" })).headers.get("location")!; },
    storage: { get: async (k) => stored.get(k), set: async (k, v) => { stored.set(k, v); }, remove: async (k) => { stored.delete(k); } },
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.startsWith(API)) {
        expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer ey/);
        return me();
      }
      return fetch(input, init);
    },
  };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ADULT = { sub: "acct_ext", username: "dragon_rider", email: "josh@example.com", dob: "07/04/2001", twoFactor: "app" as const, amr: ["pwd", "otp"] };

describe("extension Red-XAI Account sign-in", () => {
  it("Create account opens the hosted sign-up page; a ready Gendragoon account shows the username", async () => {
    mock.signInAs(ADULT);
    const d = deps(() => json(200, { username: "dragon_rider", pending: [] }));
    expect(await status(d)).toEqual({ state: "signed-out" });
    expect(await signIn(d, "sign-up")).toEqual({ state: "ready", username: "dragon_rider" });
    const params = new URL(d.launched[0]!).searchParams;
    expect(params.get("prompt")).toBe("create");
    expect(params.get("redirect_uri")).toBe("https://abcdefghijklmnop.chromiumapp.org/oauth2");
    await signOut(d);
    expect(await status(d)).toEqual({ state: "signed-out" });
  });

  it("Gendragoon-side setup still applies (Terms, account details)", async () => {
    mock.signInAs(ADULT);
    const d = deps(() => json(404, { error: "account_setup_required", pending: ["account_setup"] }));
    expect(await signIn(d, "sign-in")).toEqual({ state: "needs-setup", reason: "account_setup_required" });
    const t = deps(() => json(403, { error: "tos_required", pending: ["tos"] }));
    expect(await signIn(t, "sign-in")).toEqual({ state: "needs-setup", reason: "tos_required" });
  });

  it("refreshes an expired access token and drops a refused one", async () => {
    mock.signInAs(ADULT);
    const d = deps(() => json(200, { username: "dragon_rider", pending: [] }));
    await signIn(d, "sign-in");
    clock += 11 * 60_000;
    expect((await status(d)).state).toBe("ready");
    d.stored.set("redxaiSession", { accessToken: "x", idToken: "", refreshToken: "rxa_r_bogus", expiresAtMs: 0, scope: "" });
    expect(await status(d)).toEqual({ state: "signed-out" });
    expect(d.stored.has("redxaiSession")).toBe(false);
  });

  it("an under-13 sign-in is refused", async () => {
    mock.signInAs({ ...ADULT, sub: "acct_kid", dob: "10/20/2013" });
    await expect(signIn(deps(() => json(200, {})), "sign-in")).rejects.toMatchObject({ code: "access_denied" });
  });

  it("sign-in builds add identity and storage and the issuer host; other builds add nothing", () => {
    const plain = manifestFor("chrome", "1.0.0", API);
    expect(plain.permissions).toEqual([]);
    const withSignIn = manifestFor("chrome", "1.0.0", API, "https://accounts.red-xai.example");
    expect(withSignIn.permissions).toEqual(["identity", "storage"]);
    expect(withSignIn.host_permissions).toEqual([`${API}/*`, "https://accounts.red-xai.example/*"]);
    expect(manifestFor("firefox", "1.0.0", API, "https://accounts.red-xai.example").browser_specific_settings.gecko.data_collection_permissions).toEqual({ required: ["authenticationInfo"] });
  });
});
