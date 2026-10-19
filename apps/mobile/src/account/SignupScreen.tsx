import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import {
  FALSE_INFO_WARNING,
  NO_TWO_FACTOR_ACK_LABEL,
  NO_TWO_FACTOR_WARNING,
  TOS_GATE_START,
  TWO_FACTOR_OPTIONS,
  accountErrorText,
  twoFactorOptionAvailable,
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
import { radii, space, tapTarget, type as typeScale, type MobileColors } from "../theme";
import { useStyles, useTheme } from "../themeContext";
import { Banner, Button, Screen, Title } from "../ui";

export interface MobileSignupApi {
  terms(): Promise<TermsDocument>;
  markTermsRead(version: string): Promise<TosGrant>;
  agreeToTerms(grant: string): Promise<TosGrant>;
  validateUsername(username: string): Promise<CheckResult>;
  validateEmail(email: string): Promise<CheckResult>;
}

/** Requirement lines: red until met, then green. */
export function Hints(props: { rules: RuleState[]; testID: string }) {
  const styles = useStyles(makeStyles);
  return (
    <View testID={props.testID} accessibilityLiveRegion="polite">
      {props.rules.map((rule) => (
        <Text key={rule.id} testID={`${props.testID}-${rule.id}`} style={rule.met ? styles.met : styles.unmet}
          accessibilityLabel={`${rule.label}, ${rule.met ? "done" : "needed"}`}>
          {rule.met ? "✓ " : "• "}{rule.label}
        </Text>
      ))}
    </View>
  );
}

function Input(props: { label: string; value: string; onChange: (v: string) => void; testID: string; secure?: boolean; error?: string | null;
  editable?: boolean; keyboardType?: "default" | "email-address" | "number-pad" | "phone-pad"; placeholder?: string; autoComplete?: "email" | "username" | "new-password" | "tel" | "off" }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput accessibilityLabel={props.label} testID={props.testID} value={props.value} onChangeText={props.onChange} secureTextEntry={props.secure}
        editable={props.editable} autoCapitalize="none" autoCorrect={false} keyboardType={props.keyboardType} autoComplete={props.autoComplete}
        placeholder={props.placeholder ?? props.label} placeholderTextColor={colors.muted} style={[styles.input, props.error ? styles.inputError : null]} />
      {props.error ? <Text testID={`${props.testID}-error`} accessibilityRole="alert" style={styles.error}>{accountErrorText(props.error)}</Text> : null}
    </View>
  );
}

/** A field and its confirm box, with ↓ / ↑ between them that copy the value across. */
export function PairedInput(props: { id: string; label: string; confirmLabel: string; secure?: boolean; value: string; confirm: string;
  onChange: (next: { value: string; confirm: string }) => void; error?: string | null; confirmError?: string | null; readOnly?: boolean; hints?: RuleState[] }) {
  const styles = useStyles(makeStyles);
  const pair = { value: props.value, confirm: props.confirm };
  const arrow = (dir: "down" | "up", disabled: boolean, label: string) => (
    <Pressable testID={`${props.id}-copy-${dir}`} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled}
      hitSlop={6} onPress={() => props.onChange(copyAcross(dir, pair))} style={({ pressed }) => [styles.arrow, disabled ? styles.arrowDisabled : null, pressed ? styles.arrowPressed : null]}>
      <Text style={styles.arrowText}>{dir === "down" ? "↓" : "↑"}</Text>
    </Pressable>
  );
  return (
    <View style={styles.pair}>
      <Input label={props.label} testID={props.id} value={props.value} secure={props.secure} error={props.error} editable={!props.readOnly}
        keyboardType={props.secure ? "default" : "email-address"} autoComplete={props.secure ? "new-password" : "email"}
        onChange={(value) => props.onChange({ ...pair, value })} />
      {props.hints ? <Hints rules={props.hints} testID={`${props.id}-hints`} /> : null}
      <View style={styles.arrows}>
        {arrow("down", !props.value, `Copy ${props.label.toLowerCase()} into ${props.confirmLabel.toLowerCase()}`)}
        {arrow("up", !props.confirm || props.readOnly === true, `Copy ${props.confirmLabel.toLowerCase()} into ${props.label.toLowerCase()}`)}
      </View>
      <Input label={props.confirmLabel} testID={`${props.id}-confirm`} value={props.confirm} secure={props.secure} error={props.confirmError}
        keyboardType={props.secure ? "default" : "email-address"} autoComplete={props.secure ? "new-password" : "email"}
        onChange={(confirm) => props.onChange({ ...pair, confirm })} />
    </View>
  );
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** MM/DD/YYYY typed, or picked from the calendar below the field. */
export function BirthDateInput(props: { value: string; onChange: (v: string) => void; error?: string | null; now: Date }) {
  const styles = useStyles(makeStyles);
  const parsed = parseBirthDate(props.value);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => ({ year: parsed?.year ?? props.now.getUTCFullYear() - 18, month: parsed ? parsed.month - 1 : 0 }));
  const days = new Date(Date.UTC(view.year, view.month + 1, 0)).getUTCDate();
  const shift = (months: number) => setView((v) => {
    const total = v.year * 12 + v.month + months;
    return { year: Math.floor(total / 12), month: total % 12 };
  });
  return (
    <View style={styles.field}>
      <View style={styles.row}>
        <View style={styles.grow}>
          <Input label="Date of birth" testID="dob" placeholder="MM/DD/YYYY" keyboardType="number-pad" value={props.value} error={props.error}
            onChange={(v) => props.onChange(maskBirthDateInput(v))} />
        </View>
        <Pressable testID="dob-calendar" accessibilityRole="button" accessibilityLabel="Pick your date of birth from a calendar" accessibilityState={{ expanded: open }}
          onPress={() => setOpen((o) => !o)} style={({ pressed }) => [styles.calendarButton, pressed ? styles.arrowPressed : null]}>
          <Text style={styles.arrowText}>📅</Text>
        </Pressable>
      </View>
      {open ? (
        <View style={styles.calendar} testID="dob-calendar-panel">
          <View style={styles.calendarHead}>
            <Pressable testID="dob-prev-year" accessibilityLabel="Previous year" onPress={() => shift(-12)} style={styles.navBtn}><Text style={styles.arrowText}>«</Text></Pressable>
            <Pressable testID="dob-prev-month" accessibilityLabel="Previous month" onPress={() => shift(-1)} style={styles.navBtn}><Text style={styles.arrowText}>‹</Text></Pressable>
            <Text style={styles.calendarTitle} testID="dob-calendar-title">{MONTHS[view.month]} {view.year}</Text>
            <Pressable testID="dob-next-month" accessibilityLabel="Next month" onPress={() => shift(1)} style={styles.navBtn}><Text style={styles.arrowText}>›</Text></Pressable>
            <Pressable testID="dob-next-year" accessibilityLabel="Next year" onPress={() => shift(12)} style={styles.navBtn}><Text style={styles.arrowText}>»</Text></Pressable>
          </View>
          <View style={styles.days}>
            {Array.from({ length: days }, (_, i) => i + 1).map((day) => {
              const selected = parsed?.year === view.year && parsed.month === view.month + 1 && parsed.day === day;
              return (
                <Pressable key={day} testID={`dob-day-${day}`} accessibilityRole="button" accessibilityLabel={`${MONTHS[view.month]} ${day}, ${view.year}`}
                  accessibilityState={{ selected }} style={[styles.day, selected ? styles.daySelected : null]}
                  onPress={() => { props.onChange(formatBirthDate({ year: view.year, month: view.month + 1, day })); setOpen(false); }}>
                  <Text style={selected ? styles.daySelectedText : styles.dayText}>{day}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
    </View>
  );
}

export function TwoFactorChoice(props: { value: TwoFactorMethod | ""; available?: AccountRules["twoFactor"]; phone: string; ack: boolean; phoneError?: string | null;
  onChange: (next: { method: TwoFactorMethod; phone?: string; ack?: boolean }) => void }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.section} accessibilityRole="radiogroup" testID="twofa">
      <Text style={styles.label}>Two-factor sign-in</Text>
      {TWO_FACTOR_OPTIONS.map((option) => {
        const available = twoFactorOptionAvailable(option, props.available);
        const detail = available ? option.detail : option.method === "redxai_auth" ? "Coming soon" : "Not available yet";
        return (
          <View key={option.method}>
            <Button testID={`twofa-${option.method}`} label={option.label} tone="secondary" selected={props.value === option.method} disabled={!available}
              accessibilityHint={detail} onPress={() => props.onChange({ method: option.method })} />
            <Text style={styles.helper} testID={`twofa-${option.method}-detail`}>{detail}</Text>
          </View>
        );
      })}
      {props.value === "phone" ? (
        <Input label="Phone number (with country code)" testID="phone" keyboardType="phone-pad" autoComplete="tel" placeholder="+1 555 123 4567" value={props.phone}
          error={props.phoneError} onChange={(phone) => props.onChange({ method: "phone", phone })} />
      ) : null}
      {props.value === "none" ? (
        <Banner tone="warn" alert testID="no2fa-warning">{NO_TWO_FACTOR_WARNING}</Banner>
      ) : null}
      {props.value === "none" ? <Check testID="no2fa-ack" label={NO_TWO_FACTOR_ACK_LABEL} checked={props.ack} onChange={(ack) => props.onChange({ method: "none", ack })} /> : null}
    </View>
  );
}

function Check(props: { testID: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable testID={props.testID} accessibilityRole="checkbox" accessibilityState={{ checked: props.checked }} accessibilityLabel={props.label}
      onPress={() => props.onChange(!props.checked)} style={styles.check}>
      <View style={[styles.box, props.checked ? styles.boxOn : null]}>{props.checked ? <Text style={styles.boxTick}>✓</Text> : null}</View>
      <Text style={styles.checkLabel}>{props.label}</Text>
    </Pressable>
  );
}

/** Scroll to the end, then "Read ToS", then "Agree to ToS". */
export function TermsGateMobile(props: { terms: TermsDocument; busy?: boolean; onRead: () => Promise<void>; onAgree: () => Promise<void> }) {
  const styles = useStyles(makeStyles);
  const [state, setState] = useState(TOS_GATE_START);
  const layout = useRef({ height: 0, content: 0 });
  const check = (offset: number) => {
    if (scrolledToEnd(offset, layout.current.height, layout.current.content)) setState((s) => reduceTosGate(s, { type: "scrolled_end" }));
  };
  return (
    <View style={styles.section} testID="tos">
      <Text style={styles.heading}>{props.terms.title}</Text>
      <ScrollView testID="tos-text" style={styles.tosBox} nestedScrollEnabled scrollEventThrottle={64}
        onLayout={(e) => { layout.current.height = e.nativeEvent.layout.height; check(0); }}
        onContentSizeChange={(_, h) => { layout.current.content = h; }}
        onScroll={(e) => {
          layout.current = { height: e.nativeEvent.layoutMeasurement.height, content: e.nativeEvent.contentSize.height };
          check(e.nativeEvent.contentOffset.y);
        }}>
        {props.terms.text.split(/\n{2,}/).map((para, i) => <Text key={i} style={styles.tosText}>{para.replace(/^#+\s*/, "").replace(/\*\*/g, "")}</Text>)}
      </ScrollView>
      {!state.scrolledToEnd ? <Text style={styles.helper} testID="tos-scroll-hint">Scroll to the end to continue.</Text> : null}
      <Button testID="tos-read" label={state.read ? "Read ✓" : "Read ToS"} tone={state.read ? "secondary" : "primary"} disabled={!state.scrolledToEnd || state.read || props.busy}
        onPress={async () => { await props.onRead(); setState((s) => reduceTosGate(s, { type: "read" })); }} />
      <Button testID="tos-agree" label="Agree to ToS" disabled={!state.read || state.agreed || props.busy}
        onPress={async () => { await props.onAgree(); setState((s) => reduceTosGate(s, { type: "agree" })); }} />
    </View>
  );
}

export function QrCodeMobile(props: { value: string }) {
  const { size, path } = useMemo(() => qrSvgPath(props.value), [props.value]);
  return (
    <Svg testID="qr" width={208} height={208} viewBox={`0 0 ${size} ${size}`} accessibilityLabel="QR code for your authenticator app">
      <Rect width={size} height={size} fill="#ffffff" />
      <Path d={path} fill="#0d0b14" />
    </Svg>
  );
}

function FadeIn(props: { children: React.ReactNode; stepKey: string }) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    opacity.setValue(0);
    Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }).start();
  }, [props.stepKey, opacity]);
  return <Animated.View style={{ opacity }}>{props.children}</Animated.View>;
}

export interface MobileSignupSubmit extends SignupFields { tosGrant: string }

/**
 * Sign-up for a Red-XAI Account. The account is created only after
 * "Agree to ToS". `quick` finishes a Google or Red-XAI sign-in: no password,
 * the email is the provider's, every other rule applies.
 */
export function SignupScreen(props: {
  api: MobileSignupApi;
  rules?: AccountRules | null;
  now?: () => Date;
  quick?: { email: string };
  onSubmit: (fields: MobileSignupSubmit) => Promise<SignupResult>;
  onConfirmTwoFactor: (code: string) => Promise<void>;
  /** Sends a new phone setup code to the number entered at sign-up. */
  onResendPhoneCode?: (phone: string) => Promise<{ phoneMasked?: string }>;
  onDone: () => void;
}) {
  const styles = useStyles(makeStyles);
  const now = props.now ?? (() => new Date());
  const [step, setStep] = useState<"details" | "terms" | "twofa">("details");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState({ value: props.quick?.email ?? "", confirm: props.quick?.email ?? "" });
  const [password, setPassword] = useState({ value: "", confirm: "" });
  const [dob, setDob] = useState("");
  const [twoFactor, setTwoFactor] = useState<{ method: TwoFactorMethod | ""; phone: string; ack: boolean }>({ method: "", phone: "", ack: false });
  const [falseInfo, setFalseInfo] = useState(false);
  const [touched, setTouched] = useState(false);
  const [remote, setRemote] = useState<{ username?: string; email?: string }>({});
  const [terms, setTerms] = useState<TermsDocument | null>(null);
  const [grant, setGrant] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [result, setResult] = useState<SignupResult | null>(null);
  const [code, setCode] = useState("");

  const fields: SignupFields = {
    username, email: email.value, emailConfirm: email.confirm, password: password.value, passwordConfirm: password.confirm, dob,
    twoFactor: twoFactor.method, phone: twoFactor.phone, acceptNo2faRisk: twoFactor.ack, acknowledgeFalseInfo: falseInfo,
  };
  const errors = validateSignup(fields, { now: now(), minAge: props.rules?.minAge, requirePassword: !props.quick });
  const show = (field: string, value: string) => (touched || value.length > 0 ? errors[field] ?? null : null);
  const blocking = Object.keys(errors).length > 0 || Boolean(remote.username || remote.email);

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

  if (step === "twofa" && result) {
    return (
      <Screen testID="twofa-setup">
        <FadeIn stepKey="twofa">
          <Title>{result.totp ? "Scan with your authenticator app" : `Enter the code we texted to ${result.phoneMasked ?? "your phone"}`}</Title>
          {result.smsError && !serverError ? <Banner tone="danger" testID="twofa-sms-error">{accountErrorText(result.smsError)}</Banner> : null}
          {result.totp ? <QrCodeMobile value={result.totp.otpauthUri} /> : null}
          {result.totp ? <Text style={styles.helper} selectable testID="totp-secret">{result.totp.secret.replace(/(.{4})/g, "$1 ").trim()}</Text> : null}
          <Input label="6-digit code" testID="twofa-code" keyboardType="number-pad" value={code} onChange={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))} error={serverError} />
          <Button testID="twofa-confirm" label="Turn on two-factor sign-in" disabled={code.length !== 6 || busy} onPress={async () => {
            setBusy(true); setServerError(null);
            try { await props.onConfirmTwoFactor(code); props.onDone(); } catch (e) { setServerError((e as { code?: string }).code ?? "code_invalid"); } finally { setBusy(false); }
          }} />
          {!result.totp && props.onResendPhoneCode ? (
            <Button testID="twofa-resend" label="Send a new code" tone="ghost" disabled={busy} onPress={async () => {
              setBusy(true); setServerError(null);
              try {
                const sent = await props.onResendPhoneCode!(twoFactor.phone);
                setResult({ ...result, smsError: undefined, phoneMasked: sent.phoneMasked ?? result.phoneMasked });
              } catch (e) { setServerError((e as { code?: string }).code ?? "sms_send_failed"); } finally { setBusy(false); }
            }} />
          ) : null}
        </FadeIn>
      </Screen>
    );
  }

  if (step === "terms" && terms) {
    return (
      <Screen testID="signup-terms">
        <FadeIn stepKey="terms">
          <TermsGateMobile terms={terms} busy={busy}
            onRead={async () => setGrant((await props.api.markTermsRead(terms.version)).grant)}
            onAgree={async () => {
              if (!grant) return;
              setBusy(true); setServerError(null);
              try {
                const agreed = await props.api.agreeToTerms(grant);
                const created = await props.onSubmit({ ...fields, tosGrant: agreed.grant });
                setResult(created);
                if (created.pending.includes("2fa_setup")) setStep("twofa"); else props.onDone();
              } catch (e) {
                const c = (e as { code?: string }).code ?? "unavailable";
                setServerError(c);
                if (!c.startsWith("tos_")) setStep("details");
              } finally { setBusy(false); }
            }} />
          {serverError ? <Banner tone="danger" testID="signup-error">{accountErrorText(serverError)}</Banner> : null}
          <Button label="Back" tone="ghost" onPress={() => setStep("details")} />
        </FadeIn>
      </Screen>
    );
  }

  return (
    <Screen testID="signup">
      <FadeIn stepKey="details">
        <Title kicker="Red-XAI Account">{props.quick ? "Finish setting up your account" : "Create your account"}</Title>
        {serverError ? <Banner tone="danger" testID="signup-error">{accountErrorText(serverError)}</Banner> : null}
        <Input label="Username" testID="username" autoComplete="username" value={username} error={remote.username ?? null}
          onChange={(v) => { setUsername(v.trim()); setRemote((s) => ({ ...s, username: undefined })); }} />
        <Hints rules={usernameRules(username)} testID="username-hints" />
        <PairedInput id="email" label="Email" confirmLabel="Confirm email" readOnly={Boolean(props.quick)} value={email.value} confirm={email.confirm}
          error={show("email", email.value) ?? remote.email ?? null} confirmError={show("emailConfirm", email.confirm)}
          onChange={(next) => { setEmail(next); setRemote((s) => ({ ...s, email: undefined })); }} />
        {!props.quick ? (
          <PairedInput id="password" label="Password" confirmLabel="Confirm password" secure value={password.value} confirm={password.confirm}
            confirmError={show("passwordConfirm", password.confirm)} hints={passwordRules(password.value)} onChange={setPassword} />
        ) : null}
        <BirthDateInput value={dob} onChange={setDob} error={show("dob", dob)} now={now()} />
        <TwoFactorChoice value={twoFactor.method} available={props.rules?.twoFactor} phone={twoFactor.phone} ack={twoFactor.ack} phoneError={show("phone", twoFactor.phone)}
          onChange={(next) => setTwoFactor((s) => ({
            method: next.method,
            phone: next.phone ?? (next.method === "phone" ? s.phone : ""),
            ack: next.method === "none" ? next.ack ?? (s.method === "none" ? s.ack : false) : false,
          }))} />
        {touched && errors.twoFactor ? <Text style={styles.error} accessibilityRole="alert">{accountErrorText(errors.twoFactor)}</Text> : null}
        <Banner tone="warn" testID="false-info-warning">{FALSE_INFO_WARNING}</Banner>
        <Check testID="false-info-ack" label="My details are true" checked={falseInfo} onChange={setFalseInfo} />
        {touched && errors.acknowledgeFalseInfo ? <Text style={styles.error} accessibilityRole="alert">{accountErrorText(errors.acknowledgeFalseInfo)}</Text> : null}
        <Button testID="signup-continue" label="Continue to the Terms" disabled={busy || (touched && blocking)} onPress={async () => {
          setTouched(true);
          if (blocking) return;
          try { setTerms(await props.api.terms()); setStep("terms"); } catch (e) { setServerError((e as { code?: string }).code ?? "unavailable"); }
        }} />
      </FadeIn>
    </Screen>
  );
}

const makeStyles = (colors: MobileColors) => StyleSheet.create({
  field: { gap: space.xs, marginBottom: space.sm },
  label: { color: colors.text, fontSize: typeScale.labelSize, fontWeight: typeScale.labelWeight },
  helper: { color: colors.muted, fontSize: typeScale.helpSize, marginBottom: space.xs },
  heading: { color: colors.text, fontSize: typeScale.labelSize + 2, fontWeight: "700" },
  input: { minHeight: tapTarget, borderWidth: 1, borderColor: colors.controlBorder, borderRadius: radii.md, color: colors.text, fontSize: typeScale.bodySize, paddingHorizontal: space.md, backgroundColor: colors.input },
  inputError: { borderColor: colors.dangerBorder },
  error: { color: colors.dangerText, fontSize: typeScale.helpSize },
  met: { color: colors.ok, fontSize: typeScale.helpSize },
  unmet: { color: colors.danger, fontSize: typeScale.helpSize },
  pair: { marginBottom: space.sm },
  arrows: { flexDirection: "row", justifyContent: "center", gap: space.md, marginVertical: space.xs },
  arrow: { minWidth: tapTarget, minHeight: 36, borderRadius: radii.md, borderWidth: 1, borderColor: colors.controlBorder, alignItems: "center", justifyContent: "center" },
  arrowDisabled: { opacity: 0.4 },
  arrowPressed: { backgroundColor: colors.secondaryBg },
  arrowText: { color: colors.text, fontSize: 18 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  grow: { flex: 1 },
  calendarButton: { width: tapTarget, height: tapTarget, marginTop: 22, borderRadius: radii.md, borderWidth: 1, borderColor: colors.controlBorder, alignItems: "center", justifyContent: "center" },
  calendar: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, backgroundColor: colors.surfaceRaised, padding: space.sm },
  calendarHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  calendarTitle: { color: colors.text, fontWeight: "600" },
  navBtn: { minWidth: 36, minHeight: 36, alignItems: "center", justifyContent: "center" },
  days: { flexDirection: "row", flexWrap: "wrap", marginTop: space.xs },
  day: { width: "14.28%", minHeight: 40, alignItems: "center", justifyContent: "center", borderRadius: radii.md },
  daySelected: { backgroundColor: colors.primary },
  dayText: { color: colors.text },
  daySelectedText: { color: colors.primaryText, fontWeight: "700" },
  section: { gap: space.sm, marginBottom: space.md },
  check: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: tapTarget },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: colors.controlBorder, alignItems: "center", justifyContent: "center" },
  boxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  boxTick: { color: colors.primaryText, fontSize: 14, fontWeight: "700" },
  checkLabel: { color: colors.text, flex: 1 },
  tosBox: { maxHeight: 320, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, backgroundColor: colors.input, padding: space.md },
  tosText: { color: colors.muted, fontSize: typeScale.helpSize, lineHeight: 20, marginBottom: space.sm },
});
