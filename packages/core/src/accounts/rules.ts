/**
 * Sign-up rules for Gendragoon accounts. The backend applies the same rules
 * (native/Backend/accounts/rules.js); both suites run the shared vectors in
 * test/vectors/account-rules.json so the two cannot drift.
 */

export const USERNAME_MIN = 8;
export const USERNAME_MAX = 32;
export const USERNAME_MIN_LETTERS = 3;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 665;
export const AGE_MAX = 100;
/** Minimum age. Configurable upward only: no account is ever made for anyone under 13. */
export const MIN_AGE_FLOOR = 13;
export const DEFAULT_MIN_AGE = MIN_AGE_FLOOR;

/** The minimum age actually applied: a configured value, never below the floor. */
export function effectiveMinAge(configured?: number): number {
  return Number.isInteger(configured) && (configured as number) > MIN_AGE_FLOOR ? Math.min(configured as number, AGE_MAX) : MIN_AGE_FLOOR;
}
/** Symbols that count toward the password's special-character requirement. */
export const PASSWORD_SYMBOLS = "!@#$%^&*()-_=+[]{};:,.?/~|<>";

export type RuleState = { id: string; label: string; met: boolean };

const USERNAME_SHAPE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const USERNAME_CHARS = /^[A-Za-z0-9._-]*$/;
const SEPARATOR_EDGE = /^[._-]|[._-]$/;

function letterCount(value: string): number {
  return (value.match(/[A-Za-z]/g) ?? []).length;
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

export function usernameRules(value: string): RuleState[] {
  const v = value ?? "";
  return [
    { id: "length", label: `${USERNAME_MIN} to ${USERNAME_MAX} characters`, met: v.length >= USERNAME_MIN && v.length <= USERNAME_MAX },
    { id: "letters", label: `At least ${USERNAME_MIN_LETTERS} letters`, met: letterCount(v) >= USERNAME_MIN_LETTERS },
    { id: "chars", label: "Only letters, numbers, _ - and .", met: v.length > 0 && USERNAME_CHARS.test(v) },
    { id: "edges", label: "Starts and ends with a letter or number", met: v.length > 0 && !SEPARATOR_EDGE.test(v) },
  ];
}

export function passwordRules(value: string): RuleState[] {
  const v = value ?? "";
  const n = codePoints(v);
  return [
    { id: "length", label: `${PASSWORD_MIN} to ${PASSWORD_MAX} characters`, met: n >= PASSWORD_MIN && n <= PASSWORD_MAX },
    { id: "upper", label: "An uppercase letter", met: /[A-Z]/.test(v) },
    { id: "lower", label: "A lowercase letter", met: /[a-z]/.test(v) },
    { id: "digit", label: "A number", met: /[0-9]/.test(v) },
    { id: "symbol", label: `A symbol (${PASSWORD_SYMBOLS})`, met: Array.from(v).some((c) => PASSWORD_SYMBOLS.includes(c)) },
  ];
}

export type FieldCheck = { ok: true } | { ok: false; code: string };

export function checkUsername(value: unknown): FieldCheck {
  if (typeof value !== "string" || value.length === 0) return { ok: false, code: "username_required" };
  if (value.length < USERNAME_MIN) return { ok: false, code: "username_too_short" };
  if (value.length > USERNAME_MAX) return { ok: false, code: "username_too_long" };
  if (!USERNAME_CHARS.test(value)) return { ok: false, code: "username_bad_chars" };
  if (!USERNAME_SHAPE.test(value)) return { ok: false, code: "username_bad_edges" };
  if (letterCount(value) < USERNAME_MIN_LETTERS) return { ok: false, code: "username_few_letters" };
  return { ok: true };
}

/** Case-insensitive uniqueness key. */
export function usernameKey(value: string): string {
  return value.toLowerCase();
}

export function checkPassword(value: unknown): FieldCheck {
  if (typeof value !== "string" || value.length === 0) return { ok: false, code: "password_required" };
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, code: "password_bad_chars" };
  const failed = passwordRules(value).find((rule) => !rule.met);
  return failed ? { ok: false, code: `password_${failed.id}` } : { ok: true };
}

const EMAIL_LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** Trimmed, NFC, lower-cased address. This is what is stored and shown. */
export function normalizeEmail(value: string): string {
  return value.trim().normalize("NFC").toLowerCase();
}

/**
 * Uniqueness key: the normalized address, and for Gmail the mailbox without
 * dots or a +tag (Gmail delivers those variants to the same inbox).
 */
export function emailKey(value: string): string {
  const email = normalizeEmail(value);
  const at = email.lastIndexOf("@");
  if (at < 0) return email;
  let local = email.slice(0, at);
  let domain = email.slice(at + 1);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.split("+")[0]!.replace(/\./g, "");
    domain = "gmail.com";
  }
  return `${local}@${domain}`;
}

export function checkEmailFormat(value: unknown): FieldCheck {
  if (typeof value !== "string" || value.trim().length === 0) return { ok: false, code: "email_required" };
  const email = normalizeEmail(value);
  if (email.length > 254) return { ok: false, code: "email_invalid" };
  const at = email.lastIndexOf("@");
  if (at < 1 || at !== email.indexOf("@")) return { ok: false, code: "email_invalid" };
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !EMAIL_LOCAL.test(local)) return { ok: false, code: "email_invalid" };
  const labels = domain.split(".");
  if (labels.length < 2 || domain.length > 253) return { ok: false, code: "email_invalid" };
  if (!labels.every((label) => DOMAIN_LABEL.test(label))) return { ok: false, code: "email_invalid" };
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1]!) && !/^xn--[a-z0-9-]+$/.test(labels[labels.length - 1]!)) {
    return { ok: false, code: "email_invalid" };
  }
  return { ok: true };
}

export interface BirthDate {
  year: number;
  month: number;
  day: number;
}

/** Strict MM/DD/YYYY. Returns null when the text is not a real calendar date. */
export function parseBirthDate(value: unknown): BirthDate | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || year < 1800) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

export function formatBirthDate(dob: BirthDate): string {
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return `${pad(dob.month, 2)}/${pad(dob.day, 2)}/${pad(dob.year, 4)}`;
}

/** ISO form (YYYY-MM-DD) used by calendar inputs and for storage. */
export function birthDateToIso(dob: BirthDate): string {
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return `${pad(dob.year, 4)}-${pad(dob.month, 2)}-${pad(dob.day, 2)}`;
}

export function birthDateFromIso(value: string): BirthDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return parseBirthDate(`${match[2]}/${match[3]}/${match[1]}`);
}

/** Age in whole years on `now` (UTC calendar). Age is always computed, never stored. */
export function ageOn(dob: BirthDate, now: Date): number {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const d = now.getUTCDate();
  let age = y - dob.year;
  if (m < dob.month || (m === dob.month && d < dob.day)) age -= 1;
  return age;
}

export function checkBirthDate(value: unknown, options: { now: Date; minAge?: number }): FieldCheck {
  if (typeof value !== "string" || value.trim().length === 0) return { ok: false, code: "dob_required" };
  const dob = parseBirthDate(value);
  if (!dob) return { ok: false, code: "dob_invalid" };
  const age = ageOn(dob, options.now);
  if (age < 0) return { ok: false, code: "dob_future" };
  if (age > AGE_MAX) return { ok: false, code: "dob_out_of_range" };
  if (age < effectiveMinAge(options.minAge)) return { ok: false, code: "dob_under_min_age" };
  return { ok: true };
}

export type TwoFactorMethod = "sms" | "totp" | "redxai_auth" | "none";
export const TWO_FACTOR_METHODS: readonly TwoFactorMethod[] = ["totp", "sms", "redxai_auth", "none"];
/** Methods a person can choose today. Red-XAI Auth is listed but not available yet. */
export const AVAILABLE_TWO_FACTOR_METHODS: readonly TwoFactorMethod[] = ["totp", "sms", "none"];

/** E.164: + then 8 to 15 digits. */
export function checkPhone(value: unknown): FieldCheck {
  if (typeof value !== "string") return { ok: false, code: "phone_required" };
  const compact = value.replace(/[\s().-]/g, "");
  return /^\+[1-9][0-9]{7,14}$/.test(compact) ? { ok: true } : { ok: false, code: "phone_invalid" };
}

export function normalizePhone(value: string): string {
  return value.replace(/[\s().-]/g, "");
}

export interface SignupFields {
  username: string;
  email: string;
  emailConfirm: string;
  password?: string;
  passwordConfirm?: string;
  birthDate: string;
  twoFactor: TwoFactorMethod | "";
  noTwoFactorAcknowledged?: boolean;
  falseInfoAcknowledged?: boolean;
  phone?: string;
}

export interface SignupOptions {
  now: Date;
  minAge?: number;
  /** Password is required for email sign-up and absent for quick sign-in (Google) completion. */
  requirePassword: boolean;
}

/** Every field error at once, keyed by field. Empty when the form may be sent. */
export function validateSignup(fields: SignupFields, options: SignupOptions): Record<string, string> {
  const errors: Record<string, string> = {};
  const put = (field: string, check: FieldCheck) => {
    if (!check.ok) errors[field] = check.code;
  };
  put("username", checkUsername(fields.username));
  put("email", checkEmailFormat(fields.email));
  if (!errors.email && normalizeEmail(fields.emailConfirm ?? "") !== normalizeEmail(fields.email)) {
    errors.emailConfirm = "email_mismatch";
  }
  if (options.requirePassword) {
    put("password", checkPassword(fields.password));
    if (!errors.password && fields.passwordConfirm !== fields.password) errors.passwordConfirm = "password_mismatch";
  }
  put("birthDate", checkBirthDate(fields.birthDate, { now: options.now, minAge: options.minAge }));
  if (!fields.twoFactor) errors.twoFactor = "two_factor_required";
  else if (fields.twoFactor === "redxai_auth") errors.twoFactor = "two_factor_unavailable";
  else if (!TWO_FACTOR_METHODS.includes(fields.twoFactor)) errors.twoFactor = "two_factor_invalid";
  else if (fields.twoFactor === "none" && fields.noTwoFactorAcknowledged !== true) errors.twoFactor = "no_two_factor_ack_required";
  else if (fields.twoFactor === "sms") put("phone", checkPhone(fields.phone));
  if (fields.falseInfoAcknowledged !== true) errors.falseInfo = "false_info_ack_required";
  return errors;
}

/** Text for every error code, shared by all clients. */
export const ACCOUNT_ERROR_TEXT: Record<string, string> = {
  username_required: "Choose a username.",
  username_too_short: `Usernames need at least ${USERNAME_MIN} characters.`,
  username_too_long: `Usernames can be at most ${USERNAME_MAX} characters.`,
  username_bad_chars: "Use only letters, numbers, _ - and .",
  username_bad_edges: "Start and end the username with a letter or number.",
  username_few_letters: `Usernames need at least ${USERNAME_MIN_LETTERS} letters.`,
  username_taken: "That username is taken.",
  password_required: "Choose a password.",
  password_bad_chars: "Passwords can't contain control characters.",
  password_length: `Passwords need ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`,
  password_upper: "Add an uppercase letter.",
  password_lower: "Add a lowercase letter.",
  password_digit: "Add a number.",
  password_symbol: "Add a symbol.",
  password_mismatch: "The passwords don't match.",
  email_required: "Enter your email address.",
  email_invalid: "That doesn't look like an email address.",
  email_undeliverable: "That email domain can't receive mail.",
  email_unverifiable: "We couldn't check that email domain. Try again in a moment.",
  email_taken: "That email is already used by another account.",
  email_mismatch: "The email addresses don't match.",
  dob_required: "Enter your date of birth.",
  dob_invalid: "Use MM/DD/YYYY with a real date.",
  dob_future: "Your date of birth can't be in the future.",
  dob_out_of_range: "Check your date of birth.",
  dob_under_min_age: "You're not old enough to make an account.",
  two_factor_required: "Choose how to protect your account.",
  two_factor_unavailable: "Red-XAI Auth is coming soon. Choose another option.",
  two_factor_invalid: "Choose how to protect your account.",
  no_two_factor_ack_required: "Confirm that you understand the risk of not using two-factor sign-in.",
  phone_required: "Enter your phone number.",
  phone_invalid: "Enter the number with its country code, like +1 555 123 4567.",
  false_info_ack_required: "Confirm that your details are true.",
  tos_not_read: "Read the Terms of Service to the end first.",
  tos_not_agreed: "Agree to the Terms of Service to continue.",
  tos_outdated: "The Terms of Service changed. Read and agree to the new version.",
};

export function accountErrorText(code: string): string {
  return ACCOUNT_ERROR_TEXT[code] ?? "Something went wrong. Try again.";
}
