import {
  COMING_SOON_BYO_PROVIDERS,
  CUSTOM_STORAGE_STEPS,
  INITIAL_CUSTOM_STORAGE,
  LAUNCH_BYO_PROVIDERS,
  customStorageWizard,
  type ByoProviderId,
  type CustomStorageStep,
  type CustomStorageWizardState,
} from "@gendragoon/core";
import { useState } from "react";

const STEP_LABEL: Record<CustomStorageStep, string> = { provider: "Provider", credentials: "Credentials", test: "Connection test", finish: "Finish" };

export interface CustomStorageCredentials {
  provider: ByoProviderId;
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Custom storage setup, shown for a custom-storage workspace once its performance plan is paid.
 * Credentials stay on this device: they go to the OS keychain and are used locally to write
 * and presign the ownership challenge. The server only gets provider, endpoint and a fingerprint.
 */
export function CustomStorageWizard(props: {
  workspaceName: string;
  /** Runs register → challenge → presigned proof. Rejects with a readable message on failure. */
  onTest: (credentials: CustomStorageCredentials) => Promise<void>;
  onDone?: () => void;
  initialState?: CustomStorageWizardState;
}) {
  const [state, setState] = useState<CustomStorageWizardState>(props.initialState ?? INITIAL_CUSTOM_STORAGE);
  const [endpoint, setEndpoint] = useState(props.initialState?.endpoint ?? "");
  const [bucket, setBucket] = useState(props.initialState?.bucket ?? "");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const current = CUSTOM_STORAGE_STEPS.indexOf(state.step);

  async function runTest() {
    if (!state.provider) return;
    setState((s) => customStorageWizard(s, { type: "test_started" }));
    try {
      await props.onTest({ provider: state.provider as ByoProviderId, endpoint: state.endpoint, bucket: state.bucket, accessKeyId, secretAccessKey: secret });
      setSecret("");
      setState((s) => customStorageWizard(s, { type: "test_passed" }));
    } catch (error) {
      setState((s) => customStorageWizard(s, { type: "test_failed", message: error instanceof Error ? error.message : "Connection test failed" }));
    }
  }

  return (
    <section className="panel stack wizard" data-testid="custom-storage-wizard" aria-labelledby="custom-storage-title">
      <div>
        <div className="kicker"><span className="dot" /> CUSTOM STORAGE</div>
        <h3 id="custom-storage-title">Connect storage for {props.workspaceName}</h3>
      </div>
      <ol className="steps" aria-label="Setup steps">
        {CUSTOM_STORAGE_STEPS.map((step, index) => (
          <li key={step} className={`step${index < current ? " done" : ""}${index === current ? " current" : ""}`} aria-current={index === current ? "step" : undefined} data-testid={`step-${step}`}>
            <span className="step-index">{index + 1}</span> {STEP_LABEL[step]}
          </li>
        ))}
      </ol>
      {state.step === "provider" ? (
        <div className="providers" role="radiogroup" aria-label="Provider">
          {LAUNCH_BYO_PROVIDERS.map((item) => (
            <button key={item.id} type="button" role="radio" aria-checked={state.provider === item.id} className={state.provider === item.id ? "active" : ""} data-testid={`provider-${item.id}`} onClick={() => setState((s) => customStorageWizard(s, { type: "provider", provider: item.id }))}>
              {item.label}
            </button>
          ))}
          {COMING_SOON_BYO_PROVIDERS.map((item) => (
            <button key={item.id} type="button" disabled data-testid={`provider-${item.id}`}>{item.label}<span className="kind"> Coming soon</span></button>
          ))}
        </div>
      ) : null}
      {state.step === "credentials" ? (
        <div className="stack">
          <label className="field">Endpoint
            <input data-testid="byo-endpoint" value={endpoint} placeholder="https://<account>.r2.cloudflarestorage.com" onChange={(event) => setEndpoint(event.target.value)} />
          </label>
          <label className="field">Bucket
            <input data-testid="byo-bucket" value={bucket} onChange={(event) => setBucket(event.target.value)} />
          </label>
          <label className="field">Access Key ID
            <input data-testid="byo-access-key-id" autoComplete="off" value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} />
          </label>
          <label className="field">Secret Access Key
            <input data-testid="byo-secret" type="password" placeholder="Stored only in the OS keychain" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} />
          </label>
          <p className="help">Keys stay on this device. GenDragoon stores the provider, endpoint and a bucket fingerprint only.</p>
        </div>
      ) : null}
      {state.step === "test" ? (
        <p className="help" data-testid="test-explain">
          The test writes .gendragoon-challenge/&lt;nonce&gt; to {state.bucket} and sends a short-lived presigned link for it. Your keys are not sent.
        </p>
      ) : null}
      {state.step === "finish" ? (
        <p className="help" data-testid="finish-explain">Connected. {props.workspaceName} now stores files in your bucket; your provider bills its own storage and transfer.</p>
      ) : null}
      {state.error ? <p className="connection-error" role="alert" data-testid="wizard-error">{state.error}</p> : null}
      <div className="actions">
        {current > 0 && state.step !== "finish" ? (
          <button type="button" className="btn btn-ghost" disabled={state.testing} onClick={() => setState((s) => customStorageWizard(s, { type: "back" }))}>Back</button>
        ) : null}
        {state.step === "credentials" ? (
          <button type="button" className="btn" data-testid="wizard-next" onClick={() => setState((s) => customStorageWizard(s, { type: "credentials", endpoint: endpoint.trim(), bucket, hasCredentials: accessKeyId.length > 0 && secret.length > 0 }))}>Next</button>
        ) : null}
        {state.step === "test" ? (
          <button type="button" className="btn" data-testid="wizard-test" disabled={state.testing} onClick={() => void runTest()}>{state.testing ? "Testing…" : "Test connection"}</button>
        ) : null}
        {state.step === "finish" ? <button type="button" className="btn" data-testid="wizard-done" onClick={props.onDone}>Done</button> : null}
      </div>
    </section>
  );
}
