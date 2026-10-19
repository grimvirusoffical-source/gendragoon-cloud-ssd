import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import type { SignupResult, TermsDocument } from "@gendragoon/core";
import { Hints, PairedInput, SignupScreen, TermsGateMobile, TwoFactorChoice, type MobileSignupApi } from "../src/account/SignupScreen";
import { palettes } from "../src/theme";
import { usernameRules } from "@gendragoon/core";
import { MOBILE_REDIRECT_URI, signInWithRedXai } from "../src/account/redxaiSignIn";

const NOW = () => new Date("2026-10-19T12:00:00Z");
const TERMS: TermsDocument = { version: "gendragoon-tos-2026-10-19", title: "Gendragoon Terms of Service", text: "Section one.\n\nSection two.", falseInfoWarning: "", no2faWarning: "" };
const api = (): MobileSignupApi => ({
  terms: async () => TERMS,
  markTermsRead: async (version) => ({ grant: "read-grant", stage: "read", version }),
  agreeToTerms: async () => ({ grant: "agreed-grant", stage: "agreed", version: TERMS.version }),
  validateUsername: async () => ({ ok: true, checks: [] }),
  validateEmail: async () => ({ ok: true, checks: [] }),
});
const color = (node: { props: { style?: unknown } }) => StyleSheet.flatten(node.props.style as never)?.color;
const scrollToEnd = (node: unknown, offset: number, height: number, content: number) =>
  fireEvent.scroll(node as never, { nativeEvent: { contentOffset: { y: offset }, layoutMeasurement: { height }, contentSize: { height: content } } });

describe("mobile sign-up", () => {
  it("hints are red until met, then green", async () => {
    const screen = await render(<Hints rules={usernameRules("ab")} testID="u" />);
    expect(color(screen.getByTestId("u-length"))).toBe(palettes.dark.danger);
    expect(color(screen.getByTestId("u-chars"))).toBe(palettes.dark.ok);
  });

  it("password hints turn green as the password is typed", async () => {
    const screen = await render(<SignupScreen api={api()} now={NOW} onSubmit={jest.fn()} onConfirmTwoFactor={jest.fn()} onDone={jest.fn()} />);
    await fireEvent.changeText(screen.getByTestId("password"), "correct");
    expect(color(screen.getByTestId("password-hints-upper"))).toBe(palettes.dark.danger);
    expect(color(screen.getByTestId("password-hints-lower"))).toBe(palettes.dark.ok);
    await fireEvent.changeText(screen.getByTestId("password"), "Correct-Horse9");
    for (const id of ["length", "upper", "lower", "digit", "special", "chars"]) expect(color(screen.getByTestId(`password-hints-${id}`))).toBe(palettes.dark.ok);
  });

  it("↓ copies the field into the confirm box and ↑ copies back", async () => {
    const onChange = jest.fn();
    const screen = await render(<PairedInput id="email" label="Email" confirmLabel="Confirm email" value="josh@example.com" confirm="other@example.com" onChange={onChange} />);
    await fireEvent.press(screen.getByTestId("email-copy-down"));
    expect(onChange).toHaveBeenLastCalledWith({ value: "josh@example.com", confirm: "josh@example.com" });
    await fireEvent.press(screen.getByTestId("email-copy-up"));
    expect(onChange).toHaveBeenLastCalledWith({ value: "other@example.com", confirm: "other@example.com" });
    const empty = await render(<PairedInput id="p" label="Password" confirmLabel="Confirm password" value="" confirm="" onChange={onChange} />);
    expect(empty.getByTestId("p-copy-down")).toBeDisabled();
  });

  it("Red-XAI Auth is Coming soon and disabled; No 2FA shows the warning and needs the acknowledgement", async () => {
    const screen = await render(<TwoFactorChoice value="none" phone="" ack={false} onChange={jest.fn()} />);
    expect(screen.getByTestId("twofa-redxai_auth")).toBeDisabled();
    expect(screen.getByTestId("twofa-redxai_auth-detail")).toHaveTextContent("Coming soon");
    expect(screen.getByTestId("no2fa-warning")).toHaveTextContent(/Red-XAI LLC isn't responsible/);
    expect(screen.getByTestId("no2fa-ack")).toBeTruthy();
  });

  it("Read ToS waits for the end of the text; Agree waits for Read", async () => {
    const onRead = jest.fn(async () => undefined), onAgree = jest.fn(async () => undefined);
    const screen = await render(<TermsGateMobile terms={TERMS} onRead={onRead} onAgree={onAgree} />);
    expect(screen.getByTestId("tos-read")).toBeDisabled();
    await scrollToEnd(screen.getByTestId("tos-text"), 100, 300, 2000);
    expect(screen.getByTestId("tos-read")).toBeDisabled();
    await scrollToEnd(screen.getByTestId("tos-text"), 1700, 300, 2000);
    expect(screen.getByTestId("tos-read")).not.toBeDisabled();
    expect(screen.getByTestId("tos-agree")).toBeDisabled();
    await fireEvent.press(screen.getByTestId("tos-read"));
    await waitFor(() => expect(screen.getByTestId("tos-agree")).not.toBeDisabled());
    await fireEvent.press(screen.getByTestId("tos-agree"));
    await waitFor(() => expect(onAgree).toHaveBeenCalledTimes(1));
  });

  it("creates the account only after Agree; the calendar fills MM/DD/YYYY; the QR shows for the authenticator app", async () => {
    const onSubmit = jest.fn(async (): Promise<SignupResult> => ({ account: {} as never, pending: ["2fa_setup"], totp: { secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/Gendragoon:dragon_rider?secret=JBSWY3DPEHPK3PXP&issuer=Gendragoon" } }));
    const onConfirm = jest.fn(async () => undefined);
    const onDone = jest.fn();
    const screen = await render(<SignupScreen api={api()} now={NOW} onSubmit={onSubmit} onConfirmTwoFactor={onConfirm} onDone={onDone} />);
    await fireEvent.changeText(screen.getByTestId("username"), "dragon_rider");
    await fireEvent.changeText(screen.getByTestId("email"), "josh@example.com");
    await fireEvent.press(screen.getByTestId("email-copy-down"));
    await fireEvent.changeText(screen.getByTestId("password"), "Correct-Horse9");
    await fireEvent.press(screen.getByTestId("password-copy-down"));
    await fireEvent.press(screen.getByTestId("dob-calendar"));
    expect(screen.getByTestId("dob-calendar-title")).toHaveTextContent("January 2008");
    for (let i = 0; i < 7; i++) await fireEvent.press(screen.getByTestId("dob-prev-year"));
    for (let i = 0; i < 6; i++) await fireEvent.press(screen.getByTestId("dob-next-month"));
    await fireEvent.press(screen.getByTestId("dob-day-4"));
    expect(screen.getByTestId("dob").props.value).toBe("07/04/2001");
    await fireEvent.press(screen.getByTestId("twofa-app"));
    await fireEvent.press(screen.getByTestId("false-info-ack"));
    await fireEvent.press(screen.getByTestId("signup-continue"));
    await waitFor(() => expect(screen.getByTestId("signup-terms")).toBeTruthy());
    expect(onSubmit).not.toHaveBeenCalled();
    await scrollToEnd(screen.getByTestId("tos-text"), 0, 500, 500);
    await fireEvent.press(screen.getByTestId("tos-read"));
    await waitFor(() => expect(screen.getByTestId("tos-agree")).not.toBeDisabled());
    expect(onSubmit).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId("tos-agree"));
    await waitFor(() => expect(screen.getByTestId("qr")).toBeTruthy());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ username: "dragon_rider", dob: "07/04/2001", twoFactor: "app", acknowledgeFalseInfo: true, tosGrant: "agreed-grant" }));
    await fireEvent.changeText(screen.getByTestId("twofa-code"), "123456");
    await fireEvent.press(screen.getByTestId("twofa-confirm"));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onConfirm).toHaveBeenCalledWith("123456");
  });

  it("under 13 can't continue", async () => {
    const screen = await render(<SignupScreen api={api()} now={NOW} onSubmit={jest.fn()} onConfirmTwoFactor={jest.fn()} onDone={jest.fn()} />);
    await fireEvent.changeText(screen.getByTestId("dob"), "10202013");
    expect(screen.getByTestId("dob").props.value).toBe("10/20/2013");
    expect(screen.getByTestId("dob-error")).toHaveTextContent(/at least 13/);
  });
});

describe("Red-XAI sign-in on mobile", () => {
  it("opens the authorize URL with PKCE and the app redirect, and returns null when cancelled", async () => {
    let opened = "";
    const tokens = await signInWithRedXai("https://accounts.example", "sign-up", async (url, redirect) => {
      opened = url;
      expect(redirect).toBe(MOBILE_REDIRECT_URI);
      return { type: "cancel" };
    });
    expect(tokens).toBeNull();
    const params = new URL(opened).searchParams;
    expect(params.get("client_id")).toBe("gendragoon");
    expect(params.get("redirect_uri")).toBe("gendragoon://oauth2/callback");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("prompt")).toBe("create");
  });
});
