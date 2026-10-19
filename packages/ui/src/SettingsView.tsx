import { useState } from "react";
import type { Settings, SortCategory } from "@gendragoon/core";
import { SORT_CATEGORIES, SUPPORT_CONTACT } from "@gendragoon/core";
import { PassphraseSetup } from "./PassphraseSetup.js";
import { ThemeToggle } from "./ThemeToggle.js";

/** Settings copy for a terminal deletion poll. `failed` with retryable false shows support and Dismiss. */
export function deletionFailureNotice(result: { status: string; retryable?: boolean }): {
  message: string;
  retryable: boolean;
  supportContact?: string;
} | null {
  if (result.status !== "failed") return null;
  const retryable = result.retryable === true;
  return {
    message: retryable ? "Account deletion failed. You can retry it." : "Account deletion failed.",
    retryable,
    supportContact: retryable ? undefined : SUPPORT_CONTACT.value,
  };
}

export function SettingsView(props: {
  settings: Settings;
  rows: { extension: string; category: SortCategory; source: "default" | "override" }[];
  onChange: (extension: string, category: SortCategory) => void;
  onDeleteAccount: () => void;
  deleting?: boolean;
  reauthRequired?: boolean;
  onSignInAgain?: () => void;
  onPassphrase?: (passphrase: string) => void;
  deletionMessage?: string | null;
  deletionRetryable?: boolean;
  supportContact?: string | null;
  onRetryDeletion?: () => void;
  onDismissDeletion?: () => void;
}) {
  const [step, setStep] = useState<"closed" | "review" | "confirm">("closed");
  return (
    <section data-testid="settings-view">
      <header className="topbar">
        <div>
          <div className="kicker"><span className="dot" /> SETTINGS</div>
          <h2>Type sorting</h2>
          <p className="sub">Pictures, Videos, Audio, Documents, Archives, Apps, and Other. Overrides are saved in Settings. Every client starts from the same sort-map.json.</p>
        </div>
      </header>
      <div className="panel appearance-row" data-testid="appearance">
        <div>
          <h3>Appearance</h3>
          <p className="help">Dark is the default. System follows your device and changes with it.</p>
        </div>
        <ThemeToggle />
      </div>
      <div className="panel">
        {props.rows.map((row) => (
          <div className="map-row" key={row.extension}>
            <code>{row.extension}</code>
            <span className="kind">{row.source === "override" ? "Saved override" : "Canonical map"}</span>
            <select
              aria-label={`Category for ${row.extension}`}
              data-testid={`sort-${row.extension}`}
              value={row.category}
              onChange={(event) => props.onChange(row.extension, event.target.value as SortCategory)}
            >
              {SORT_CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
          </div>
        ))}
      </div>
      <p className="footer-note">{Object.keys(props.settings.sortOverrides.extensions).length} extension override(s) stored on this device.</p>
      {props.onPassphrase ? <PassphraseSetup onSubmit={props.onPassphrase} /> : null}
      <section className="panel stack" data-testid="delete-account-panel" style={{ marginTop: 16 }}>
        <strong>Delete account</strong>
        <p className="help">
          This cancels every Stripe subscription, deletes objects in GenDragoon&apos;s bucket, and deletes the Firebase user.
          Storage you connected yourself is left in place. Keys for it are removed from this device.
        </p>
        {step === "closed" ? (
          <div className="actions">
            <button type="button" className="btn-danger" data-testid="delete-account" onClick={() => setStep("review")}>
              Delete account
            </button>
          </div>
        ) : null}
        {step === "review" ? (
          <div className="stack">
            <p className="help">Sign in again if it has been more than 5 minutes. You will be signed out when deletion finishes.</p>
            <div className="actions">
              <button type="button" className="btn" data-testid="delete-account-continue" onClick={() => setStep("confirm")}>
                Continue
              </button>
              <button type="button" className="btn-ghost" onClick={() => setStep("closed")}>Back</button>
            </div>
          </div>
        ) : null}
        {step === "confirm" ? (
          <div className="stack">
            <p className="help">Delete the account permanently. This cannot be undone.</p>
            {props.reauthRequired ? (
              <div className="stack" data-testid="delete-account-reauth-prompt">
                <p className="help">Your last sign-in is older than 5 minutes. Sign in again and we will retry deleting the account.</p>
                <div className="actions">
                  <button type="button" className="btn" data-testid="delete-account-reauth" onClick={props.onSignInAgain}>
                    Sign in again
                  </button>
                </div>
              </div>
            ) : null}
            <div className="actions">
              <button
                type="button"
                className="btn-danger"
                data-testid="delete-account-confirm"
                disabled={props.deleting}
                onClick={props.onDeleteAccount}
              >
                Delete account permanently
              </button>
              <button type="button" className="btn-ghost" onClick={() => setStep("closed")}>Back</button>
            </div>
          </div>
        ) : null}
        {props.deletionMessage ? (
          <div className="stack" data-testid="delete-account-notice">
            <p className="help">{props.deletionMessage}</p>
            {props.supportContact ? (
              <p className="help" data-testid="delete-account-support">Contact {props.supportContact}</p>
            ) : null}
            <div className="actions">
              {props.deletionRetryable ? (
                <button type="button" className="btn" data-testid="delete-account-retry" disabled={props.deleting} onClick={props.onRetryDeletion}>
                  Retry
                </button>
              ) : null}
              <button type="button" className="btn-ghost" data-testid="delete-account-dismiss" onClick={props.onDismissDeletion}>
                Dismiss
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </section>
  );
}
