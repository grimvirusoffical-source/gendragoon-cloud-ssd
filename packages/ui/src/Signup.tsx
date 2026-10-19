import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  FALSE_INFO_WARNING,
  NO_TWO_FACTOR_ACK_LABEL,
  NO_TWO_FACTOR_WARNING,
  TOS_GATE_START,
  TWO_FACTOR_OPTIONS,
  accountErrorText,
  twoFactorOptionAvailable,
  birthDateFromIso,
  birthDateToIso,
  copyAcross,
  formatBirthDate,
  maskBirthDateInput,
  parseBirthDate,
  passwordRules,
  qrSvgPath,
  reduceTosGate,
  scrolledToEnd,
  usernameRules,
  validateSignup,
  type AccountRules,
  type CheckResult,
  type RuleState,
  type SignupFields,
  type SignupResult,
  type TermsDocument,
  type TosGrant,
  type TwoFactorMethod,
} from "@gendragoon/core";

/** What the sign-up screens need from the server (AccountsClient implements it). */
export interface SignupApi {
  terms(): Promise<TermsDocument>;
  markTermsRead(version: string): Promise<TosGrant>;
  agreeToTerms(grant: string): Promise<TosGrant>;
  validateUsername(username: string): Promise<CheckResult>;
  validateEmail(email: string): Promise<CheckResult>;
}

/** Requirement list: each line is red until it is met, then green. */
export function RequirementHints(props: { rules: RuleState[]; testId: string }) {
  return (
    <ul className="req-list" data-testid={props.testId} aria-live="polite">
      {props.rules.map((rule) => (
        <li key={rule.id} className={rule.met ? "req met" : "req unmet"} data-met={rule.met ? "true" : "false"} data-rule={rule.id}>
          <span className="req-icon" aria-hidden="true">{rule.met ? "✓" : "•"}</span>
          {rule.label}
          <span className="sr-only">{rule.met ? " (done)" : " (needed)"}</span>
        </li>
      ))}
    </ul>
  );
}

/** A field and its confirm box, with arrow buttons between them that copy the value across. */
export function PairedField(props: {
  id: string;
  label: string;
  confirmLabel: string;
  type: "email" | "password";
  value: string;
  confirm: string;
  onChange: (next: { value: string; confirm: string }) => void;
  error?: string | null;
  confirmError?: string | null;
  autoComplete?: string;
  readOnly?: boolean;
  children?: ReactNode;
}) {
  const pair = { value: props.value, confirm: props.confirm };
  const reveal = props.type === "password" ? "password" : "email";
  return (
    <div className="field-pair" data-testid={`${props.id}-pair`}>
      <label className="field">
        <span>{props.label}</span>
        <input
          id={props.id}
          data-testid={props.id}
          type={reveal}
          value={props.value}
          readOnly={props.readOnly}
          autoComplete={props.autoComplete}
          aria-invalid={props.error ? "true" : "false"}
          onChange={(e) => props.onChange({ ...pair, value: e.target.value })}
        />
      </label>
      {props.children}
      {props.error ? <p className="field-error" role="alert" data-testid={`${props.id}-error`}>{accountErrorText(props.error)}</p> : null}
      <div className="copy-arrows" role="group" aria-label={`Copy between ${props.label.toLowerCase()} and ${props.confirmLabel.toLowerCase()}`}>
        <button type="button" className="arrow-btn" data-testid={`${props.id}-copy-down`} aria-label={`Copy ${props.label.toLowerCase()} into ${props.confirmLabel.toLowerCase()}`}
          disabled={!props.value} onClick={() => props.onChange(copyAcross("down", pair))}>↓</button>
        <button type="button" className="arrow-btn" data-testid={`${props.id}-copy-up`} aria-label={`Copy ${props.confirmLabel.toLowerCase()} into ${props.label.toLowerCase()}`}
          disabled={!props.confirm || props.readOnly} onClick={() => props.onChange(copyAcross("up", pair))}>↑</button>
      </div>
      <label className="field">
        <span>{props.confirmLabel}</span>
        <input
          id={`${props.id}-confirm`}
          data-testid={`${props.id}-confirm`}
          type={reveal}
          value={props.confirm}
          autoComplete={props.autoComplete}
          aria-invalid={props.confirmError ? "true" : "false"}
          onChange={(e) => props.onChange({ ...pair, confirm: e.target.value })}
        />
      </label>
      {props.confirmError ? <p className="field-error" role="alert" data-testid={`${props.id}-confirm-error`}>{accountErrorText(props.confirmError)}</p> : null}
    </div>
  );
}

/** MM/DD/YYYY: typed (digits are formatted as you go) or picked from the calendar. */
export function BirthDateField(props: { value: string; onChange: (value: string) => void; error?: string | null }) {
  const parsed = parseBirthDate(props.value);
  return (
    <div className="field">
      <label htmlFor="dob"><span>Date of birth</span></label>
      <div className="dob-row">
        <input id="dob" data-testid="dob" inputMode="numeric" placeholder="MM/DD/YYYY" maxLength={10} value={props.value}
          aria-invalid={props.error ? "true" : "false"} onChange={(e) => props.onChange(maskBirthDateInput(e.target.value))} />
        <input type="date" className="dob-calendar" data-testid="dob-calendar" aria-label="Pick your date of birth from a calendar"
          value={parsed ? birthDateToIso(parsed) : ""} onChange={(e) => {
            const picked = birthDateFromIso(e.target.value);
            if (picked) props.onChange(formatBirthDate(picked));
          }} />
      </div>
      {props.error ? <p className="field-error" role="alert" data-testid="dob-error">{accountErrorText(props.error)}</p> : null}
    </div>
  );
}

export function TwoFactorPicker(props: {
  value: TwoFactorMethod | "";
  available?: AccountRules["twoFactor"];
  phone: string;
  acceptNo2faRisk: boolean;
  onChange: (next: { method: TwoFactorMethod; phone?: string; acceptNo2faRisk?: boolean }) => void;
  error?: string | null;
  phoneError?: string | null;
}) {
  return (
    <fieldset className="twofa" data-testid="twofa">
      <legend>Two-factor sign-in</legend>
      {TWO_FACTOR_OPTIONS.map((option) => {
        const available = twoFactorOptionAvailable(option, props.available);
        return (
          <label key={option.method} className={`twofa-option${props.value === option.method ? " active" : ""}${available ? "" : " disabled"}`} data-testid={`twofa-${option.method}`}>
            <input type="radio" name="twofa" value={option.method} checked={props.value === option.method} disabled={!available}
              onChange={() => props.onChange({ method: option.method })} />
            <span className="twofa-label">{option.label}</span>
            <span className="twofa-detail">{available ? option.detail : option.method === "redxai_auth" ? "Coming soon" : "Not available yet"}</span>
          </label>
        );
      })}
      {props.value === "phone" ? (
        <label className="field">
          <span>Phone number (with country code)</span>
          <input data-testid="phone" type="tel" inputMode="tel" placeholder="+1 555 123 4567" value={props.phone}
            onChange={(e) => props.onChange({ method: "phone", phone: e.target.value })} />
          {props.phoneError ? <p className="field-error" role="alert">{accountErrorText(props.phoneError)}</p> : null}
        </label>
      ) : null}
      {props.value === "none" ? (
        <div className="warn-box" role="alert" data-testid="no2fa-warning">
          <p>{NO_TWO_FACTOR_WARNING}</p>
          <label className="check">
            <input type="checkbox" data-testid="no2fa-ack" checked={props.acceptNo2faRisk}
              onChange={(e) => props.onChange({ method: "none", acceptNo2faRisk: e.target.checked })} />
            {NO_TWO_FACTOR_ACK_LABEL}
          </label>
        </div>
      ) : null}
      {props.error ? <p className="field-error" role="alert">{accountErrorText(props.error)}</p> : null}
    </fieldset>
  );
}

/** The Terms box: "Read ToS" opens at the end of the text, "Agree to ToS" after Read. */
export function TermsGate(props: {
  terms: TermsDocument | null;
  busy?: boolean;
  onRead: () => Promise<void> | void;
  onAgree: () => Promise<void> | void;
  initial?: typeof TOS_GATE_START;
}) {
  const [state, setState] = useState(props.initial ?? TOS_GATE_START);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Text shorter than the box is already fully visible.
    const el = box.current;
    if (el && props.terms && scrolledToEnd(el.scrollTop, el.clientHeight, el.scrollHeight) && el.scrollHeight > 0) {
      setState((s) => reduceTosGate(s, { type: "scrolled_end" }));
    }
  }, [props.terms]);
  return (
    <section className="tos" data-testid="tos">
      <h3>{props.terms?.title ?? "Terms of Service"}</h3>
      <div ref={box} className="tos-text" tabIndex={0} data-testid="tos-text" aria-label="Terms of Service text"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (scrolledToEnd(el.scrollTop, el.clientHeight, el.scrollHeight)) setState((s) => reduceTosGate(s, { type: "scrolled_end" }));
        }}>
        {props.terms ? props.terms.text.split(/\n{2,}/).map((para, i) => <p key={i}>{para.replace(/^#+\s*/, "").replace(/\*\*/g, "")}</p>) : <p className="skeleton-line" />}
      </div>
      {!state.scrolledToEnd ? <p className="sub" data-testid="tos-scroll-hint">Scroll to the end to continue.</p> : null}
      <div className="tos-actions">
        <button type="button" className={state.read ? "btn-ghost" : "btn"} data-testid="tos-read" disabled={!state.scrolledToEnd || state.read || props.busy}
          onClick={async () => { await props.onRead(); setState((s) => reduceTosGate(s, { type: "read" })); }}>
          {state.read ? "Read ✓" : "Read ToS"}
        </button>
        <button type="button" className="btn" data-testid="tos-agree" disabled={!state.read || state.agreed || props.busy}
          onClick={async () => { await props.onAgree(); setState((s) => reduceTosGate(s, { type: "agree" })); }}>
          Agree to ToS
        </button>
      </div>
    </section>
  );
}

export function QrCode(props: { value: string; label: string }) {
  const { size, path } = useMemo(() => qrSvgPath(props.value), [props.value]);
  return (
    <svg className="qr" data-testid="qr" role="img" aria-label={props.label} viewBox={`0 0 ${size} ${size}`} width={208} height={208} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#0d0b14" />
    </svg>
  );
}

/** After sign-up: scan the QR (authenticator) or enter the texted code (phone). */
export function TwoFactorSetup(props: {
  result: Pick<SignupResult, "totp" | "phoneMasked" | "smsError">;
  onConfirm: (code: string) => Promise<void>;
  /** Phone only: sends a new setup code. */
  onResend?: () => Promise<{ phoneMasked?: string }>;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(props.result.smsError ?? null);
  const [busy, setBusy] = useState(false);
  const [masked, setMasked] = useState(props.result.phoneMasked);
  return (
    <section className="twofa-setup" data-testid="twofa-setup">
      {props.result.totp ? (
        <>
          <h3>Scan with your authenticator app</h3>
          <QrCode value={props.result.totp.otpauthUri} label="QR code for your authenticator app" />
          <p className="sub">Can't scan? Enter this key: <code data-testid="totp-secret">{props.result.totp.secret.replace(/(.{4})/g, "$1 ").trim()}</code></p>
        </>
      ) : (
        <h3>{masked ? <>Enter the code we texted to {masked}</> : "Enter the code we text to your phone"}</h3>
      )}
      <label className="field">
        <span>6-digit code</span>
        <input data-testid="twofa-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
      </label>
      {error ? <p className="field-error" role="alert">{accountErrorText(error)}</p> : null}
      <button type="button" className="btn" data-testid="twofa-confirm" disabled={code.length !== 6 || busy} aria-busy={busy}
        onClick={async () => {
          setBusy(true); setError(null);
          try { await props.onConfirm(code); } catch (e) { setError((e as { code?: string }).code ?? "code_invalid"); } finally { setBusy(false); }
        }}>Turn on two-factor sign-in</button>
      {!props.result.totp && props.onResend ? (
        <button type="button" className="btn-ghost" data-testid="twofa-resend" disabled={busy}
          onClick={async () => {
            setBusy(true); setError(null);
            try { const sent = await props.onResend!(); if (sent.phoneMasked) setMasked(sent.phoneMasked); }
            catch (e) { setError((e as { code?: string }).code ?? "sms_send_failed"); } finally { setBusy(false); }
          }}>Send a new code</button>
      ) : null}
    </section>
  );
}

export interface SignupSubmit extends SignupFields {
  tosGrant: string;
}

/**
 * The whole sign-up: details, then the Terms (the account is created only
 * after "Agree to ToS"), then the second factor. `quick` completes a Google
 * or Red-XAI sign-in: no password, the email comes from the provider, every
 * other rule still applies.
 */
export function SignupForm(props: {
  api: SignupApi;
  rules?: AccountRules | null;
  now?: () => Date;
  quick?: { email: string };
  onSubmit: (fields: SignupSubmit) => Promise<SignupResult>;
  onConfirmTwoFactor: (code: string) => Promise<void>;
  /** Sends a new phone setup code to the number entered at sign-up. */
  onResendPhoneCode?: (phone: string) => Promise<{ phoneMasked?: string }>;
  onDone: () => void;
  onSignIn?: () => void;
}) {
  const now = props.now ?? (() => new Date());
  const requirePassword = !props.quick;
  const [step, setStep] = useState<"details" | "terms" | "twofa">("details");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState({ value: props.quick?.email ?? "", confirm: props.quick?.email ?? "" });
  const [password, setPassword] = useState({ value: "", confirm: "" });
  const [dob, setDob] = useState("");
  const [twoFactor, setTwoFactor] = useState<{ method: TwoFactorMethod | ""; phone: string; acceptNo2faRisk: boolean }>({ method: "", phone: "", acceptNo2faRisk: false });
  const [falseInfo, setFalseInfo] = useState(false);
  const [touched, setTouched] = useState(false);
  const [remote, setRemote] = useState<{ username?: string; email?: string }>({});
  const [terms, setTerms] = useState<TermsDocument | null>(null);
  const [grant, setGrant] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [result, setResult] = useState<SignupResult | null>(null);

  const fields: SignupFields = {
    username, email: email.value, emailConfirm: email.confirm, password: password.value, passwordConfirm: password.confirm,
    dob, twoFactor: twoFactor.method, phone: twoFactor.phone, acceptNo2faRisk: twoFactor.acceptNo2faRisk, acknowledgeFalseInfo: falseInfo,
  };
  const errors = validateSignup(fields, { now: now(), minAge: props.rules?.minAge, requirePassword });
  const show = (field: string, value: string) => (touched || value.length > 0 ? errors[field] ?? null : null);

  // Real-time server checks: availability for the username, deliverability and duplicates for the email.
  useEffect(() => {
    if (errors.username) return;
    const t = setTimeout(() => { void props.api.validateUsername(username).then((r) => setRemote((s) => ({ ...s, username: r.ok ? undefined : r.error }))).catch(() => undefined); }, 350);
    return () => clearTimeout(t);
  }, [username]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (errors.email || props.quick) return;
    const t = setTimeout(() => { void props.api.validateEmail(email.value).then((r) => setRemote((s) => ({ ...s, email: r.ok ? undefined : r.error }))).catch(() => undefined); }, 450);
    return () => clearTimeout(t);
  }, [email.value]); // eslint-disable-line react-hooks/exhaustive-deps

  const blocking = Object.keys(errors).length > 0 || Boolean(remote.username) || Boolean(remote.email);

  if (step === "twofa" && result) {
    const resend = props.onResendPhoneCode;
    return <TwoFactorSetup result={result} onConfirm={async (code) => { await props.onConfirmTwoFactor(code); props.onDone(); }}
      onResend={resend ? () => resend(twoFactor.phone) : undefined} />;
  }

  if (step === "terms") {
    return (
      <div className="signup page-in" data-testid="signup-terms">
        <TermsGate
          terms={terms}
          busy={busy}
          onRead={async () => { if (terms) setGrant((await props.api.markTermsRead(terms.version)).grant); }}
          onAgree={async () => {
            if (!grant) return;
            setBusy(true); setServerError(null);
            try {
              const agreed = await props.api.agreeToTerms(grant);
              const created = await props.onSubmit({ ...fields, tosGrant: agreed.grant });
              setResult(created);
              if (created.pending.includes("2fa_setup")) setStep("twofa"); else props.onDone();
            } catch (e) {
              const code = (e as { code?: string }).code ?? "unavailable";
              setServerError(code);
              if (!code.startsWith("tos_")) setStep("details");
            } finally { setBusy(false); }
          }}
        />
        {serverError ? <p className="field-error" role="alert" data-testid="signup-error">{accountErrorText(serverError)}</p> : null}
        <button type="button" className="btn-ghost" onClick={() => setStep("details")}>Back</button>
      </div>
    );
  }

  return (
    <form className="signup page-in" data-testid="signup" noValidate onSubmit={async (e) => {
      e.preventDefault();
      setTouched(true);
      if (blocking) return;
      setTerms(await props.api.terms());
      setStep("terms");
    }}>
      <h2>{props.quick ? "Finish setting up your account" : "Create your Red-XAI Account"}</h2>
      {serverError ? <p className="field-error" role="alert" data-testid="signup-error">{accountErrorText(serverError)}</p> : null}
      <label className="field">
        <span>Username</span>
        <input data-testid="username" autoComplete="username" value={username} aria-invalid={show("username", username) || remote.username ? "true" : "false"}
          onChange={(e) => { setUsername(e.target.value.trim()); setRemote((s) => ({ ...s, username: undefined })); }} />
      </label>
      <RequirementHints rules={usernameRules(username)} testId="username-hints" />
      {remote.username ? <p className="field-error" role="alert" data-testid="username-remote">{accountErrorText(remote.username)}</p> : null}

      <PairedField id="email" label="Email" confirmLabel="Confirm email" type="email" autoComplete="email" readOnly={Boolean(props.quick)}
        value={email.value} confirm={email.confirm} onChange={(next) => { setEmail(next); setRemote((s) => ({ ...s, email: undefined })); }}
        error={show("email", email.value) ?? remote.email ?? null} confirmError={show("emailConfirm", email.confirm)} />

      {requirePassword ? (
        <PairedField id="password" label="Password" confirmLabel="Confirm password" type="password" autoComplete="new-password"
          value={password.value} confirm={password.confirm} onChange={setPassword} confirmError={show("passwordConfirm", password.confirm)}>
          <RequirementHints rules={passwordRules(password.value)} testId="password-hints" />
        </PairedField>
      ) : null}

      <BirthDateField value={dob} onChange={setDob} error={show("dob", dob)} />

      <TwoFactorPicker value={twoFactor.method} available={props.rules?.twoFactor} phone={twoFactor.phone} acceptNo2faRisk={twoFactor.acceptNo2faRisk}
        error={touched ? errors.twoFactor : null} phoneError={show("phone", twoFactor.phone)}
        onChange={(next) => setTwoFactor((s) => ({
          method: next.method,
          phone: next.phone ?? (next.method === "phone" ? s.phone : ""),
          acceptNo2faRisk: next.method === "none" ? next.acceptNo2faRisk ?? (s.method === "none" ? s.acceptNo2faRisk : false) : false,
        }))} />

      <div className="warn-box" data-testid="false-info-warning">
        <p>{FALSE_INFO_WARNING}</p>
        <label className="check">
          <input type="checkbox" data-testid="false-info-ack" checked={falseInfo} onChange={(e) => setFalseInfo(e.target.checked)} />
          My details are true
        </label>
        {touched && errors.acknowledgeFalseInfo ? <p className="field-error" role="alert">{accountErrorText(errors.acknowledgeFalseInfo)}</p> : null}
      </div>

      <button type="submit" className="btn" data-testid="signup-continue" disabled={busy || (touched && blocking)}>Continue to the Terms</button>
      {props.onSignIn ? <button type="button" className="btn-ghost" onClick={props.onSignIn}>I already have an account</button> : null}
    </form>
  );
}
