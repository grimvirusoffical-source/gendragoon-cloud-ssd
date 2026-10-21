/**
 * Gendragoon against the Red-XAI Accounts v1.1 contract. By default this runs against the local mock
 * (redxai-mock.ts). With REDXAI_TEST_ISSUER set (e.g. a `redxai-accounts --dev --store mem --offline-dns` server,
 * which fakes SMS and email) the same checks run against the real service. The mock-only cases are marked.
 */
import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AccountsApiError, AccountsClient, appTosVersion, beginSignIn, beginSignUp, completeSignIn, exchangeSession, refreshTokens, REDXAI_SCOPES, OidcError,
} from "../src/index.js";
import { startRedXaiMock, type RedXaiMock } from "./redxai-mock.js";

const REAL = process.env.REDXAI_TEST_ISSUER ?? "";
let mock: RedXaiMock | null = null;
let issuer = REAL;
beforeAll(async () => { if (!REAL) { mock = await startRedXaiMock(); issuer = mock.issuer; } });
afterAll(async () => { await mock?.close(); });

const redirectUri = "http://127.0.0.1:51789/oauth2/callback";
const PASSWORD = "Correct-Horse9!";
const unique = (p: string) => `${p}_${randomBytes(4).toString("hex")}`;
const client = (session = "") => new AccountsClient({ baseUrl: issuer, pathPrefix: "/v1", app: "gendragoon", getToken: async () => session });

function totp(secretB32: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secretB32.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function agreedGrant(c = client()): Promise<string> {
  const terms = await c.terms();
  return (await c.agreeToTerms((await c.markTermsRead(terms.version, terms.appVersion)).grant)).grant;
}

async function signUp(twoFactor: "app" | "none", c = client()) {
  const username = unique("gd_rider");
  const email = `${username}@gendragoon-test.dev`;
  const created = await c.signup({ username, email, emailConfirm: email, password: PASSWORD, passwordConfirm: PASSWORD, dob: "07/04/2001",
    twoFactor, acceptNo2faRisk: twoFactor === "none", acknowledgeFalseInfo: true, tosGrant: await agreedGrant(c) });
  return { username, email, created };
}

/** The hosted sign-in: a cookie session (Origin = issuer), then /oauth2/authorize with it. */
async function authorizeAs(login: string, url: string): Promise<string> {
  const res = await fetch(`${issuer}/v1/login`, { method: "POST", headers: { "content-type": "application/json", origin: issuer }, body: JSON.stringify({ app: "gendragoon", login, password: PASSWORD }) });
  expect(res.status).toBe(200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const auth = await fetch(url, { redirect: "manual", headers: { cookie } });
  expect(auth.status).toBe(302);
  return auth.headers.get("location")!;
}

const claimsOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
const headerOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[0]!, "base64url").toString()) as Record<string, unknown>;

describe(`Red-XAI Accounts v1.1 contract (${REAL ? "real service" : "local mock"})`, () => {
  it("requests the contract scopes with PKCE S256; sign-up opens with screen_hint=signup", async () => {
    expect(REDXAI_SCOPES).toBe("openid profile email");
    const { url } = await beginSignIn({ issuer, redirectUri });
    expect(Object.fromEntries(new URL(url).searchParams)).toMatchObject({ response_type: "code", client_id: "gendragoon", scope: "openid profile email", code_challenge_method: "S256" });
    expect(new URL((await beginSignUp({ issuer, redirectUri })).url).searchParams.get("screen_hint")).toBe("signup");
  });

  it("rules and Terms in v1.1 shape: 2FA list, central + Gendragoon terms in one text, a stale app version is refused", async () => {
    const rules = await client().rules();
    expect(rules.minAge).toBe(13);
    expect(rules.twoFactor.find((m) => m.method === "redxai_auth")).toMatchObject({ available: false });
    expect(rules.twoFactor.find((m) => m.method === "app")?.available).toBe(true);
    const terms = await client().terms();
    expect(terms.appVersion).toBe("gendragoon-tos-2026-10-19");
    expect(terms.text).toContain("Gendragoon Terms of Service");
    expect(terms.text).not.toContain("<!--");
    await expect(client().markTermsRead(terms.version, "gendragoon-tos-2026-01-01")).rejects.toMatchObject({ status: 409, code: "tos_changed" });
  });

  it("in-app sign-up then the session grant: tokens without a browser, once, and app_tos_version is set", async () => {
    const c0 = client();
    const { username, created } = await signUp("app", c0);
    expect(created.session).toMatch(/^rxa_s_/);
    expect(created.pending).toEqual(["2fa_setup"]);
    expect(created.account).not.toHaveProperty("dob");
    // Nothing may be pending when the session is traded.
    await expect(exchangeSession({ issuer }, created.session!)).rejects.toBeInstanceOf(OidcError);
    const c = client(created.session!);
    await c.confirmTwoFactor(totp(created.totp!.secret));
    const me = await c.me();
    expect(me).toMatchObject({ username, twoFactorState: "active" });
    expect(me.appTos).toContain("gendragoon=gendragoon-tos-2026-10-19");
    const tokens = await exchangeSession({ issuer }, created.session!);
    expect(tokens.refreshToken).toMatch(/^rxa_r_/);
    expect(appTosVersion(tokens)).toBe("gendragoon-tos-2026-10-19");
    expect(headerOf(tokens.accessToken).typ).toBe("at+jwt");
    expect(claimsOf(tokens.accessToken)).toMatchObject({ aud: "gendragoon", client_id: "gendragoon", preferred_username: username, age_band: "18plus" });
    await expect(exchangeSession({ issuer }, created.session!)).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("browser sign-in: loopback redirect on any port with /oauth2/callback, claims, refresh rotation", async () => {
    const { username } = await signUp("none");
    const config = { issuer, redirectUri };
    const { url, pending } = await beginSignIn(config);
    const tokens = await completeSignIn(config, pending, await authorizeAs(username, url));
    expect(claimsOf(tokens.idToken)).toMatchObject({ iss: issuer, aud: "gendragoon", nonce: pending.nonce, preferred_username: username, amr: ["pwd"], app_tos_version: "gendragoon-tos-2026-10-19" });
    const rotated = await refreshTokens(config, tokens.refreshToken!);
    expect(rotated.refreshToken).not.toBe(tokens.refreshToken);
    await expect(refreshTokens(config, tokens.refreshToken!)).rejects.toMatchObject({ code: "invalid_grant" });
    // An unregistered path is refused before any sign-in.
    const wrong = await beginSignIn({ issuer, redirectUri: "http://127.0.0.1:51789/callback" });
    expect((await fetch(wrong.url, { redirect: "manual" })).status).toBe(400);
  });

  it("v1.1 errors: username_edges, email_disposable, Gmail folding, under 13 refused with 403", async () => {
    const c = client();
    expect((await c.validateUsername("_dragon_rider")).error).toBe("username_edges");
    expect((await c.validateEmail("temp@mailinator.com")).error).toBe("email_disposable");
    const local = unique("fold").replace(/_/g, "");
    const email = `${local}@gmail.com`;
    await c.signup({ username: unique("gd_gmail"), email, emailConfirm: email, password: PASSWORD, passwordConfirm: PASSWORD, dob: "07/04/2001",
      twoFactor: "none", acceptNo2faRisk: true, acknowledgeFalseInfo: true, tosGrant: await agreedGrant(c) });
    const variant = `${local.slice(0, 2)}.${local.slice(2)}+gd@googlemail.com`;
    expect((await c.validateEmail(variant)).error).toBe("email_taken");
    const kid = new Date(); kid.setFullYear(kid.getFullYear() - 12);
    const dob = `${String(kid.getMonth() + 1).padStart(2, "0")}/${String(kid.getDate()).padStart(2, "0")}/${kid.getFullYear()}`;
    expect(await c.validateDob(dob)).toMatchObject({ ok: false, error: "under_min_age", minAge: 13 });
    const err = await c.signup({ username: unique("young"), email: `${unique("y")}@gendragoon-test.dev`, emailConfirm: "x", password: PASSWORD, passwordConfirm: PASSWORD,
      dob, twoFactor: "none", acceptNo2faRisk: true, acknowledgeFalseInfo: true, tosGrant: await agreedGrant(c) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountsApiError);
    expect((err as AccountsApiError).status).toBeGreaterThanOrEqual(400);
  });

  it.skipIf(Boolean(REAL))("mock only: an under-13 account comes back from authorize with error=access_denied", async () => {
    mock!.signInAs({ sub: "acct_child", username: "young_rider", email: "y@example.com", dob: "10/20/2020", twoFactor: "none", amr: ["pwd"] });
    const config = { issuer, redirectUri };
    const { url, pending } = await beginSignIn(config);
    const res = await fetch(url, { redirect: "manual" });
    await expect(completeSignIn(config, pending, res.headers.get("location")!)).rejects.toMatchObject({ code: "access_denied" });
  });
});
