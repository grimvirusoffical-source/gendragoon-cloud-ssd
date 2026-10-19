/**
 * A local stand-in for Red-XAI Accounts, implementing the parts of the v1.1
 * contract (red-xai-accounts docs/API.md, 078473a) that Gendragoon uses:
 * discovery, JWKS, authorize (registered redirects, loopback on any port) +
 * token (PKCE S256, rotating refresh tokens, the session grant), and the /v1
 * rules, Terms (central + app), validation, sign-up, resend-sms, 2FA confirm
 * and /v1/me endpoints, with v1.1 response shapes. Tests only; ES256 keys are
 * made at start-up. redxai-contract.test.ts runs the same checks against the
 * real service when REDXAI_TEST_ISSUER is set.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ageOn, checkBirthDate, checkEmailFormat, checkPassword, checkUsername, effectiveMinAge, emailKey, parseBirthDate, usernameKey, validateSignup, type SignupFields } from "../src/accounts/rules.js";

export interface MockAccount {
  sub: string;
  username: string;
  email: string;
  dob: string;
  twoFactor: "app" | "phone" | "none";
  amr: string[];
  password?: string;
}

/** The fixed TOTP secret the mock hands out (RFC 6238 test-style key). */
export const MOCK_TOTP_SECRET = "JBSWY3DPEHPK3PXP";
const DISPOSABLE = new Set(["mailinator.com", "10minutemail.com", "guerrillamail.com", "yopmail.com"]);

export interface RedXaiMock {
  issuer: string;
  close(): Promise<void>;
  /** The account the hosted sign-in page "signs in" next. */
  signInAs(account: MockAccount): void;
  apps: Map<string, { minAge: number; redirectUris: string[] }>;
  accounts: Map<string, MockAccount & { tosVersion: string }>;
  refreshFamiliesRevoked: Set<string>;
  now: () => number;
}

const TOS_VERSION = "rxa-tos-2026-10-19-draft1";
const APP_TOS_VERSION = "gendragoon-tos-2026-10-19";
const b64u = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function jwt(key: KeyObject, kid: string, claims: Record<string, unknown>, typ = "JWT"): string {
  const head = b64u(Buffer.from(JSON.stringify({ alg: "ES256", typ, kid })));
  const body = b64u(Buffer.from(JSON.stringify(claims)));
  const sig = createSign("SHA256").update(`${head}.${body}`).sign({ key, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64u(sig)}`;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  if ((req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
  return JSON.parse(raw) as Record<string, unknown>;
}

const ageBand = (dob: string, now: number) => {
  const parsed = parseBirthDate(dob);
  return parsed && ageOn(parsed, new Date(now)) >= 18 ? "18plus" : "13to17";
};

export async function startRedXaiMock(options: { now?: () => number; redirects?: string[] } = {}): Promise<RedXaiMock> {
  const now = options.now ?? Date.now;
  const registered = options.redirects ?? ["gendragoon://oauth2/callback", "https://abcdefghijklmnop.chromiumapp.org/oauth2"];
  // v1.1: exact match, except the registered loopback http://127.0.0.1/oauth2/callback matches any port.
  const redirectAllowed = (uri: string) => {
    if (registered.includes(uri)) return true;
    try { const u = new URL(uri); return u.protocol === "http:" && u.hostname === "127.0.0.1" && u.pathname === "/oauth2/callback" && !u.search; } catch { return false; }
  };
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const kid = b64u(randomBytes(8));
  const apps = new Map([["gendragoon", { minAge: 13, redirectUris: [] as string[] }]]);
  const accounts = new Map<string, MockAccount & { tosVersion: string }>();
  const codes = new Map<string, { app: string; sub: string; redirectUri: string; nonce: string; challenge: string; scope: string; used: boolean }>();
  const refresh = new Map<string, { family: string; sub: string; app: string; scope: string; used: boolean }>();
  const refreshFamiliesRevoked = new Set<string>();
  const grants = new Map<string, { stage: "read" | "agreed"; version: string; used: boolean; expiresMs: number }>();
  const sessions = new Map<string, { sub: string; createdMs: number; exchanged: boolean }>();
  const cookieSessions = new Map<string, string>();
  const twoFactorPending = new Set<string>();
  let next: MockAccount | null = null;
  let issuer = "";

  const issue = (sub: string, app: string, scope: string, nonce?: string) => {
    const account = accounts.get(sub)!;
    const sid = b64u(randomBytes(8));
    const iat = Math.floor(now() / 1000);
    const family = b64u(randomBytes(8));
    const refreshToken = `rxa_r_${b64u(randomBytes(24))}`;
    refresh.set(refreshToken, { family, sub, app, scope, used: false });
    return {
      access_token: jwt(privateKey, kid, {
        iss: issuer, sub, aud: app, scope, sid, client_id: app, iat, exp: iat + 600, jti: b64u(randomBytes(8)), auth_time: iat, amr: account.amr,
        preferred_username: account.username, age_band: ageBand(account.dob, now()), adult_verified: false, email: account.email, email_verified: true,
        app_tos_version: APP_TOS_VERSION,
      }, "at+jwt"),
      token_type: "Bearer",
      expires_in: 600,
      id_token: jwt(privateKey, kid, {
        iss: issuer, sub, aud: app, iat, exp: iat + 600, nonce, auth_time: iat, amr: account.amr, sid,
        preferred_username: account.username, age_band: ageBand(account.dob, now()), adult_verified: false,
        email: account.email, email_verified: true, app_tos_version: APP_TOS_VERSION,
      }),
      refresh_token: refreshToken,
      scope,
    };
  };

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    const body = req.method === "POST" ? await readBody(req) : {};
    const app = String(body.app ?? url.searchParams.get("app") ?? "");
    try {
      switch (`${req.method} ${url.pathname}`) {
        case "GET /.well-known/openid-configuration":
          return send(res, 200, {
            issuer, authorization_endpoint: `${issuer}/oauth2/authorize`, token_endpoint: `${issuer}/oauth2/token`,
            jwks_uri: `${issuer}/oauth2/jwks`, userinfo_endpoint: `${issuer}/oauth2/userinfo`, revocation_endpoint: `${issuer}/oauth2/revoke`,
            code_challenge_methods_supported: ["S256"], id_token_signing_alg_values_supported: ["ES256"], scopes_supported: ["openid", "profile", "email"],
          });
        case "GET /oauth2/jwks":
          return send(res, 200, { keys: [{ ...(publicKey.export({ format: "jwk" }) as object), kid, alg: "ES256", use: "sig" }] });
        case "GET /oauth2/authorize": {
          const p = url.searchParams;
          const client = apps.get(p.get("client_id") ?? "");
          const redirect = p.get("redirect_uri") ?? "";
          if (!client || p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) {
            return send(res, 400, { error: "invalid_request" });
          }
          if (!redirectAllowed(redirect)) return send(res, 400, { error: "invalid_request", message: "redirect_uri is not registered for this app" });
          const back = new URL(redirect);
          back.searchParams.set("state", p.get("state") ?? "");
          back.searchParams.set("iss", issuer);
          const cookie = /(?:^|;\s*)rxa_session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
          const cookieSub = cookie ? cookieSessions.get(cookie) : undefined;
          const who = cookieSub ? accounts.get(cookieSub)! : next;
          if (!who) back.searchParams.set("error", "login_required");
          else {
            const parsed = parseBirthDate(who.dob)!;
            if (ageOn(parsed, new Date(now())) < Math.max(13, client.minAge)) back.searchParams.set("error", "access_denied");
            else {
              if (!cookieSub) accounts.set(who.sub, { ...who, tosVersion: TOS_VERSION });
              const code = b64u(randomBytes(16));
              codes.set(code, { app: p.get("client_id")!, sub: who.sub, redirectUri: redirect, nonce: p.get("nonce") ?? "", challenge: p.get("code_challenge")!, scope: p.get("scope") ?? "openid", used: false });
              back.searchParams.set("code", code);
            }
          }
          res.writeHead(302, { location: back.toString() }).end();
          return;
        }
        case "POST /oauth2/token": {
          if (body.grant_type === "authorization_code") {
            const entry = codes.get(String(body.code));
            const verifier = String(body.code_verifier ?? "");
            if (!entry || entry.used || entry.app !== body.client_id || entry.redirectUri !== body.redirect_uri) return send(res, 400, { error: "invalid_grant" });
            if (b64u(createHash("sha256").update(verifier).digest()) !== entry.challenge) return send(res, 400, { error: "invalid_grant" });
            entry.used = true;
            return send(res, 200, issue(entry.sub, entry.app, entry.scope, entry.nonce));
          }
          if (body.grant_type === "refresh_token") {
            const entry = refresh.get(String(body.refresh_token));
            if (!entry || entry.app !== body.client_id || refreshFamiliesRevoked.has(entry.family)) return send(res, 400, { error: "invalid_grant" });
            if (entry.used) {
              refreshFamiliesRevoked.add(entry.family);
              return send(res, 400, { error: "invalid_grant" });
            }
            entry.used = true;
            const out = issue(entry.sub, entry.app, entry.scope);
            refresh.get(out.refresh_token)!.family = entry.family;
            delete (out as Partial<typeof out>).id_token;
            return send(res, 200, out);
          }
          if (body.grant_type === "urn:red-xai:grant-type:session") {
            if (!String(body.scope ?? "").split(" ").includes("openid")) return send(res, 400, { error: "invalid_scope" });
            if (body.client_id !== "gendragoon") return send(res, 400, { error: "unauthorized_client" });
            const entry = sessions.get(String(body.subject_token));
            if (!entry || entry.exchanged || now() - entry.createdMs > 10 * 60_000 || pendingOf(entry.sub).length) return send(res, 400, { error: "invalid_grant" });
            entry.exchanged = true;
            return send(res, 200, issue(entry.sub, "gendragoon", String(body.scope)));
          }
          return send(res, 400, { error: "unsupported_grant_type" });
        }
        case "GET /v1/rules":
          return send(res, 200, { minAge: effectiveMinAge(apps.get(app)?.minAge), appMinAge: effectiveMinAge(apps.get(app)?.minAge), centralMinAge: 13,
            app: { id: app, name: "Gendragoon" }, falseInfoWarning: "Enter true information.", no2faWarning: "Without 2FA…",
            twoFactor: [{ id: "phone", enabled: true, label: "Phone (SMS)" }, { id: "app", enabled: true, label: "Authenticator app" },
              { id: "redxai_auth", enabled: false, label: "Red-XAI Auth", note: "Coming soon" }, { id: "none", enabled: true, label: "No 2FA" }] });
        case "GET /v1/tos":
          return send(res, 200, { version: TOS_VERSION, title: "Red-XAI Accounts Terms of Service", text: "# Red-XAI Terms\n\nCentral terms.", privacyVersion: "rxa-privacy-1", privacyText: "Privacy.",
            app, appName: "Gendragoon", appVersion: APP_TOS_VERSION, appTitle: "Gendragoon Terms of Service",
            appText: "<!--\nDraft: requires attorney review before launch.\n-->\n# Gendragoon Terms of Service\n\nGendragoon terms.", falseInfoWarning: "", no2faWarning: "" });
        case "POST /v1/tos/read": {
          if (body.version !== TOS_VERSION || (body.appVersion !== undefined && body.appVersion !== APP_TOS_VERSION)) return send(res, 409, { error: "tos_changed" });
          const grant = `rxa_t_${b64u(randomBytes(16))}`;
          grants.set(grant, { stage: "read", version: TOS_VERSION, used: false, expiresMs: now() + 30 * 60_000 });
          return send(res, 200, { grant, stage: "read" });
        }
        case "POST /v1/tos/agree": {
          const g = grants.get(String(body.grant));
          if (!g || g.stage !== "read" || g.expiresMs < now()) return send(res, 400, { error: "tos_grant_invalid" });
          g.stage = "agreed";
          return send(res, 200, { grant: body.grant, stage: "agreed" });
        }
        case "POST /v1/validate/username": {
          const check = checkUsername(body.username);
          const taken = [...accounts.values()].some((a) => usernameKey(a.username) === usernameKey(String(body.username)));
          const error = !check.ok ? check.code : taken ? "username_taken" : undefined;
          return send(res, 200, { ok: !error, checks: [{ id: "edges", ok: check.ok || check.code !== "username_edges" }, { id: "available", ok: !taken }], error });
        }
        case "POST /v1/validate/email": {
          const fmt = checkEmailFormat(body.email);
          const domain = String(body.email ?? "").split("@").pop()!.toLowerCase();
          const disposable = DISPOSABLE.has(domain);
          const taken = fmt.ok && [...accounts.values()].some((a) => emailKey(a.email) === emailKey(String(body.email)));
          const error = !fmt.ok ? fmt.code : disposable ? "email_disposable" : domain.endsWith(".invalid") ? "email_domain" : taken ? "email_taken" : undefined;
          return send(res, 200, { ok: !error, checks: [{ id: "syntax", ok: fmt.ok }, { id: "disposable", ok: !disposable }, { id: "available", ok: !taken }], error });
        }
        case "POST /v1/validate/password": {
          const check = checkPassword(body.password);
          return send(res, 200, { ok: check.ok, checks: [], error: check.ok ? undefined : check.code });
        }
        case "POST /v1/validate/dob": {
          const minAge = effectiveMinAge(apps.get(app)?.minAge);
          const check = checkBirthDate(body.dob, { now: new Date(now()), minAge });
          const parsed = parseBirthDate(body.dob);
          return send(res, 200, { ok: check.ok, checks: [], error: check.ok ? undefined : check.code, age: parsed ? ageOn(parsed, new Date(now())) : null, minAge });
        }
        case "POST /v1/signup": {
          const fields = body as unknown as SignupFields & { tosGrant: string };
          const errors = validateSignup(fields, { now: new Date(now()), minAge: apps.get(app)?.minAge, requirePassword: true });
          if (errors.dob === "under_min_age") return send(res, 403, { error: "under_min_age", field: "dob" });
          const first = Object.entries(errors)[0];
          if (first) return send(res, 400, { error: first[1], field: first[0], errors });
          const g = grants.get(String(fields.tosGrant));
          if (!g || g.stage !== "agreed" || g.used) return send(res, 400, { error: "tos_grant_invalid" });
          if (DISPOSABLE.has(fields.email.split("@").pop()!.toLowerCase())) return send(res, 400, { error: "email_disposable", field: "email" });
          if ([...accounts.values()].some((a) => usernameKey(a.username) === usernameKey(fields.username))) return send(res, 409, { error: "username_taken", field: "username" });
          if ([...accounts.values()].some((a) => emailKey(a.email) === emailKey(fields.email))) return send(res, 409, { error: "email_taken", field: "email" });
          g.used = true;
          const sub = `rxa_${b64u(randomBytes(6))}`;
          accounts.set(sub, { sub, username: fields.username, email: fields.email, dob: fields.dob, twoFactor: fields.twoFactor as MockAccount["twoFactor"], amr: ["pwd"], tosVersion: g.version, password: fields.password });
          twoFactorPending.add(sub);
          if (fields.twoFactor === "none") twoFactorPending.delete(sub);
          const session = `rxa_s_${b64u(randomBytes(16))}`;
          sessions.set(session, { sub, createdMs: now(), exchanged: false });
          return send(res, 201, { account: me(sub), session, pending: pendingOf(sub), ...(fields.twoFactor === "app" ? { totp: { secret: MOCK_TOTP_SECRET, otpauthUri: `otpauth://totp/Red-XAI:x?secret=${MOCK_TOTP_SECRET}&issuer=Red-XAI` } } : {}) });
        }
        case "GET /v1/me": {
          const sub = sessionSub(req);
          if (!sub) return send(res, 401, { error: "unauthenticated" });
          return send(res, 200, me(sub));
        }
        case "POST /v1/me/2fa/confirm": {
          const sub = sessionSub(req);
          if (!sub) return send(res, 401, { error: "unauthenticated" });
          if (!/^\d{6}$/.test(String(body.code))) return send(res, 400, { error: "code_invalid", field: "code" });
          twoFactorPending.delete(sub);
          return send(res, 200, me(sub));
        }
        case "POST /v1/signup/resend-sms": {
          const sub = sessionSub(req);
          if (!sub) return send(res, 401, { error: "unauthenticated" });
          if (accounts.get(sub)!.twoFactor !== "phone" || !twoFactorPending.has(sub)) return send(res, 400, { error: "no_pending_phone" });
          return send(res, 200, { ok: true, phoneMasked: "+1******0123" });
        }
        case "POST /v1/login": {
          const a = [...accounts.values()].find((x) => x.username === body.login || x.email === body.login);
          if (!a || !a.password || a.password !== body.password) return send(res, 401, { error: "bad_credentials" });
          const s = `rxa_s_${b64u(randomBytes(16))}`;
          sessions.set(s, { sub: a.sub, createdMs: now(), exchanged: false });
          const headers: Record<string, string> = req.headers.origin === issuer ? { "set-cookie": `rxa_session=${s}; HttpOnly; SameSite=Lax; Path=/` } : {};
          if (req.headers.origin === issuer) cookieSessions.set(s, a.sub);
          return send(res, 200, { step: "ok", session: req.headers.origin === issuer ? "" : s, pending: pendingOf(a.sub), account: me(a.sub) }, headers);
        }
        default:
          return send(res, 404, { error: "not_found" });
      }
    } catch (error) {
      return send(res, 500, { error: "server_error", detail: String(error) });
    }
  });

  function sessionSub(req: IncomingMessage): string | undefined {
    return sessions.get((req.headers.authorization ?? "").replace(/^Bearer /, ""))?.sub;
  }
  function pendingOf(sub: string): string[] {
    return twoFactorPending.has(sub) ? ["2fa_setup"] : [];
  }
  function me(sub: string) {
    const a = accounts.get(sub)!;
    const parsed = parseBirthDate(a.dob)!;
    return {
      id: sub, username: a.username, email: a.email, emailVerified: false, age: ageOn(parsed, new Date(now())), ageBand: ageBand(a.dob, now()),
      adultVerified: false, roles: ["user"], twoFactor: a.twoFactor, twoFactorState: a.twoFactor === "none" ? "off" : twoFactorPending.has(sub) ? "pending" : "active", phoneMasked: null,
      tosVersion: a.tosVersion, appTos: [`gendragoon=${APP_TOS_VERSION}`], tosCurrent: a.tosVersion === TOS_VERSION, tosAcceptedMs: now(), createdMs: now(), owner: false, pending: pendingOf(sub),
    };
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    apps,
    accounts,
    refreshFamiliesRevoked,
    now,
    signInAs(account) { next = account; },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
