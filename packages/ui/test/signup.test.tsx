// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PairedField, RequirementHints, SignupForm, TermsGate, TwoFactorPicker, TwoFactorSetup, type SignupApi } from "../src/Signup.js";
import { passwordRules, usernameRules, type TermsDocument } from "@gendragoon/core";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
});
const $ = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLInputElement;
function type(id: string, value: string) {
  const input = $(id);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const click = (id: string) => act(() => { $(id).click(); });
const state = (list: string) => Array.from(host!.querySelectorAll(`[data-testid="${list}"] li`)).map((li) => `${li.getAttribute("data-rule")}:${li.className}`);

describe("requirement hints are red until met, then green", () => {
  it("colors come from .req.unmet (danger) and .req.met (ok)", () => {
    const css = readFileSync(resolve(__dirname, "../src/theme.css"), "utf8");
    expect(css).toMatch(/\.req\.unmet \{ color: var\(--danger\); \}/);
    expect(css).toMatch(/\.req\.met \{ color: var\(--ok\); \}/);
  });
  it("username hints turn green one by one as the name is typed", () => {
    mount(<SignupHarness />);
    expect(state("username-hints")).toEqual(["length:req unmet", "letters:req unmet", "chars:req unmet", "edges:req unmet"]);
    type("username", "ab");
    expect(state("username-hints")).toEqual(["length:req unmet", "letters:req unmet", "chars:req met", "edges:req met"]);
    type("username", "dragon_rider");
    expect(state("username-hints").every((s) => s.endsWith("req met"))).toBe(true);
  });
  it("password hints update live", () => {
    mount(<SignupHarness />);
    type("password", "correct");
    expect(state("password-hints")).toEqual(["length:req unmet", "upper:req unmet", "lower:req met", "digit:req unmet", "special:req unmet", "chars:req met"]);
    type("password", "Correct-Horse9");
    expect(state("password-hints").every((s) => s.endsWith("req met"))).toBe(true);
  });
  it("static render marks unmet rules", () => {
    const html = renderToStaticMarkup(<RequirementHints rules={passwordRules("")} testId="p" />);
    expect(html.match(/class="req unmet"/g)).toHaveLength(6);
    expect(renderToStaticMarkup(<RequirementHints rules={usernameRules("dragon_rider")} testId="u" />).match(/class="req met"/g)).toHaveLength(4);
  });
});

describe("copy arrows between a field and its confirm box", () => {
  it("down copies the field into the confirm box, up copies back", () => {
    mount(<SignupHarness />);
    type("email", "josh@example.com");
    click("email-copy-down");
    expect($("email-confirm").value).toBe("josh@example.com");
    type("password-confirm", "Correct-Horse9");
    click("password-copy-up");
    expect($("password").value).toBe("Correct-Horse9");
  });
  it("arrows are disabled while the source box is empty", () => {
    const html = renderToStaticMarkup(<PairedField id="email" label="Email" confirmLabel="Confirm email" type="email" value="" confirm="" onChange={() => {}} />);
    expect(html).toMatch(/data-testid="email-copy-down"[^>]*disabled/);
    expect(html).toMatch(/data-testid="email-copy-up"[^>]*disabled/);
    expect(html).toContain("↓");
    expect(html).toContain("↑");
  });
});

describe("2FA choices", () => {
  it("Red-XAI Auth shows Coming soon and can't be picked; No 2FA shows the warning and the acknowledgement", () => {
    const html = renderToStaticMarkup(<TwoFactorPicker value="none" phone="" acceptNo2faRisk={false} onChange={() => {}} />);
    expect(html).toMatch(/data-testid="twofa-redxai_auth"[\s\S]*?disabled=""[\s\S]*?Coming soon/);
    expect(html).toContain("Red-XAI LLC isn&#x27;t responsible if your account is compromised");
    expect(html).toContain('data-testid="no2fa-ack"');
  });
  it("Phone is shown unavailable when the server has no SMS provider", () => {
    const html = renderToStaticMarkup(<TwoFactorPicker value="" phone="" acceptNo2faRisk={false} onChange={() => {}}
      available={[{ method: "phone", available: false }, { method: "app", available: true }]} />);
    expect(html).toMatch(/data-testid="twofa-phone"[\s\S]*?disabled=""[\s\S]*?Not available yet/);
  });
  it("Phone stays off until the server's rules say it is available, then it can be picked", () => {
    const off = renderToStaticMarkup(<TwoFactorPicker value="" phone="" acceptNo2faRisk={false} onChange={() => {}} />);
    expect(off).toMatch(/data-testid="twofa-phone"[\s\S]*?disabled=""[\s\S]*?Not available yet/);
    const on = renderToStaticMarkup(<TwoFactorPicker value="" phone="" acceptNo2faRisk={false} onChange={() => {}}
      available={[{ method: "phone", available: true }]} />);
    expect(on).toMatch(/data-testid="twofa-phone"[\s\S]*?We text a 6-digit code/);
    expect(on).not.toMatch(/data-testid="twofa-phone"[^>]*>\s*<input[^>]*disabled/);
  });
  it("a text that couldn't be sent is shown after sign-up, and Send a new code retries", async () => {
    const onResend = vi.fn(async () => ({ phoneMasked: "+1******4567" }));
    mount(<TwoFactorSetup result={{ smsError: "sms_send_failed" }} onConfirm={async () => {}} onResend={onResend} />);
    expect(host!.textContent).toContain("We couldn't send the text message");
    await act(async () => { (host!.querySelector('[data-testid="twofa-resend"]') as HTMLButtonElement).click(); });
    expect(onResend).toHaveBeenCalledTimes(1);
    expect(host!.textContent).toContain("Enter the code we texted to +1******4567");
    expect(host!.textContent).not.toContain("We couldn't send the text message");
  });
});

const TERMS: TermsDocument = { version: "gendragoon-tos-2026-10-19", title: "Gendragoon Terms of Service", text: "# Gendragoon Terms of Service\n\nSection one.\n\nSection two.", falseInfoWarning: "", no2faWarning: "" };

describe("Terms gate", () => {
  it("Read ToS waits for the scroll to the end; Agree waits for Read", async () => {
    const onRead = vi.fn(), onAgree = vi.fn();
    mount(<TermsGate terms={TERMS} onRead={onRead} onAgree={onAgree} />);
    const box = $("tos-text") as unknown as HTMLDivElement;
    // jsdom has no layout: describe a long box that is not scrolled yet.
    Object.defineProperties(box, { scrollHeight: { value: 2000, configurable: true }, clientHeight: { value: 300, configurable: true } });
    expect($("tos-read").disabled).toBe(true);
    expect($("tos-agree").disabled).toBe(true);
    box.scrollTop = 900;
    act(() => { box.dispatchEvent(new Event("scroll")); });
    expect($("tos-read").disabled).toBe(true);
    box.scrollTop = 1700;
    act(() => { box.dispatchEvent(new Event("scroll")); });
    expect($("tos-read").disabled).toBe(false);
    expect($("tos-agree").disabled).toBe(true);
    await act(async () => { $("tos-read").click(); });
    expect(onRead).toHaveBeenCalledOnce();
    expect($("tos-agree").disabled).toBe(false);
    await act(async () => { $("tos-agree").click(); });
    expect(onAgree).toHaveBeenCalledOnce();
  });
});

describe("sign-up form", () => {
  it("creates the account only after Agree, with the read-then-agreed grant", async () => {
    const api = fakeApi();
    const onSubmit = vi.fn(async () => ({ account: {} as never, pending: [] }));
    const onDone = vi.fn();
    mount(<SignupForm api={api} now={() => new Date("2026-10-19T12:00:00Z")} onSubmit={onSubmit} onConfirmTwoFactor={async () => {}} onDone={onDone} />);
    type("username", "dragon_rider");
    type("email", "josh@example.com");
    click("email-copy-down");
    type("password", "Correct-Horse9");
    click("password-copy-down");
    type("dob", "07042001");
    expect($("dob").value).toBe("07/04/2001");
    act(() => { (host!.querySelector('[data-testid="twofa-none"] input') as HTMLInputElement).click(); });
    click("no2fa-ack");
    click("false-info-ack");
    await act(async () => { (host!.querySelector("form") as HTMLFormElement).requestSubmit(); });
    expect(host!.querySelector('[data-testid="signup-terms"]')).not.toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
    const box = $("tos-text") as unknown as HTMLDivElement;
    Object.defineProperties(box, { scrollHeight: { value: 1000, configurable: true }, clientHeight: { value: 1000, configurable: true } });
    act(() => { box.dispatchEvent(new Event("scroll")); });
    await act(async () => { $("tos-read").click(); });
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => { $("tos-agree").click(); });
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ username: "dragon_rider", dob: "07/04/2001", twoFactor: "none", acceptNo2faRisk: true, acknowledgeFalseInfo: true, tosGrant: "agreed-grant" });
    expect(onDone).toHaveBeenCalled();
  });
  it("an under-13 date of birth blocks the form", async () => {
    mount(<SignupHarness />);
    type("dob", "10/20/2013");
    await act(async () => { (host!.querySelector("form") as HTMLFormElement).requestSubmit(); });
    expect($("dob-error").textContent).toContain("at least 13");
    expect(host!.querySelector('[data-testid="signup-terms"]')).toBeNull();
  });
  it("quick sign-in completion has no password and a locked email", () => {
    const html = renderToStaticMarkup(<SignupForm api={fakeApi()} quick={{ email: "q@example.com" }} onSubmit={async () => ({ account: {} as never, pending: [] })} onConfirmTwoFactor={async () => {}} onDone={() => {}} />);
    expect(html).not.toContain('data-testid="password"');
    expect(html).toMatch(/data-testid="email"[^>]*readOnly|data-testid="email"[^>]*readonly/i);
    expect(html).toContain('data-testid="dob"');
    expect(html).toContain('data-testid="twofa"');
  });
});

function fakeApi(): SignupApi {
  return {
    terms: async () => TERMS,
    markTermsRead: async (version) => ({ grant: "read-grant", stage: "read", version }),
    agreeToTerms: async () => ({ grant: "agreed-grant", stage: "agreed", version: TERMS.version }),
    validateUsername: async () => ({ ok: true, checks: [] }),
    validateEmail: async () => ({ ok: true, checks: [] }),
  };
}
function SignupHarness() {
  return <SignupForm api={fakeApi()} now={() => new Date("2026-10-19T12:00:00Z")} onSubmit={async () => ({ account: {} as never, pending: [] })} onConfirmTwoFactor={async () => {}} onDone={() => {}} />;
}
