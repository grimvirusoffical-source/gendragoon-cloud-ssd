// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AccountsApiError, type AccountsClient } from "@gendragoon/core";
import { AccountGate, type AccountGateDeps } from "../src/renderer/AccountGate";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const TERMS = { version: "gendragoon-tos-2026-10-19", title: "Gendragoon Terms of Service", text: "Terms.", falseInfoWarning: "", no2faWarning: "" };

function deps(gendragoon: Partial<AccountsClient>): AccountGateDeps {
  const central = { rules: async () => ({ minAge: 13, centralMinAge: 13, twoFactor: [] }) } as unknown as AccountsClient;
  return { central, centralWithSession: () => central, gendragoon: gendragoon as AccountsClient, signIn: vi.fn(async () => true) };
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

  it("a Red-XAI sign-in without a Gendragoon profile asks for the false-info acknowledgement and the Gendragoon Terms", async () => {
    const complete = vi.fn(async () => ({}));
    const d = deps({
      me: async () => { throw new AccountsApiError(404, "account_setup_required"); },
      terms: async () => TERMS,
      markTermsRead: async () => ({ grant: "r", stage: "read" as const, version: TERMS.version }),
      agreeToTerms: async () => ({ grant: "a", stage: "agreed" as const, version: TERMS.version }),
      complete: complete as unknown as AccountsClient["complete"],
    });
    const { q, onReady } = await mount(d);
    await act(async () => { q("account-sign-in").click(); });
    expect(d.signIn).toHaveBeenCalledWith("sign-in");
    expect(q("tos")).toBeNull();
    await act(async () => { q("complete-false-info").click(); });
    const box = q("tos-text");
    Object.defineProperties(box, { scrollHeight: { value: 100 }, clientHeight: { value: 100 } });
    await act(async () => { box.dispatchEvent(new Event("scroll")); });
    await act(async () => { q("tos-read").click(); });
    await act(async () => { q("tos-agree").click(); });
    expect(complete).toHaveBeenCalledWith({ tosGrant: "a", acknowledgeFalseInfo: true });
    expect(onReady).toHaveBeenCalled();
  });
});
