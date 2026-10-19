import type { SignupFields, TwoFactorMethod } from "./rules.js";

/**
 * Sign-up and account calls. The request and response shapes are the Red-XAI
 * Accounts v1 contract's; `pathPrefix` picks the server:
 * - Gendragoon backend (transitional, Firebase-backed): baseUrl = API base, pathPrefix = "/v1/accounts"
 * - Red-XAI Accounts: baseUrl = issuer, pathPrefix = "/v1" (with `app: "gendragoon"` added to bodies)
 */
export interface AccountsClientOptions {
  baseUrl: string;
  pathPrefix?: string;
  /** Set when talking to Red-XAI Accounts directly: added to the bodies that name the app. */
  app?: string;
  getToken?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export interface CheckResult {
  ok: boolean;
  checks: Array<{ id: string; ok: boolean; code?: string }>;
  error?: string;
}

export interface TermsDocument {
  version: string;
  title: string;
  text: string;
  falseInfoWarning: string;
  no2faWarning: string;
  /** Red-XAI Accounts serves the Privacy Policy with the Terms. */
  privacyVersion?: string;
  privacyText?: string;
}

export interface TosGrant {
  grant: string;
  stage: "read" | "agreed";
  version: string;
}

export interface AccountRules {
  minAge: number;
  centralMinAge: number;
  tosVersion?: string;
  twoFactor: Array<{ method: TwoFactorMethod; available: boolean; label?: string }>;
}

export type AccountPending = "account_setup" | "tos" | "2fa_setup" | "2fa" | "password_reset";

export interface AccountView {
  username: string;
  email: string;
  emailVerified: boolean;
  age: number | null;
  ageBand: string | null;
  twoFactor: TwoFactorMethod | "central";
  twoFactorState: "off" | "pending" | "active";
  phoneMasked: string | null;
  tosVersion: string;
  tosCurrent: string;
  tosAcceptedMs: number;
  pending: AccountPending[];
  /** Present on Red-XAI Accounts `Me`. */
  id?: string;
  adultVerified?: boolean;
  roles?: string[];
  createdMs?: number;
  owner?: boolean;
}

export interface SignupResult {
  account: AccountView;
  pending: AccountPending[];
  totp?: { secret: string; otpauthUri: string };
  phoneMasked?: string;
  /** Set when the account was created but the first text message could not be sent (`sms_send_failed`, `phone_undeliverable`). */
  smsError?: string;
  /** Red-XAI Accounts `/v1/signup` returns the new `rxa_s_` session. */
  session?: string;
}

export class AccountsApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly field?: string,
    readonly errors?: Record<string, string>,
    readonly pending?: AccountPending[],
  ) {
    super(code);
  }
}

export class AccountsClient {
  private readonly prefix: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AccountsClientOptions) {
    this.prefix = options.pathPrefix ?? "/v1/accounts";
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  private async call<T>(method: string, path: string, body?: Record<string, unknown>, auth = false): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body) headers["content-type"] = "application/json";
    if (auth) {
      const token = await this.options.getToken?.();
      if (!token) throw new AccountsApiError(401, "unauthenticated");
      headers.authorization = `Bearer ${token}`;
    }
    const payload = body && this.options.app ? { app: this.options.app, ...body } : body;
    const res = await this.fetchImpl(`${this.options.baseUrl.replace(/\/+$/, "")}${this.prefix}${path}`, {
      method,
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
    });
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = {};
    }
    if (!res.ok) {
      throw new AccountsApiError(
        res.status,
        typeof json.error === "string" ? json.error : "unavailable",
        typeof json.field === "string" ? json.field : undefined,
        json.errors as Record<string, string> | undefined,
        json.pending as AccountPending[] | undefined,
      );
    }
    return json as T;
  }

  rules(): Promise<AccountRules> {
    return this.call("GET", `/rules${this.options.app ? `?app=${encodeURIComponent(this.options.app)}` : ""}`);
  }
  terms(): Promise<TermsDocument> {
    return this.call("GET", `/tos${this.options.app ? `?app=${encodeURIComponent(this.options.app)}` : ""}`);
  }
  /** "Read ToS": only after the person scrolled to the end. */
  markTermsRead(version: string): Promise<TosGrant> {
    return this.call("POST", "/tos/read", { version });
  }
  /** "Agree to ToS": advances the read grant. */
  agreeToTerms(grant: string): Promise<TosGrant> {
    return this.call("POST", "/tos/agree", { grant });
  }
  validateUsername(username: string): Promise<CheckResult> {
    return this.call("POST", "/validate/username", { username });
  }
  validateEmail(email: string): Promise<CheckResult> {
    return this.call("POST", "/validate/email", { email });
  }
  validateDob(dob: string): Promise<CheckResult & { minAge: number }> {
    return this.call("POST", "/validate/dob", { dob });
  }
  signup(fields: SignupFields & { tosGrant: string }): Promise<SignupResult> {
    return this.call("POST", "/signup", { ...fields });
  }
  /** Finishes a quick sign-in (Google, or Red-XAI without a Gendragoon profile yet). Same rules, no password. */
  complete(fields: Partial<SignupFields> & { tosGrant: string }): Promise<SignupResult> {
    return this.call("POST", "/complete", { ...fields }, true);
  }
  me(): Promise<AccountView> {
    return this.call("GET", "/me", undefined, true);
  }
  acceptTerms(grant: string): Promise<AccountView> {
    return this.call("POST", "/me/tos", { grant }, true);
  }
  setupTwoFactor(input: { method: TwoFactorMethod; phone?: string; acceptNo2faRisk?: boolean }): Promise<{ totp?: SignupResult["totp"]; phoneMasked?: string; account: AccountView }> {
    return this.call("POST", "/me/2fa/setup", { ...input }, true);
  }
  confirmTwoFactor(code: string): Promise<AccountView> {
    return this.call("POST", "/me/2fa/confirm", { code }, true);
  }
  sendSignInCode(): Promise<{ sent: boolean; phoneMasked: string }> {
    return this.call("POST", "/2fa/sms/send", {}, true);
  }
  verifySignInCode(code: string): Promise<AccountView> {
    return this.call("POST", "/2fa/verify", { code }, true);
  }
  linkRedXai(redxaiToken: string): Promise<{ linked: boolean }> {
    return this.call("POST", "/link/redxai", { redxaiToken }, true);
  }
}
