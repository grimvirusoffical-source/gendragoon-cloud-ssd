import { useEffect, useRef, useState } from "react";
import { accountErrorText, type AccountRules, type AccountsClient } from "@gendragoon/core";
import { SignupForm } from "@gendragoon/ui";

/**
 * Sign-in and sign-up with a Red-XAI Account (contract v1.1).
 *
 * - "Create account" renders the sign-up form here and sends it to Red-XAI
 *   Accounts (`/v1/signup`, app `gendragoon`). The Gendragoon Terms and the
 *   false-information acknowledgement are part of that central sign-up. The
 *   second factor is confirmed with the new session, and then the same one-time
 *   session is traded for tokens with the session grant
 *   (`urn:red-xai:grant-type:session`), so there is no second sign-in in the
 *   browser. If that trade fails (the session is used up or older than 10
 *   minutes), the person signs in in the browser instead.
 * - After any sign-in Gendragoon asks its backend (`/v1/accounts/me`), which
 *   reads the `app_tos_version` claim. If the Gendragoon Terms changed since
 *   then, the person re-accepts them on the Red-XAI account page during the
 *   next browser sign-in (Red-XAI keeps the record, not Gendragoon).
 */
export interface AccountGateDeps {
  central: AccountsClient;
  /** Calls with the central session from sign-up. */
  centralWithSession: (session: string) => AccountsClient;
  gendragoon: AccountsClient;
  signIn: (mode: "sign-in" | "sign-up") => Promise<boolean>;
  /** Trades the one-time sign-up session for tokens (session grant). */
  adoptSession: (session: string) => Promise<boolean>;
}

type Stage = { name: "start" } | { name: "signup" } | { name: "finish-in-browser" } | { name: "checking" } | { name: "terms-changed" };

export function AccountGate(props: { deps: AccountGateDeps; onReady: () => void }) {
  const { deps } = props;
  const [stage, setStage] = useState<Stage>({ name: "start" });
  const [rules, setRules] = useState<AccountRules | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signupSession = useRef<{ token: string; client: AccountsClient } | null>(null);

  useEffect(() => {
    void deps.central.rules().then(setRules).catch(() => undefined);
  }, [deps.central]);

  async function afterSignIn() {
    setStage({ name: "checking" });
    try {
      const me = await deps.gendragoon.me();
      if (me.pending.includes("tos")) setStage({ name: "terms-changed" });
      else props.onReady();
    } catch (e) {
      setError((e as { code?: string }).code ?? "unavailable");
      setStage({ name: "start" });
    }
  }

  async function browserSignIn(mode: "sign-in" | "sign-up") {
    setBusy(true); setError(null);
    try {
      if (await deps.signIn(mode)) await afterSignIn();
    } catch (e) {
      setError((e as { code?: string; message?: string }).code ?? "sign_in_failed");
    } finally { setBusy(false); }
  }

  async function finishSignup() {
    const session = signupSession.current?.token;
    signupSession.current = null;
    if (!session) { setStage({ name: "finish-in-browser" }); return; }
    setBusy(true); setError(null);
    try {
      if (await deps.adoptSession(session)) await afterSignIn();
      else setStage({ name: "finish-in-browser" });
    } catch {
      setStage({ name: "finish-in-browser" });
    } finally { setBusy(false); }
  }

  const needSession = () => {
    if (!signupSession.current) throw Object.assign(new Error("unavailable"), { code: "unavailable" });
    return signupSession.current.client;
  };

  return (
    <main className="main account-gate page-in" data-testid="account-gate">
      {error ? <p className="field-error" role="alert" data-testid="account-error">{accountErrorText(error)}</p> : null}
      {stage.name === "start" ? (
        <section className="account-start">
          <h2>Gendragoon uses your Red-XAI Account</h2>
          <p className="sub">One account for every Red-XAI app.</p>
          <div className="tos-actions">
            <button type="button" className="btn" data-testid="account-sign-in" disabled={busy} aria-busy={busy} onClick={() => void browserSignIn("sign-in")}>Sign in</button>
            <button type="button" className="btn-ghost" data-testid="account-create" disabled={busy} onClick={() => setStage({ name: "signup" })}>Create account</button>
          </div>
        </section>
      ) : null}
      {stage.name === "signup" ? (
        <SignupForm
          api={deps.central}
          rules={rules}
          onSubmit={async (fields) => {
            const created = await deps.central.signup(fields);
            if (created.session) signupSession.current = { token: created.session, client: deps.centralWithSession(created.session) };
            return created;
          }}
          onConfirmTwoFactor={async (code) => { await needSession().confirmTwoFactor(code); }}
          onResendPhoneCode={async (phone) => needSession().resendSignupCode(phone)}
          onDone={() => void finishSignup()}
          onSignIn={() => setStage({ name: "start" })}
        />
      ) : null}
      {stage.name === "finish-in-browser" ? (
        <section className="account-start">
          <h2>Your account is ready</h2>
          <p className="sub">Sign in once in your browser to connect it to Gendragoon.</p>
          <button type="button" className="btn" data-testid="account-finish" disabled={busy} aria-busy={busy} onClick={() => void browserSignIn("sign-in")}>Sign in</button>
        </section>
      ) : null}
      {stage.name === "checking" ? <p className="sub" data-testid="account-checking">Checking your account…</p> : null}
      {stage.name === "terms-changed" ? (
        <section className="account-start">
          <h2>The Terms have changed</h2>
          <p className="sub">Sign in again in your browser. Your Red-XAI account page shows the new Gendragoon Terms to read and agree to.</p>
          <button type="button" className="btn" data-testid="account-terms-sign-in" disabled={busy} aria-busy={busy} onClick={() => void browserSignIn("sign-in")}>Review the Terms</button>
        </section>
      ) : null}
    </main>
  );
}
