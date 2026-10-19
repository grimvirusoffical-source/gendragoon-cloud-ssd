// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AccountsClient } from "@gendragoon/core";
import { AccountGate, type AccountGateDeps } from "../src/renderer/AccountGate";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deps(gendragoon: Partial<AccountsClient>): AccountGateDeps {
  const central = { rules: async () => ({ minAge: 13, centralMinAge: 13, twoFactor: [] }) } as unknown as AccountsClient;
  return { central, centralWithSession: () => central, gendragoon: gendragoon as AccountsClient, signIn: vi.fn(async () => true), adoptSession: vi.fn(async () => true) };
}
async function mount(d: AccountGateDeps, onReady = vi.fn()) {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => { createRoot(host).render(<AccountGate deps={d} onReady={onReady} />); });
  return { host, onReady, q: (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement };
}

describe("desktop account gate", () => {
  it("Create account shows the sign-up form in the app", async () => {
    const { q } = await mount(deps({}));
    await act(async () => { q("account-create").click(); });
    expect(q("signup")).not.toBeNull();
    expect(q("twofa-redxai_auth").textContent).toContain("Coming soon");
  });

  it("after sign-in the backend profile is enough; no local Terms or false-info step", async () => {
    const d = deps({ me: async () => ({ pending: [] }) as never });
    const { q, onReady } = await mount(d);
    await act(async () => { q("account-sign-in").click(); });
    expect(d.signIn).toHaveBeenCalledWith("sign-in");
    expect(q("tos")).toBeNull();
    expect(onReady).toHaveBeenCalled();
  });

  it("changed Gendragoon Terms send the person to Red-XAI to re-accept, not to a local Terms gate", async () => {
    const d = deps({ me: async () => ({ pending: ["tos"] }) as never });
    const { q, onReady } = await mount(d);
    await act(async () => { q("account-sign-in").click(); });
    expect(onReady).not.toHaveBeenCalled();
    expect(q("tos")).toBeNull();
    await act(async () => { q("account-terms-sign-in").click(); });
    expect(d.signIn).toHaveBeenCalledTimes(2);
  });
});
