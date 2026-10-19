import {
  PERFORMANCE_PLAN_TIERS,
  PlansSelectionError,
  STORAGE_PLAN_TIERS,
  buildCreateWorkspaceRequest,
  newWorkspaceRequirement,
  quoteWorkspacePlans,
  type CreateWorkspaceRequest,
  type PerformancePlanTier,
  type PlanInterval,
  type PlansPricing,
  type StoragePlanTier,
  type WorkspaceStorageChoice,
} from "@gendragoon/core";
import { useState } from "react";

const PERFORMANCE_LABEL: Record<PerformancePlanTier, string> = { lite: "Lite", boost: "Boost", turbo: "Turbo", ultra: "Ultra", max: "Max" };

function money(cents: number): string {
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/**
 * The one "New workspace" flow.
 * - First workspace: free, 2 GB + the free performance plan, no pickers.
 * - Every other workspace: one storage plan + one performance plan, billed together.
 * - Custom storage: performance plan only, then the setup wizard runs after payment.
 * There is no workspace-fee line: the fee is included in the storage plans.
 */
export function NewWorkspace(props: {
  /** Server policy `freeProjectAvailable`. */
  freeProjectAvailable: boolean;
  /** GET /v2/pricing storage/performance tables. Without them no amount is shown. */
  pricing: PlansPricing | null;
  intentId: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (request: CreateWorkspaceRequest) => void;
  onCancel?: () => void;
  initial?: { name?: string; storage?: WorkspaceStorageChoice; storageTier?: StoragePlanTier; performanceTier?: PerformancePlanTier; interval?: PlanInterval };
}) {
  const [name, setName] = useState(props.initial?.name ?? "");
  const [storage, setStorage] = useState<WorkspaceStorageChoice>(props.initial?.storage ?? "managed");
  const [storageTier, setStorageTier] = useState<StoragePlanTier | undefined>(props.initial?.storageTier);
  const [performanceTier, setPerformanceTier] = useState<PerformancePlanTier | undefined>(props.initial?.performanceTier);
  const [interval, setInterval] = useState<PlanInterval>(props.initial?.interval ?? "month");
  const [localError, setLocalError] = useState<string | null>(null);
  const requirement = newWorkspaceRequirement({ freeProjectAvailable: props.freeProjectAvailable, storage });
  const free = requirement.kind === "free";
  const selection = { storageTier, performanceTier, interval };
  const quote = free ? null : quoteWorkspacePlans(props.pricing, { storage, selection });
  const per = interval === "year" ? "/yr" : "/mo";
  const priceOf = (table: Record<string, { monthlyCents: number; yearlyCents: number }> | undefined, tier: string) => {
    const row = table?.[tier];
    return row ? money(interval === "year" ? row.yearlyCents : row.monthlyCents) + per : null;
  };
  const complete = name.trim().length > 0 && (free || (performanceTier !== undefined && (storage === "custom" || storageTier !== undefined)));

  function submit() {
    try {
      setLocalError(null);
      props.onSubmit(buildCreateWorkspaceRequest({ name: name.trim(), intentId: props.intentId, storage, freeProjectAvailable: props.freeProjectAvailable, selection }));
    } catch (error) {
      if (error instanceof PlansSelectionError) setLocalError(error.message);
      else throw error;
    }
  }

  const error = localError ?? props.error ?? null;
  return (
    <section className="panel stack new-workspace" data-testid="new-workspace" aria-labelledby="new-workspace-title">
      <div>
        <div className="kicker"><span className="dot" /> NEW WORKSPACE</div>
        <h3 id="new-workspace-title">Create a workspace</h3>
      </div>
      <label className="field">Workspace name
        <input data-testid="workspace-name" value={name} placeholder="e.g. Music Studio" onChange={(event) => setName(event.target.value)} />
      </label>
      <div className="segmented" role="radiogroup" aria-label="Storage">
        <button type="button" role="radio" aria-checked={storage === "managed"} className={storage === "managed" ? "active" : ""} data-testid="storage-managed" onClick={() => setStorage("managed")}>GenDragoon storage</button>
        <button type="button" role="radio" aria-checked={storage === "custom"} className={storage === "custom" ? "active" : ""} data-testid="storage-custom" onClick={() => setStorage("custom")}>Custom storage</button>
      </div>
      {free ? (
        <p className="help" data-testid="first-free">Your first workspace is free: 2 GB storage and the free performance plan. No payment needed.</p>
      ) : (
        <>
          {storage === "custom" ? (
            <p className="help" data-testid="custom-explain">Use your own S3, VPS or cloud. No storage plan; you pick a performance plan and finish setup after payment. Your provider bills its own storage.</p>
          ) : null}
          <div className="segmented" role="radiogroup" aria-label="Billing period">
            <button type="button" role="radio" aria-checked={interval === "month"} className={interval === "month" ? "active" : ""} data-testid="interval-month" onClick={() => setInterval("month")}>Monthly</button>
            <button type="button" role="radio" aria-checked={interval === "year"} className={interval === "year" ? "active" : ""} data-testid="interval-year" onClick={() => setInterval("year")}>Yearly · 2 months free</button>
          </div>
          {storage === "managed" ? (
            <fieldset className="plan-picker" data-testid="storage-plans">
              <legend>Storage plan</legend>
              <div className="plan-grid">
                {STORAGE_PLAN_TIERS.map((tier) => (
                  <button key={tier} type="button" role="radio" aria-checked={storageTier === tier} className={`plan-card${storageTier === tier ? " active" : ""}`} data-testid={`storage-${tier}`} onClick={() => setStorageTier(tier)}>
                    <strong>{tier}</strong>
                    {priceOf(props.pricing?.storage, tier) ? <span>{priceOf(props.pricing?.storage, tier)}</span> : null}
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}
          <fieldset className="plan-picker" data-testid="performance-plans">
            <legend>Performance plan</legend>
            <div className="plan-grid">
              {PERFORMANCE_PLAN_TIERS.map((tier) => (
                <button key={tier} type="button" role="radio" aria-checked={performanceTier === tier} className={`plan-card${performanceTier === tier ? " active" : ""}`} data-testid={`performance-${tier}`} onClick={() => setPerformanceTier(tier)}>
                  <strong>{PERFORMANCE_LABEL[tier]}</strong>
                  {props.pricing?.performance[tier] ? <span>{props.pricing.performance[tier]!.workers} workers · {priceOf(props.pricing.performance, tier)}</span> : null}
                </button>
              ))}
            </div>
          </fieldset>
          {quote ? (
            <dl className="plan-total" data-testid="plan-total">
              {quote.lines.map((line) => (
                <div key={line.label}><dt>{line.label}</dt><dd>{money(line.cents)}{per}</dd></div>
              ))}
              <div className="total"><dt>Total</dt><dd>{money(quote.totalCents)}{per}</dd></div>
            </dl>
          ) : null}
        </>
      )}
      {error ? <p className="connection-error" role="alert" data-testid="new-workspace-error">{error}</p> : null}
      <div className="actions">
        {props.onCancel ? <button type="button" className="btn btn-ghost" onClick={props.onCancel}>Cancel</button> : null}
        <button type="button" className="btn" data-testid="create-workspace" disabled={!complete || props.busy} onClick={submit}>
          {free ? "Create free workspace" : "Continue to checkout"}
        </button>
      </div>
    </section>
  );
}
