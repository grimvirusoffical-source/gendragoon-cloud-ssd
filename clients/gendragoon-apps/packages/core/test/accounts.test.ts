import { describe, expect, it } from "vitest";
import vectors from "./vectors/account-rules.json";
import {
  AccountsApiError,
  AccountsClient,
  TOS_GATE_START,
  TWO_FACTOR_OPTIONS,
  ageOn,
  beginSignIn,
  checkBirthDate,
  checkEmailFormat,
  checkPassword,
  checkPhone,
  checkUsername,
  completeSignIn,
  copyAcross,
  effectiveMinAge,
  emailKey,
  maskBirthDateInput,
  parseBirthDate,
  passwordRules,
  pkceChallenge,
  qrMatrix,
  qrSvgPath,
  reduceTosGate,
  scrolledToEnd,
  twoFactorOptionAvailable,
  usernameKey,
  usernameRules,
  validateSignup,
  normalizeRules,
  normalizeTerms,
  type SignupFields,
} from "../src/index.js";

const now = new Date(vectors.now);
const code = (c: { ok: boolean; code?: string }) => (c.ok ? "ok" : c.code);

describe("shared sign-up rules (same vectors as the backend)", () => {
  it("username", () => {
    for (const [v, want] of vectors.username) expect(code(checkUsername(v)), v).toBe(want);
    for (const [v, want] of vectors.usernameKey) expect(usernameKey(v!)).toBe(want);
  });
  it("password", () => {
    for (const [v, want] of vectors.password) expect(code(checkPassword(v)), v).toBe(want);
    for (const [n, want] of vectors.passwordLong) expect(code(checkPassword("Aa1!" + "a".repeat((n as number) - 4)))).toBe(want);
  });
  it("email", () => {
    for (const [v, want] of vectors.email) expect(code(checkEmailFormat(v)), v).toBe(want);
    for (const [v, want] of vectors.emailKey) expect(emailKey(v!)).toBe(want);
  });
  it("date of birth, age range and the minimum age of 13", () => {
    for (const [v, want] of vectors.dob) expect(code(checkBirthDate(v, { now })), v).toBe(want);
    for (const [v, want] of vectors.minAge) expect(effectiveMinAge(v as number)).toBe(want);
    // QA N3: a future date is out of range, as on the central service; a date that doesn't exist stays dob_invalid.
    expect(checkBirthDate("10/20/2026", { now })).toEqual({ ok: false, code: "dob_range" });
    expect(checkBirthDate("02/30/2001", { now })).toEqual({ ok: false, code: "dob_invalid" });
    expect(checkBirthDate("10/20/2013", { now, minAge: 0 })).toEqual({ ok: false, code: "under_min_age" });
  });
  it("phone", () => {
    for (const [v, want] of vectors.phone) expect(code(checkPhone(v))).toBe(want);
  });
  it("whole form", () => {
    for (const c of vectors.signup) {
      expect(validateSignup(c.fields as SignupFields, { now, requirePassword: c.requirePassword })).toEqual(c.errors);
    }
  });
});

describe("hints and inputs", () => {
  it("username and password hints report each requirement", () => {
    expect(usernameRules("ab").every((r) => !r.met || r.id === "chars" || r.id === "edges")).toBe(true);
    expect(usernameRules("dragon_rider").every((r) => r.met)).toBe(true);
    const p = passwordRules("Correct-Horse9");
    expect(p.map((r) => r.id)).toEqual(["length", "upper", "lower", "digit", "special", "chars"]);
    expect(p.every((r) => r.met)).toBe(true);
    expect(passwordRules("correct horse").filter((r) => !r.met).map((r) => r.id)).toEqual(["upper", "digit", "special", "chars"]);
  });
  it("date of birth can be typed digit by digit, and age is computed, not stored", () => {
    expect(maskBirthDateInput("0704")).toBe("07/04");
    expect(maskBirthDateInput("07042001999")).toBe("07/04/2001");
    expect(ageOn(parseBirthDate("07/04/2001")!, now)).toBe(25);
  });
  it("copy arrows copy a field into its confirm box and back", () => {
    expect(copyAcross("down", { value: "a@b.co", confirm: "" })).toEqual({ value: "a@b.co", confirm: "a@b.co" });
    expect(copyAcross("up", { value: "", confirm: "x@y.co" })).toEqual({ value: "x@y.co", confirm: "x@y.co" });
  });
  it("2FA options: Red-XAI Auth is listed but not available", () => {
    expect(TWO_FACTOR_OPTIONS.map((o) => o.method)).toEqual(["app", "phone", "redxai_auth", "none"]);
    expect(TWO_FACTOR_OPTIONS.find((o) => o.method === "redxai_auth")).toMatchObject({ available: false, detail: "Coming soon" });
  });
  it("2FA availability: Phone needs the server to say a text-message provider is configured", () => {
    const opt = (m: string) => TWO_FACTOR_OPTIONS.find((o) => o.method === m)!;
    expect(twoFactorOptionAvailable(opt("phone"), undefined)).toBe(false);
    expect(twoFactorOptionAvailable(opt("phone"), [{ method: "app", available: true }])).toBe(false);
    expect(twoFactorOptionAvailable(opt("phone"), [{ method: "phone", available: false }])).toBe(false);
    expect(twoFactorOptionAvailable(opt("phone"), [{ method: "phone", available: true }])).toBe(true);
    expect(twoFactorOptionAvailable(opt("app"), undefined)).toBe(true);
    expect(twoFactorOptionAvailable(opt("app"), [{ method: "app", available: false }])).toBe(false);
    expect(twoFactorOptionAvailable(opt("none"), null)).toBe(true);
    expect(twoFactorOptionAvailable(opt("redxai_auth"), [{ method: "redxai_auth", available: true }])).toBe(false);
  });
});

describe("Terms gate", () => {
  it("Read opens only after scrolling to the end; Agree only after Read", () => {
    let s = reduceTosGate(TOS_GATE_START, { type: "read" });
    expect(s.read).toBe(false);
    s = reduceTosGate(s, { type: "agree" });
    expect(s.agreed).toBe(false);
    s = reduceTosGate(s, { type: "scrolled_end" });
    s = reduceTosGate(s, { type: "agree" });
    expect(s.agreed).toBe(false);
    s = reduceTosGate(s, { type: "read" });
    s = reduceTosGate(s, { type: "agree" });
    expect(s).toEqual({ scrolledToEnd: true, read: true, agreed: true });
    expect(scrolledToEnd(598, 400, 1000)).toBe(true);
    expect(scrolledToEnd(500, 400, 1000)).toBe(false);
  });
});

describe("QR code for the authenticator app", () => {
  it("encodes the otpauth URI as a square module matrix with finder patterns", () => {
    const uri = "otpauth://totp/Gendragoon:dragon_rider?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Gendragoon&algorithm=SHA1&digits=6&period=30";
    const m = qrMatrix(uri);
    expect(m.length).toBeGreaterThanOrEqual(25);
    expect(m.every((row) => row.length === m.length)).toBe(true);
    for (const [r, c] of [[0, 0], [0, m.length - 7], [m.length - 7, 0]]) {
      expect(m[r!]![c!]).toBe(true);
      expect(m[r! + 1]![c! + 1]).toBe(false);
      expect(m[r! + 3]![c! + 3]).toBe(true);
    }
    const svg = qrSvgPath(uri);
    expect(svg.size).toBe(m.length + 8);
    expect(svg.path.split("M").length - 1).toBe(m.flat().filter(Boolean).length);
  });
});

describe("AccountsClient", () => {
  function recorder(responses: Array<{ status: number; body: unknown }>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = responses.shift()!;
      return { ok: r.status < 400, status: r.status, json: async () => r.body } as Response;
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }
  it("talks to the Gendragoon backend with the contract's shapes", async () => {
    const rec = recorder([{ status: 200, body: { grant: "g1", stage: "read", version: "v" } }, { status: 201, body: { account: {}, pending: ["2fa_setup"] } }]);
    const client = new AccountsClient({ baseUrl: "https://api.example/", fetchImpl: rec.fetchImpl });
    await client.markTermsRead("v");
    await client.signup({ username: "dragon_rider", email: "a@b.co", emailConfirm: "a@b.co", dob: "01/02/1990", twoFactor: "app", tosGrant: "g2" });
    expect(rec.calls[0]!.url).toBe("https://api.example/v1/accounts/tos/read");
    expect(JSON.parse(rec.calls[1]!.init.body as string)).toMatchObject({ tosGrant: "g2", dob: "01/02/1990" });
  });
  it("names the app when talking to Red-XAI Accounts directly, and surfaces error codes", async () => {
    const rec = recorder([{ status: 409, body: { error: "username_taken", field: "username" } }]);
    const client = new AccountsClient({ baseUrl: "https://accounts.red-xai.test", pathPrefix: "/v1", app: "gendragoon", fetchImpl: rec.fetchImpl });
    const error = await client.validateUsername("dragon_rider").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountsApiError);
    expect((error as AccountsApiError).code).toBe("username_taken");
    expect(rec.calls[0]!.url).toBe("https://accounts.red-xai.test/v1/validate/username");
    expect(JSON.parse(rec.calls[0]!.init.body as string)).toEqual({ app: "gendragoon", username: "dragon_rider" });
  });
});

describe("Red-XAI OIDC sign-in (PKCE S256)", () => {
  const config = { issuer: "https://accounts.red-xai.test", redirectUri: "http://127.0.0.1:53682/oauth2/callback" };
  it("builds the authorize URL with a S256 challenge of the verifier", async () => {
    const { url, pending } = await beginSignIn(config);
    const u = new URL(url);
    expect(u.pathname).toBe("/oauth2/authorize");
    expect(u.searchParams.get("client_id")).toBe("gendragoon");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe(await pkceChallenge(pending.codeVerifier));
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("refuses a wrong state, an error redirect, and an ID token for someone else", async () => {
    const { pending } = await beginSignIn(config);
    await expect(completeSignIn(config, pending, `${config.redirectUri}?code=c&state=wrong`)).rejects.toMatchObject({ code: "state_mismatch" });
    await expect(completeSignIn(config, pending, `${config.redirectUri}?error=access_denied&state=${pending.state}`)).rejects.toMatchObject({ code: "access_denied" });
    const jwt = (claims: object) => `e30.${btoa(JSON.stringify(claims)).replace(/=+$/, "")}.sig`;
    const fetchFor = (claims: object) => (async () => ({ ok: true, json: async () => ({ access_token: "at", id_token: jwt(claims), refresh_token: "rt", expires_in: 600 }) })) as unknown as typeof fetch;
    const good = { iss: config.issuer, aud: "gendragoon", nonce: pending.nonce };
    const tokens = await completeSignIn(config, pending, `${config.redirectUri}?code=c&state=${pending.state}`, { fetchImpl: fetchFor(good), now: 0 });
    expect(tokens).toMatchObject({ accessToken: "at", refreshToken: "rt", expiresAtMs: 600_000 });
    await expect(completeSignIn(config, pending, `${config.redirectUri}?code=c&state=${pending.state}`, { fetchImpl: fetchFor({ ...good, nonce: "x" }) })).rejects.toMatchObject({ code: "id_token_nonce" });
    await expect(completeSignIn(config, pending, `${config.redirectUri}?code=c&state=${pending.state}`, { fetchImpl: fetchFor({ ...good, aud: "rotten-apple" }) })).rejects.toMatchObject({ code: "id_token_audience" });
  });
});

describe("Red-XAI Accounts v1.1 shapes", () => {
  it("2FA rules from {id, enabled, note} and from the transitional {method, available}", () => {
    const v11 = normalizeRules({ minAge: 13, centralMinAge: 13, twoFactor: [{ id: "phone", enabled: true }, { id: "redxai_auth", enabled: false, note: "Coming soon" }] });
    expect(v11.twoFactor).toEqual([{ method: "phone", available: true, label: undefined }, { method: "redxai_auth", available: false, label: "Coming soon" }]);
    expect(normalizeRules({ appMinAge: 16, twoFactor: [{ method: "app", available: true }] })).toMatchObject({ minAge: 16, twoFactor: [{ method: "app", available: true }] });
  });
  it("Terms: central then Gendragoon in one scroll text, editor comment removed, app version kept", () => {
    const t = normalizeTerms({ version: "rxa-1", title: "Red-XAI", text: "Central.", appVersion: "gendragoon-tos-2026-10-19", appTitle: "Gendragoon", appText: "<!--\nDraft\n-->\n# Gendragoon\n\nApp." });
    expect(t.text).toBe("Central.\n\n# Gendragoon\n\nApp.");
    expect(t).toMatchObject({ version: "rxa-1", appVersion: "gendragoon-tos-2026-10-19" });
    expect(normalizeTerms({ version: "gendragoon-tos-2026-10-19", text: "<!-- x -->Only." }).text).toBe("Only.");
  });
  it("email_unverifiable (503) and rate limits are retryable; rule failures are not", () => {
    expect(new AccountsApiError(503, "email_unverifiable", "email").retryable).toBe(true);
    expect(new AccountsApiError(429, "rate_limited").retryable).toBe(true);
    expect(new AccountsApiError(400, "username_edges", "username").retryable).toBe(false);
  });
});
