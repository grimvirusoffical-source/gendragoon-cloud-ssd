import { useState } from "react";
import { PASSPHRASE_LOSS_WARNING } from "@gendragoon/core";

export function PassphraseSetup(props: {
  onSubmit: (passphrase: string) => void;
  busy?: boolean;
}) {
  const [passphrase, setPassphrase] = useState("");
  return (
    <section className="panel stack" data-testid="passphrase-setup">
      <strong>Recovery passphrase</strong>
      <p className="help" data-testid="passphrase-warning">{PASSPHRASE_LOSS_WARNING}</p>
      <p className="help">
        This device wraps the workspace key with that passphrase. A new device asks for it once, then keeps the key in the OS keychain.
      </p>
      <input
        type="password"
        autoComplete="new-password"
        data-testid="passphrase-input"
        aria-label="Recovery passphrase"
        value={passphrase}
        onChange={(event) => setPassphrase(event.target.value)}
      />
      <div className="actions">
        <button
          type="button"
          className="btn"
          data-testid="passphrase-save"
          disabled={props.busy || passphrase.trim().length < 8}
          onClick={() => props.onSubmit(passphrase)}
        >
          Save recovery passphrase
        </button>
      </div>
    </section>
  );
}
