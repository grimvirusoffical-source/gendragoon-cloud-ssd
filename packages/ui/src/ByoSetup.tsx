import { LAUNCH_BYO_PROVIDERS, type ByoProviderId } from "@gendragoon/core";
import { useState } from "react";

export function ByoSetup(props: {
  onChallenge: (input: { provider: ByoProviderId; endpoint: string; bucket: string }) => void;
  message: string | null;
}) {
  const [provider, setProvider] = useState<ByoProviderId>("r2");
  const [endpoint, setEndpoint] = useState("https://example.r2.cloudflarestorage.com");
  const [bucket, setBucket] = useState("library");
  return (
    <section data-testid="byo-setup">
      <header className="topbar">
        <div>
          <div className="kicker"><span className="dot" /> CONNECT YOUR OWN STORAGE</div>
          <h2>Bring your own cloud or VPS</h2>
          <p className="sub">The workspace fee is the same $5 per month. Credentials stay in the OS keychain on this device and are never sent to GenDragoon.</p>
        </div>
      </header>
      <div className="panel stack">
        <div className="providers">
          {LAUNCH_BYO_PROVIDERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={provider === item.id ? "active" : ""}
              onClick={() => setProvider(item.id)}
              data-testid={`provider-${item.id}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className="field">Endpoint
          <input data-testid="byo-endpoint" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} />
        </label>
        <label className="field">Bucket or directory
          <input data-testid="byo-bucket" value={bucket} onChange={(event) => setBucket(event.target.value)} />
        </label>
        <label className="field">Access key or SFTP key
          <input data-testid="byo-secret" type="password" placeholder="Stored only in the OS keychain" autoComplete="off" />
        </label>
        <p className="help">
          Setup writes a server-generated challenge file, reads it back, and deletes it. The server checks the read-back. The workspace stays inactive until that proof succeeds. The server stores the provider type, endpoint, and a bucket fingerprint only.
        </p>
        <div className="actions">
          <button
            type="button"
            className="btn"
            data-testid="byo-challenge"
            onClick={() => props.onChallenge({ provider, endpoint, bucket })}
          >
            Verify ownership
          </button>
        </div>
        {props.message ? <div className="preview" data-testid="byo-message">{props.message}</div> : null}
      </div>
    </section>
  );
}
