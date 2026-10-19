/**
 * A local stand-in for Red-XAI Accounts, implementing the parts of the v1
 * contract (docs/API.md, commit ce61961) that Gendragoon uses: discovery,
 * JWKS, authorize + token (PKCE S256, rotating refresh tokens), userinfo, and
 * the /v1 rules, Terms, validation, sign-up and /v1/me endpoints.
 * Tests only. It signs ES256 JWTs with a key made at start-up.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ageOn, checkBirthDate, checkUsername, effectiveMinAge, parseBirthDate, usernameKey, validateSignup, type SignupFields } from "../src/accounts/rules.js";

export interface MockAccount {
  sub: string;
  username: string;
  email: string;
  dob: string;
  twoFactor: "app" | "phone" | "none";
  amr: string[];
}

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

const TOS_VERSION = "gendragoon-tos-2026-10-19";
const b64u = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function jwt(key: KeyObject, kid: string, claims: Record<string, unknown>): string {
  const head = b64u(Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT", kid })));
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

export async function startRedXaiMock(options: { now?: () => number } = {}): Promise<RedXaiMock> {
  const now = options.now ?? Date.now;
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const kid = b64u(randomBytes(8));
  const apps = new Map([["gendragoon", { minAge: 13, redirectUris: [] as string[] }]]);
  const accounts = new Map<string, MockAccount & { tosVersion: string }>();
  const codes = new Map<string, { app: string; sub: string; redirectUri: string; nonce: string; challenge: string; scope: string; used: boolean }>();
  const refresh = new Map<string, { family: string; sub: string; app: string; scope: string; used: boolean }>();
  const refreshFamiliesRevoked = new Set<string>();
  const grants = new Map<string, { stage: "read" | "agreed"; version: string; used: boolean; expiresMs: number }>();
  const sessions = new Map<string, string>();
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
      access_token: jwt(privateKey, kid, { iss: issuer, sub, aud: app, scope, sid, client_id: app, iat, exp: iat + 600 }),
      token_type: "Bearer",
      expires_in: 600,
      id_token: jwt(privateKey, kid, {
        iss: issuer, sub, aud: app, iat, exp: iat + 600, nonce, auth_time: iat, amr: account.amr, sid,
        preferred_username: account.username, age_band: ageBand(account.dob, now()), adult_verified: false,
        email: account.email, email_verified: true,
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
          const back = new URL(redirect);
          back.searchParams.set("state", p.get("state") ?? "");
          const who = next;
          if (!who) back.searchParams.set("error", "login_required");
          else {
            const parsed = parseBirthDate(who.dob)!;
            if (ageOn(parsed, new Date(now())) < Math.max(13, client.minAge)) back.searchParams.set("error", "access_denied");
            else {
              accounts.set(who.sub, { ...who, tosVersion: TOS_VERSION });
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
          return send(res, 400, { error: "unsupported_grant_type" });
        }
        case "GET /v1/rules":
          return send(res, 200, { minAge: effectiveMinAge(apps.get(app)?.minAge), centralMinAge: 13, twoFactor: [
            { method: "app", available: true }, { method: "phone", available: true }, { method: "redxai_auth", available: false }, { method: "none", available: true }] });
        case "GET /v1/tos":
          return send(res, 200, { version: TOS_VERSION, title: "Gendragoon Terms of Service", text: "Terms.", privacyVersion: "privacy-1", privacyText: "Privacy.", falseInfoWarning: "", no2faWarning: "" });
        case "POST /v1/tos/read": {
          if (body.version !== TOS_VERSION) return send(res, 409, { error: "tos_changed" });
          const grant = `rxa_t_${b64u(randomBytes(16))}`;
          grants.set(grant, { stage: "read", version: TOS_VERSION, used: false, expiresMs: now() + 30 * 60_000 });
          return send(res, 200, { grant, stage: "read", version: TOS_VERSION });
        }
        case "POST /v1/tos/agree": {
          const g = grants.get(String(body.grant));
          if (!g || g.stage !== "read" || g.expiresMs < now()) return send(res, 400, { error: "tos_grant_invalid" });
          g.stage = "agreed";
          return send(res, 200, { grant: body.grant, stage: "agreed", version: g.version });
        }
        case "POST /v1/validate/username": {
          const check = checkUsername(body.username);
          const taken = [...accounts.values()].some((a) => usernameKey(a.username) === usernameKey(String(body.username)));
          const error = !check.ok ? check.code : taken ? "username_taken" : undefined;
          return send(res, 200, { ok: !error, checks: [{ id: "available", ok: !taken }], error });
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
          g.used = true;
          const sub = `acct_${b64u(randomBytes(6))}`;
          accounts.set(sub, { sub, username: fields.username, email: fields.email, dob: fields.dob, twoFactor: fields.twoFactor as MockAccount["twoFactor"], amr: ["pwd"], tosVersion: g.version });
          const session = `rxa_s_${b64u(randomBytes(16))}`;
          sessions.set(session, sub);
          const pending = fields.twoFactor === "none" ? [] : ["2fa_setup"];
          return send(res, 201, { account: me(sub), session, pending, ...(fields.twoFactor === "app" ? { totp: { secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/Red-XAI:x?secret=JBSWY3DPEHPK3PXP&issuer=Red-XAI" } } : {}) });
        }
        case "GET /v1/me": {
          const sub = sessions.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
          if (!sub) return send(res, 401, { error: "unauthenticated" });
          return send(res, 200, me(sub));
        }
        default:
          return send(res, 404, { error: "not_found" });
      }
    } catch (error) {
      return send(res, 500, { error: "server_error", detail: String(error) });
    }
  });

  function me(sub: string) {
    const a = accounts.get(sub)!;
    const parsed = parseBirthDate(a.dob)!;
    return {
      id: sub, username: a.username, email: a.email, emailVerified: false, age: ageOn(parsed, new Date(now())), ageBand: ageBand(a.dob, now()),
      adultVerified: false, roles: [], twoFactor: a.twoFactor, twoFactorState: a.twoFactor === "none" ? "off" : "pending", phoneMasked: null,
      tosVersion: a.tosVersion, tosCurrent: TOS_VERSION, tosAcceptedMs: now(), createdMs: now(), owner: false, pending: a.twoFactor === "none" ? [] : ["2fa_setup"],
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
