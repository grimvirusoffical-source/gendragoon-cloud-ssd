import { COMING_SOON_BYO_PROVIDERS, LAUNCH_BYO_PROVIDERS, type ByoProviderId } from "@gendragoon/core";
import { useState } from "react";

export function ByoSetup(props: {
  onChallenge: (input: { provider: ByoProviderId; endpoint: string; bucket: string }) => void;
  onStoreSecret?: (secret: string) => void;
  message: string | null;
}) {
  const [provider, setProvider] = useState<ByoProviderId>("r2");
  const [endpoint, setEndpoint] = useState("https://example.r2.cloudflarestorage.com");
  const [bucket, setBucket] = useState("library");
  const [secret, setSecret] = useState("");
  return (
    <section data-testid="byo-setup">
      <header className="topbar">
        <div>
          <div className="kicker"><span className="dot" /> CONNECT YOUR OWN STORAGE</div>
          <h2>Bring your own S3-compatible bucket</h2>
          <p className="sub">Google Cloud Storage connects with its S3 HMAC keys. Credentials stay in the OS keychain on this device and are never sent to GenDragoon.</p>
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
          {COMING_SOON_BYO_PROVIDERS.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled
              data-testid={`provider-${item.id}`}
            >
              {item.label}
              <span className="kind"> Coming soon</span>
            </button>
          ))}
        </div>
        <label className="field">Endpoint
          <input data-testid="byo-endpoint" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} />
        </label>
        <label className="field">Bucket
          <input data-testid="byo-bucket" value={bucket} onChange={(event) => setBucket(event.target.value)} />
        </label>
        <label className="field">Access key
          <input data-testid="byo-secret" type="password" placeholder="Stored only in the OS keychain" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} />
        </label>
        <p className="help">
          Setup writes .gendragoon-challenge/&lt;nonce&gt; to your bucket, then sends a short-lived presigned GET for that object. The link is created on this device. Stored credentials are not included. Connecting the storage again runs a new challenge. The server stores the provider type, endpoint, and a bucket fingerprint only.
        </p>
        <div className="actions">
          <button
            type="button"
            className="btn"
            data-testid="byo-challenge"
            onClick={() => {
              if (secret) props.onStoreSecret?.(secret);
              props.onChallenge({ provider, endpoint, bucket });
            }}
          >
            Verify ownership
          </button>
        </div>
        {props.message ? <div className="preview" data-testid="byo-message">{props.message}</div> : null}
      </div>
    </section>
  );
}
