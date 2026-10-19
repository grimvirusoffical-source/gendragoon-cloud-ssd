import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountsClient } from "@gendragoon/core";
import { RedXaiSession, type SessionStore } from "../src/main/redxai-session.js";
import { startRedXaiMock, type RedXaiMock } from "../../../packages/core/test/redxai-mock.js";

let mock: RedXaiMock;
let clock = Date.parse("2026-10-19T12:00:00Z");
beforeAll(async () => { mock = await startRedXaiMock({ now: () => clock }); });
afterAll(async () => { await mock.close(); });

function memoryStore(): SessionStore & { value: string | null } {
  return { value: null, async read() { return this.value; }, async write(v) { this.value = v; }, async clear() { this.value = null; } };
}
// Plays the system browser: follows the authorize redirect to the loopback listener.
const browser = async (url: string) => { await fetch(url); };
const ADULT = { sub: "acct_desktop", username: "dragon_rider", email: "josh@example.com", dob: "07/04/2001", twoFactor: "app" as const, amr: ["pwd", "otp"] };

describe("desktop Red-XAI Account session", () => {
  it("signs in through the loopback redirect and keeps only the refresh token", async () => {
    mock.signInAs(ADULT);
    const store = memoryStore();
    const opened: string[] = [];
    const session = new RedXaiSession({ issuer: mock.issuer, store, now: () => clock, openExternal: async (url) => { opened.push(url); await browser(url); } });
    expect(await session.accessToken()).toBeUndefined();
    await session.signIn("sign-up");
    const authorize = new URL(opened[0]!);
    expect(authorize.searchParams.get("screen_hint")).toBe("signup");
    // Registered as http://127.0.0.1/oauth2/callback for any port; /callback would be refused.
    expect(authorize.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2\/callback$/);
    const token = await session.accessToken();
    expect(JSON.parse(Buffer.from(token!.split(".")[1]!, "base64url").toString())).toMatchObject({ sub: "acct_desktop", aud: "gendragoon" });
    expect(store.value).toMatch(/^rxa_r_/);
  });

  it("refreshes near expiry, rotates the stored token, and a restarted app resumes from the keychain", async () => {
    mock.signInAs(ADULT);
    const store = memoryStore();
    const session = new RedXaiSession({ issuer: mock.issuer, store, now: () => clock, openExternal: browser });
    await session.signIn();
    const first = store.value;
    clock += 9.5 * 60_000;
    expect(await session.accessToken()).toBeTruthy();
    expect(store.value).not.toBe(first);
    const restarted = new RedXaiSession({ issuer: mock.issuer, store, now: () => clock, openExternal: browser });
    expect(await restarted.accessToken()).toBeTruthy();
  });

  it("a refused refresh signs out; under-13 sign-in fails", async () => {
    const store = memoryStore();
    store.value = "rxa_r_revoked";
    const session = new RedXaiSession({ issuer: mock.issuer, store, now: () => clock, openExternal: browser });
    expect(await session.accessToken()).toBeUndefined();
    expect(store.value).toBeNull();
    mock.signInAs({ ...ADULT, sub: "acct_kid", dob: "10/20/2013" });
    await expect(session.signIn()).rejects.toMatchObject({ code: "access_denied" });
  });

  it("adopts an in-app sign-up session with the session grant (single use), no browser", async () => {
    const c = new AccountsClient({ baseUrl: mock.issuer, pathPrefix: "/v1", app: "gendragoon" });
    const terms = await c.terms();
    const tosGrant = (await c.agreeToTerms((await c.markTermsRead(terms.version, terms.appVersion)).grant)).grant;
    const created = await c.signup({ username: "desk_newbie", email: "desk@gendragoon-test.dev", emailConfirm: "desk@gendragoon-test.dev", password: "Dragon-Rider-2026!", passwordConfirm: "Dragon-Rider-2026!",
      dob: "07/04/2001", twoFactor: "none", acceptNo2faRisk: true, acknowledgeFalseInfo: true, tosGrant });
    const store = memoryStore();
    const opened: string[] = [];
    const session = new RedXaiSession({ issuer: mock.issuer, store, now: () => clock, openExternal: async (url) => { opened.push(url); } });
    await session.adoptSession(created.session!);
    expect(opened).toEqual([]);
    expect(await session.accessToken()).toBeTruthy();
    expect(session.appTosVersion()).toBe(terms.appVersion);
    expect(store.value).toMatch(/^rxa_r_/);
    await expect(new RedXaiSession({ issuer: mock.issuer, store: memoryStore(), now: () => clock, openExternal: browser }).adoptSession(created.session!)).rejects.toMatchObject({ code: "invalid_grant" });
  });
});
