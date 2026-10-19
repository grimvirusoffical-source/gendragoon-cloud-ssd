/**
 * Sign-up rules for Red-XAI Accounts as used by Gendragoon. Field names, error
 * codes and the safe symbol set follow the Red-XAI Accounts v1 contract
 * (docs/API.md "Rules"). The Gendragoon backend applies the same rules
 * (native/Backend/accounts/rules.js); both suites run the shared vectors in
 * test/vectors/account-rules.json so they cannot drift.
 */

export const USERNAME_MIN = 8;
export const USERNAME_MAX = 32;
export const USERNAME_MIN_LETTERS = 3;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 665;
export const AGE_MAX = 100;
/** No Red-XAI Account is ever made for anyone under 13. An app may require more, never less. */
export const MIN_AGE_FLOOR = 13;
export const DEFAULT_MIN_AGE = MIN_AGE_FLOOR;
/** The contract's safe special characters: printable ASCII without space, quotes, backslash, backtick or angle brackets. */
export const PASSWORD_SYMBOLS = "!#$%&()*+,-./:;=?@[]^_{|}~";

export function effectiveMinAge(configured?: number): number {
  return Number.isInteger(configured) && (configured as number) > MIN_AGE_FLOOR ? Math.min(configured as number, AGE_MAX) : MIN_AGE_FLOOR;
}

export type RuleState = { id: string; label: string; met: boolean };
export type FieldCheck = { ok: true } | { ok: false; code: string };

const USERNAME_CHARS = /^[A-Za-z0-9._-]*$/;
const SEPARATOR_EDGE = /^[._-]|[._-]$/;
const PASSWORD_ALLOWED = new Set(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789" + PASSWORD_SYMBOLS,
);

const letterCount = (value: string) => (value.match(/[A-Za-z]/g) ?? []).length;
const codePoints = (value: string) => Array.from(value);

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
  const chars = codePoints(value ?? "");
  return [
    { id: "length", label: `${PASSWORD_MIN} to ${PASSWORD_MAX} characters`, met: chars.length >= PASSWORD_MIN && chars.length <= PASSWORD_MAX },
    { id: "upper", label: "An uppercase letter", met: chars.some((c) => c >= "A" && c <= "Z") },
    { id: "lower", label: "A lowercase letter", met: chars.some((c) => c >= "a" && c <= "z") },
    { id: "digit", label: "A number", met: chars.some((c) => c >= "0" && c <= "9") },
    { id: "special", label: `A symbol: ${PASSWORD_SYMBOLS.split("").join(" ")}`, met: chars.some((c) => PASSWORD_SYMBOLS.includes(c)) },
    { id: "chars", label: "Only letters, numbers and those symbols", met: chars.length > 0 && chars.every((c) => PASSWORD_ALLOWED.has(c)) },
  ];
}

export function checkUsername(value: unknown): FieldCheck {
  if (typeof value !== "string" || value.length === 0) return { ok: false, code: "username_required" };
  if (value.length < USERNAME_MIN) return { ok: false, code: "username_short" };
  if (value.length > USERNAME_MAX) return { ok: false, code: "username_long" };
  if (!USERNAME_CHARS.test(value)) return { ok: false, code: "username_chars" };
  if (SEPARATOR_EDGE.test(value)) return { ok: false, code: "username_edges" };
  if (letterCount(value) < USERNAME_MIN_LETTERS) return { ok: false, code: "username_letters" };
  return { ok: true };
}

/** Case-insensitive uniqueness key (the contract's usernameFolded). */
export function usernameKey(value: string): string {
  return value.toLowerCase();
}

export function checkPassword(value: unknown): FieldCheck {
  if (typeof value !== "string" || value.length === 0) return { ok: false, code: "password_required" };
  const chars = codePoints(value);
  if (chars.length < PASSWORD_MIN) return { ok: false, code: "password_short" };
  if (chars.length > PASSWORD_MAX) return { ok: false, code: "password_long" };
  if (!chars.every((c) => PASSWORD_ALLOWED.has(c))) return { ok: false, code: "password_chars" };
  if (!/[A-Z]/.test(value)) return { ok: false, code: "password_upper" };
  if (!/[a-z]/.test(value)) return { ok: false, code: "password_lower" };
  if (!/[0-9]/.test(value)) return { ok: false, code: "password_digit" };
  if (!chars.some((c) => PASSWORD_SYMBOLS.includes(c))) return { ok: false, code: "password_special" };
  return { ok: true };
}

const EMAIL_LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** Trimmed, NFC, lower-cased address (the contract's emailFolded). */
export function normalizeEmail(value: string): string {
  return value.trim().normalize("NFC").toLowerCase();
}

/** Gendragoon's duplicate key: the folded address, and for Gmail the mailbox without dots or a +tag. */
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
  const bad: FieldCheck = { ok: false, code: "email_syntax" };
  if (email.length > 254) return bad;
  const at = email.lastIndexOf("@");
  if (at < 1 || at !== email.indexOf("@")) return bad;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !EMAIL_LOCAL.test(local)) return bad;
  const labels = domain.split(".");
  if (labels.length < 2 || domain.length > 253 || !labels.every((label) => DOMAIN_LABEL.test(label))) return bad;
  const tld = labels[labels.length - 1]!;
  if (!/^[a-z]{2,63}$/.test(tld) && !/^xn--[a-z0-9-]+$/.test(tld)) return bad;
  return { ok: true };
}

export interface BirthDate {
  year: number;
  month: number;
  day: number;
}

const DOB_SHAPE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** Strict MM/DD/YYYY. Returns null when the text is not a real calendar date. */
export function parseBirthDate(value: unknown): BirthDate | null {
  if (typeof value !== "string") return null;
  const match = DOB_SHAPE.exec(value.trim());
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || year < 1800) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

const pad = (n: number, w: number) => String(n).padStart(w, "0");

export function formatBirthDate(dob: BirthDate): string {
  return `${pad(dob.month, 2)}/${pad(dob.day, 2)}/${pad(dob.year, 4)}`;
}

/** ISO form (YYYY-MM-DD), used by calendar inputs and for storage. */
export function birthDateToIso(dob: BirthDate): string {
  return `${pad(dob.year, 4)}-${pad(dob.month, 2)}-${pad(dob.day, 2)}`;
}

export function birthDateFromIso(value: string): BirthDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? parseBirthDate(`${match[2]}/${match[3]}/${match[1]}`) : null;
}

/** Types MM/DD/YYYY as the person enters digits: "0704" becomes "07/04". */
export function maskBirthDateInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

/** Age in whole years on `now` (UTC calendar). Age is always computed, never stored. */
export function ageOn(dob: BirthDate, now: Date): number {
  const m = now.getUTCMonth() + 1;
  const d = now.getUTCDate();
  let age = now.getUTCFullYear() - dob.year;
  if (m < dob.month || (m === dob.month && d < dob.day)) age -= 1;
  return age;
}

export function checkBirthDate(value: unknown, options: { now: Date; minAge?: number }): FieldCheck {
  if (typeof value !== "string" || value.trim().length === 0) return { ok: false, code: "dob_required" };
  if (!DOB_SHAPE.test(value.trim())) return { ok: false, code: "dob_format" };
  const dob = parseBirthDate(value);
  if (!dob) return { ok: false, code: "dob_invalid" };
  const age = ageOn(dob, options.now);
  if (age < 0) return { ok: false, code: "dob_range" };
  if (age > AGE_MAX) return { ok: false, code: "dob_range" };
  if (age < effectiveMinAge(options.minAge)) return { ok: false, code: "under_min_age" };
  return { ok: true };
}

/** Contract values: phone (SMS), app (authenticator), none, and redxai_auth (coming soon, refused). */
export type TwoFactorMethod = "app" | "phone" | "redxai_auth" | "none";
export const TWO_FACTOR_METHODS: readonly TwoFactorMethod[] = ["app", "phone", "redxai_auth", "none"];
export const AVAILABLE_TWO_FACTOR_METHODS: readonly TwoFactorMethod[] = ["app", "phone", "none"];

export function normalizePhone(value: string): string {
  return value.replace(/[\s().-]/g, "");
}

/** E.164: + then 8 to 15 digits. */
export function checkPhone(value: unknown): FieldCheck {
  if (typeof value !== "string") return { ok: false, code: "phone_invalid" };
  return /^\+[1-9][0-9]{7,14}$/.test(normalizePhone(value)) ? { ok: true } : { ok: false, code: "phone_invalid" };
}

/** The sign-up body, with the contract's field names. */
export interface SignupFields {
  username: string;
  email: string;
  emailConfirm: string;
  password?: string;
  passwordConfirm?: string;
  dob: string;
  twoFactor: TwoFactorMethod | "";
  phone?: string;
  acceptNo2faRisk?: boolean;
  acknowledgeFalseInfo?: boolean;
}

export interface SignupOptions {
  now: Date;
  minAge?: number;
  /** Email sign-up needs a password. Completing a quick (Google) sign-in does not. */
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
  if (!errors.email && normalizeEmail(fields.emailConfirm ?? "") !== normalizeEmail(fields.email)) errors.emailConfirm = "email_mismatch";
  if (options.requirePassword) {
    put("password", checkPassword(fields.password));
    if (!errors.password && fields.passwordConfirm !== fields.password) errors.passwordConfirm = "password_mismatch";
  }
  put("dob", checkBirthDate(fields.dob, { now: options.now, minAge: options.minAge }));
  if (fields.twoFactor === "redxai_auth") errors.twoFactor = "twofactor_unavailable";
  else if (!TWO_FACTOR_METHODS.includes(fields.twoFactor as TwoFactorMethod)) errors.twoFactor = "twofactor_invalid";
  else if (fields.twoFactor === "none" && fields.acceptNo2faRisk !== true) errors.twoFactor = "no2fa_ack_required";
  else if (fields.twoFactor === "phone") put("phone", checkPhone(fields.phone));
  if (fields.acknowledgeFalseInfo !== true) errors.acknowledgeFalseInfo = "false_info_ack_required";
  return errors;
}

/** Text for every error code, shared by all clients. */
export const ACCOUNT_ERROR_TEXT: Record<string, string> = {
  username_required: "Choose a username.",
  username_short: `Usernames need at least ${USERNAME_MIN} characters.`,
  username_long: `Usernames can be at most ${USERNAME_MAX} characters.`,
  username_chars: "Use only letters, numbers, _ - and .",
  username_edges: "Start and end the username with a letter or number.",
  username_letters: `Usernames need at least ${USERNAME_MIN_LETTERS} letters.`,
  username_taken: "That username is taken.",
  password_required: "Choose a password.",
  password_short: `Passwords need at least ${PASSWORD_MIN} characters.`,
  password_long: `Passwords can be at most ${PASSWORD_MAX} characters.`,
  password_chars: "Use only letters, numbers and the listed symbols.",
  password_upper: "Add an uppercase letter.",
  password_lower: "Add a lowercase letter.",
  password_digit: "Add a number.",
  password_special: "Add one of the listed symbols.",
  password_mismatch: "The passwords don't match.",
  email_required: "Enter your email address.",
  email_syntax: "That doesn't look like an email address.",
  email_domain: "That email domain can't receive mail.",
  email_disposable: "Use a permanent email address, not a disposable one.",
  email_unverifiable: "We couldn't check that email domain. Try again in a moment.",
  email_taken: "That email is already used by another account.",
  email_blocked: "That email can't be used for a new account.",
  email_mismatch: "The email addresses don't match.",
  dob_required: "Enter your date of birth.",
  dob_format: "Use MM/DD/YYYY.",
  dob_invalid: "Enter a real date.",
  dob_range: "Your date of birth can't be in the future or more than 100 years ago.",
  under_min_age: "You must be at least 13 to make an account.",
  twofactor_invalid: "Choose how to protect your account.",
  twofactor_unavailable: "Red-XAI Auth is coming soon. Choose another option.",
  no2fa_ack_required: "Confirm that you accept the risk of not using two-factor sign-in.",
  phone_invalid: "Enter the number with its country code, like +1 555 123 4567.",
  sms_unavailable: "Text-message codes aren't available yet. Choose another option.",
  sms_send_failed: "We couldn't send the text message. Try again in a moment.",
  phone_undeliverable: "We can't send text messages to that number. Check it or choose another option.",
  false_info_ack_required: "Confirm that your details are true.",
  tos_required: "Read and agree to the Terms of Service to continue.",
  tos_not_read: "Read the Terms of Service to the end first.",
  tos_changed: "The Terms of Service changed. Read and agree to the new version.",
  tos_grant_invalid: "Your Terms agreement expired. Read and agree again.",
  code_invalid: "That code isn't right. Try the newest code.",
  rate_limited: "Too many tries. Wait a moment and try again.",
};

export function accountErrorText(code: string): string {
  return ACCOUNT_ERROR_TEXT[code] ?? "Something went wrong. Try again.";
}
