import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountsApiError, AccountsClient, beginSignIn, completeSignIn, refreshTokens, REDXAI_SCOPES, OidcError } from "../src/index.js";
import { startRedXaiMock, type RedXaiMock } from "./redxai-mock.js";

let mock: RedXaiMock;
beforeAll(async () => { mock = await startRedXaiMock({ now: () => Date.parse("2026-10-19T12:00:00Z") }); });
afterAll(async () => { await mock.close(); });

const ADULT = { sub: "acct_adult", username: "dragon_rider", email: "josh@example.com", dob: "07/04/2001", twoFactor: "app" as const, amr: ["pwd", "otp"] };
const redirectUri = "http://127.0.0.1:51789/callback";

async function authorize(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "manual" });
  expect(res.status).toBe(302);
  return res.headers.get("location")!;
}

describe("Red-XAI Accounts v1 contract (local mock)", () => {
  it("requests the contract scopes with PKCE S256", async () => {
    expect(REDXAI_SCOPES).toBe("openid profile email");
    const { url } = await beginSignIn({ issuer: mock.issuer, redirectUri });
    const p = new URL(url).searchParams;
    expect(new URL(url).pathname).toBe("/oauth2/authorize");
    expect(Object.fromEntries(p)).toMatchObject({ response_type: "code", client_id: "gendragoon", scope: "openid profile email", code_challenge_method: "S256" });
  });

  it("signs in: code + verifier for tokens, ID token claims as in the contract, refresh rotation", async () => {
    mock.signInAs(ADULT);
    const config = { issuer: mock.issuer, redirectUri };
    const { url, pending } = await beginSignIn(config);
    const tokens = await completeSignIn(config, pending, await authorize(url));
    const claims = JSON.parse(Buffer.from(tokens.idToken.split(".")[1]!, "base64url").toString());
    expect(claims).toMatchObject({ iss: mock.issuer, aud: "gendragoon", sub: "acct_adult", nonce: pending.nonce, preferred_username: "dragon_rider", age_band: "18plus", email_verified: true, amr: ["pwd", "otp"] });
    for (const key of ["auth_time", "sid"]) expect(claims).toHaveProperty(key);
    const access = JSON.parse(Buffer.from(tokens.accessToken.split(".")[1]!, "base64url").toString());
    expect(Object.keys(access).sort()).toEqual(["aud", "client_id", "exp", "iat", "iss", "scope", "sid", "sub"]);
    expect(tokens.refreshToken).toMatch(/^rxa_r_/);

    const rotated = await refreshTokens(config, tokens.refreshToken!);
    expect(rotated.refreshToken).not.toBe(tokens.refreshToken);
    // Reusing the old refresh token revokes the whole family.
    await expect(refreshTokens(config, tokens.refreshToken!)).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(refreshTokens(config, rotated.refreshToken!)).rejects.toBeInstanceOf(OidcError);
  });

  it("an under-13 account comes back with error=access_denied", async () => {
    mock.signInAs({ ...ADULT, sub: "acct_child", username: "young_rider", dob: "10/20/2013" });
    const config = { issuer: mock.issuer, redirectUri };
    const { url, pending } = await beginSignIn(config);
    await expect(completeSignIn(config, pending, await authorize(url))).rejects.toMatchObject({ code: "access_denied" });
  });

  it("a code is bound to its verifier", async () => {
    mock.signInAs(ADULT);
    const config = { issuer: mock.issuer, redirectUri };
    const a = await beginSignIn(config);
    const b = await beginSignIn(config);
    const redirect = (await authorize(a.url)).replace(`state=${a.pending.state}`, `state=${b.pending.state}`);
    await expect(completeSignIn(config, b.pending, redirect)).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("the accounts client speaks /v1 with app=gendragoon: rules, Terms read → agree, sign-up, /v1/me", async () => {
    let session = "";
    const client = new AccountsClient({ baseUrl: mock.issuer, pathPrefix: "/v1", app: "gendragoon", getToken: async () => session });
    expect((await client.rules()).minAge).toBe(13);
    const terms = await client.terms();
    expect(terms).toMatchObject({ version: "gendragoon-tos-2026-10-19", privacyVersion: "privacy-1" });
    const read = await client.markTermsRead(terms.version);
    expect(read).toMatchObject({ stage: "read" });
    expect(read.grant).toMatch(/^rxa_t_/);
    const agreed = await client.agreeToTerms(read.grant);
    expect(agreed.stage).toBe("agreed");
    const fields = { username: "night_glider", email: "glider@example.com", emailConfirm: "glider@example.com", password: "Correct-Horse9", passwordConfirm: "Correct-Horse9",
      dob: "02/29/2004", twoFactor: "app" as const, acceptNo2faRisk: false, acknowledgeFalseInfo: true };
    const created = await client.signup({ ...fields, tosGrant: agreed.grant });
    expect(created.session).toMatch(/^rxa_s_/);
    expect(created.pending).toEqual(["2fa_setup"]);
    expect(created.totp?.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(created.account).not.toHaveProperty("dob");
    session = created.session!;
    expect(await client.me()).toMatchObject({ username: "night_glider", tosVersion: "gendragoon-tos-2026-10-19", twoFactorState: "pending" });
    // The grant was spent.
    await expect(client.signup({ ...fields, username: "night_glider2", tosGrant: agreed.grant })).rejects.toMatchObject({ code: "tos_grant_invalid" });
    expect((await client.validateUsername("Night_Glider")).error).toBe("username_taken");
  });

  it("under 13 is refused centrally with 403 under_min_age, and Gendragoon's own check agrees", async () => {
    const client = new AccountsClient({ baseUrl: mock.issuer, pathPrefix: "/v1", app: "gendragoon" });
    const dob = await client.validateDob("10/20/2013");
    expect(dob).toMatchObject({ ok: false, error: "under_min_age", minAge: 13 });
    const { grant } = await client.agreeToTerms((await client.markTermsRead("gendragoon-tos-2026-10-19")).grant);
    const err = await client.signup({ username: "young_rider", email: "y@example.com", emailConfirm: "y@example.com", password: "Correct-Horse9", passwordConfirm: "Correct-Horse9",
      dob: "10/20/2013", twoFactor: "none", acceptNo2faRisk: true, acknowledgeFalseInfo: true, tosGrant: grant }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountsApiError);
    expect(err).toMatchObject({ status: 403, code: "under_min_age" });
  });
});
