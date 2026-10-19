import { useEffect, useRef, useState } from "react";
import { FALSE_INFO_WARNING, accountErrorText, type AccountRules, type AccountsClient, type TermsDocument } from "@gendragoon/core";
import { SignupForm, TermsGate } from "@gendragoon/ui";

/**
 * Sign-in and sign-up with a Red-XAI Account.
 *
 * - "Create account" renders the sign-up form here and sends it to Red-XAI
 *   Accounts (`/v1/signup`, app `gendragoon`). The second factor is confirmed
 *   with the new account session, then the person signs in once in the browser
 *   to give Gendragoon its tokens.
 * - After any sign-in, Gendragoon checks its own side (`/v1/accounts/me`): the
 *   Gendragoon Terms and the false-information acknowledgement, and finishes
 *   the profile if needed.
 */
export interface AccountGateDeps {
  central: AccountsClient;
  /** Calls with the central session from sign-up. */
  centralWithSession: (session: string) => AccountsClient;
  gendragoon: AccountsClient;
  signIn: (mode: "sign-in" | "sign-up") => Promise<boolean>;
}

type Stage =
  | { name: "start" }
  | { name: "signup" }
  | { name: "finish-in-browser" }
  | { name: "checking" }
  | { name: "complete"; terms: TermsDocument }
  | { name: "accept-terms"; terms: TermsDocument };

export function AccountGate(props: { deps: AccountGateDeps; onReady: () => void }) {
  const { deps } = props;
  const [stage, setStage] = useState<Stage>({ name: "start" });
  const [rules, setRules] = useState<AccountRules | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [falseInfo, setFalseInfo] = useState(false);
  const [grant, setGrant] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sessionRef = useRef<AccountsClient | null>(null);

  useEffect(() => {
    void deps.central.rules().then(setRules).catch(() => undefined);
  }, [deps.central]);

  async function afterSignIn() {
    setStage({ name: "checking" });
    try {
      const me = await deps.gendragoon.me();
      if (me.pending.includes("tos")) setStage({ name: "accept-terms", terms: await deps.gendragoon.terms() });
      else props.onReady();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "account_setup_required") setStage({ name: "complete", terms: await deps.gendragoon.terms() });
      else { setError(code ?? "unavailable"); setStage({ name: "start" }); }
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

  const gendragoonTerms = (terms: TermsDocument, finish: (agreed: string) => Promise<unknown>) => (
    <TermsGate
      terms={terms}
      busy={busy}
      onRead={async () => setGrant((await deps.gendragoon.markTermsRead(terms.version)).grant)}
      onAgree={async () => {
        if (!grant) return;
        setBusy(true); setError(null);
        try {
          await finish((await deps.gendragoon.agreeToTerms(grant)).grant);
          props.onReady();
        } catch (e) { setError((e as { code?: string }).code ?? "unavailable"); } finally { setBusy(false); }
      }}
    />
  );

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
            if (created.session) sessionRef.current = deps.centralWithSession(created.session);
            return created;
          }}
          onConfirmTwoFactor={async (code) => { await sessionRef.current?.confirmTwoFactor(code); }}
          onResendPhoneCode={async (phone) => {
            if (!sessionRef.current) throw Object.assign(new Error("unavailable"), { code: "unavailable" });
            return sessionRef.current.setupTwoFactor({ method: "phone", phone });
          }}
          onDone={() => setStage({ name: "finish-in-browser" })}
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
      {stage.name === "complete" ? (
        <section className="signup">
          <h2>Finish setting up Gendragoon</h2>
          <div className="warn-box">
            <p>{FALSE_INFO_WARNING}</p>
            <label className="check">
              <input type="checkbox" data-testid="complete-false-info" checked={falseInfo} onChange={(e) => setFalseInfo(e.target.checked)} />
              My details are true
            </label>
          </div>
          {falseInfo ? gendragoonTerms(stage.terms, (tosGrant) => deps.gendragoon.complete({ tosGrant, acknowledgeFalseInfo: true })) : null}
        </section>
      ) : null}
      {stage.name === "accept-terms" ? (
        <section className="signup">
          <h2>The Terms have changed</h2>
          <p className="sub">Read and agree to the new Terms to keep using Gendragoon.</p>
          {gendragoonTerms(stage.terms, (tosGrant) => deps.gendragoon.acceptTerms(tosGrant))}
        </section>
      ) : null}
    </main>
  );
}
