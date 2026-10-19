/**
 * Avery's PR #3 review at f1d3487: placeholder and border contrast, rendered
 * 44pt targets, merge ids validated against rows, no sample merge paths, and
 * the support request when the API base is missing or the job is still running.
 */
import { MemorySecretStore, SUPPORT_CONTACT } from "@gendragoon/core";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Linking, StyleSheet } from "react-native";
import { DeleteAccountScreen, NewWorkspaceScreen, PassphraseScreen, SettingsHome, WorkspacesScreen } from "../src/screens";
import { supportContactTarget } from "../src/supportContact";
import { SUPPORT_DELETION_STILL_RUNNING } from "../src/supportRequest";
import { colors, contrastRatio, tapTarget } from "../src/theme";
import { Button, Field } from "../src/ui";

type Styled = { props: { style?: unknown; hitSlop?: unknown; placeholderTextColor?: unknown } };
function flat(node: Styled): Record<string, unknown> {
  const style = typeof node.props.style === "function" ? (node.props.style as (s: { pressed: boolean }) => unknown)({ pressed: false }) : node.props.style;
  return (StyleSheet.flatten(style as never) as Record<string, unknown> | undefined) ?? {};
}

const A = { id: "11111111-1111-4111-8111-00000000000a", name: "Alpha", kind: "paid" as const, projectStatus: "active" as const };
const B = { id: "11111111-1111-4111-8111-00000000000b", name: "Beta", kind: "paid" as const, projectStatus: "active" as const };
const C = { id: "11111111-1111-4111-8111-00000000000c", name: "Gamma", kind: "paid" as const, projectStatus: "active" as const };

describe("contrast from rendered styles", () => {
  it("the Field placeholder is colors.muted and at least 4.5:1 on the input", async () => {
    const s = await render(<Field label="Name" testID="f" />);
    const input = s.getByTestId("f");
    expect(input.props.placeholderTextColor).toBe(colors.muted);
    expect(contrastRatio(String(input.props.placeholderTextColor), String(flat(input).backgroundColor))).toBeGreaterThanOrEqual(4.5);
  });

  it("the unchecked checkbox border is at least 3:1 on the screen", async () => {
    const s = await render(<PassphraseScreen onSubmit={() => undefined} />);
    const box = flat(s.getByTestId("passphrase-ack").children[0] as never);
    expect(contrastRatio(String(box.borderColor), colors.bg)).toBeGreaterThanOrEqual(3);
  });

  it("the ghost button border is at least 3:1 on the screen and on a card", async () => {
    const s = await render(<Button label="Cancel" tone="ghost" testID="g" onPress={() => undefined} />);
    const style = flat(s.getByTestId("g"));
    expect(contrastRatio(String(style.borderColor), colors.bg)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(String(style.borderColor), colors.surface)).toBeGreaterThanOrEqual(3);
  });
});

describe("44pt targets, measured on rendered controls", () => {
  function controls(s: { queryAllByRole: (role: "button" | "radio" | "checkbox") => unknown[] }) {
    return [...s.queryAllByRole("button"), ...s.queryAllByRole("radio"), ...s.queryAllByRole("checkbox")] as Styled[];
  }
  /** The visible box only: minHeight/minWidth (or fixed height/width). hitSlop and padding do not count. */
  function box(node: Styled): { h: number; w: number } {
    const style = flat(node);
    return {
      h: Math.max(Number(style.minHeight) || 0, Number(style.height) || 0),
      w: Math.max(Number(style.minWidth) || 0, Number(style.width) || 0),
    };
  }
  it.each([
    ["workspaces", () => <WorkspacesScreen workspaces={[A, B]} unpaidIds={[]} onDelete={() => undefined} onMerge={() => undefined} />],
    ["passphrase", () => <PassphraseScreen onSubmit={() => undefined} />],
    ["create", () => <NewWorkspaceScreen quote={{ isFree: true, grandfathered: false, feeWaived: false, monthlyPriceCents: 0 }} onCreate={() => undefined} />],
    ["settings", () => <SettingsHome deleteDisabled={false} onSort={() => undefined} onDelete={() => undefined} onSignOut={() => undefined} />],
    ["delete account (retry)", () => (
      <DeleteAccountScreen
        frame="retry"
        jobId="job-1"
        activeTransfers={0}
        secrets={new MemorySecretStore()}
        workspaceIds={["ws-1"]}
        idToken=""
        client={{ async deleteAccount() { return { jobId: "job-1" }; }, async deletionStatus() { return { jobId: "job-1", status: "failed" }; } }}
        onReauth={() => undefined}
        onSignedOut={() => undefined}
        onDone={() => undefined}
        onError={() => undefined}
      />
    )],
  ])("every control on the %s screen has a visible box of at least 44x44pt", async (_name, ui) => {
    const s = await render(ui());
    const found = controls(s as never);
    expect(found.length).toBeGreaterThan(0);
    for (const node of found) {
      const { h, w } = box(node);
      expect(h).toBeGreaterThanOrEqual(tapTarget);
      expect(w).toBeGreaterThanOrEqual(tapTarget);
    }
  });
  it("fails if a button shrinks to 30pt, even with hitSlop and padding", async () => {
    const s = await render(<Button label="x" testID="b" onPress={() => undefined} />);
    const node = s.getByTestId("b");
    const shrunk = { props: { ...node.props, style: [flat(node), { minHeight: 30, paddingVertical: 20 }], hitSlop: 10 } };
    expect(box(shrunk).h).toBeLessThan(tapTarget);
  });
});

describe("merge ids are validated against rows", () => {
  const ui = (workspaces: (typeof A)[], onMerge: jest.Mock) => (
    <WorkspacesScreen workspaces={workspaces} unpaidIds={[]} onDelete={() => undefined} onMerge={onMerge} />
  );
  it("a deleted target resets to a listed row and the merge uses only listed ids", async () => {
    const onMerge = jest.fn();
    const s = await render(ui([A, B, C], onMerge));
    await fireEvent.press(s.getByTestId(`merge-target-${C.id}`));
    await s.rerender(ui([A, B], onMerge));
    expect(s.getByTestId(`merge-target-${B.id}`).props.accessibilityState.checked).toBe(true);
    await fireEvent.press(s.getByTestId("merge-workspaces"));
    expect(onMerge).toHaveBeenLastCalledWith(A.id, B.id);
  });
  it("when only one row is left the pickers go and nothing is sent", async () => {
    const onMerge = jest.fn();
    const s = await render(ui([A, B], onMerge));
    await s.rerender(ui([B], onMerge));
    expect(s.queryByTestId("merge-workspaces")).toBeNull();
    expect(onMerge).not.toHaveBeenCalled();
  });
  it("a refreshed list with new ids never sends the old ones", async () => {
    const onMerge = jest.fn();
    const s = await render(ui([A, B], onMerge));
    await s.rerender(ui([C, { ...B, id: "11111111-1111-4111-8111-00000000000d" }], onMerge));
    await fireEvent.press(s.getByTestId("merge-workspaces"));
    expect(onMerge).toHaveBeenLastCalledWith(C.id, "11111111-1111-4111-8111-00000000000d");
  });
});

describe("merge preview has no sample paths", () => {
  it("shows no file line until the server sends a preview", async () => {
    const s = await render(<WorkspacesScreen workspaces={[A, B]} unpaidIds={[]} onDelete={() => undefined} onMerge={() => undefined} />);
    expect(s.queryByText(/→/)).toBeNull();
    expect(s.queryByText(/cat\.jpg/)).toBeNull();
  });
  it("shows exactly the server's files", async () => {
    const s = await render(
      <WorkspacesScreen
        workspaces={[A, B]}
        unpaidIds={[]}
        serverPreview={{ files: [{ name: "Trip/IMG_0412.HEIC", renamedTo: "Trip/IMG_0412 (Alpha).HEIC" }] } as never}
        onDelete={() => undefined}
        onMerge={() => undefined}
      />,
    );
    expect(s.getByText("Trip/IMG_0412.HEIC → Trip/IMG_0412 (Alpha).HEIC")).toBeTruthy();
  });
  it("app code holds no hardcoded sample merge path", () => {
    const src = readFileSync(path.join(__dirname, "../src/screens.tsx"), "utf8");
    expect(src).not.toMatch(/cat\.jpg/);
    expect(src).not.toMatch(/planMerge\(/);
  });
});

describe("support request edges", () => {
  const JOB = "00000000-0000-4000-8000-000000000042";
  async function screenWith(opts: { apiBase?: string; fetchImpl: typeof fetch }) {
    const secrets = new MemorySecretStore();
    await secrets.set("account-deletion:status-token", new TextEncoder().encode("tok"));
    await secrets.set("account-deletion:job-id", new TextEncoder().encode(JOB));
    const onError = jest.fn();
    const onDone = jest.fn();
    const s = await render(
      <DeleteAccountScreen
        frame="not-retryable"
        jobId={JOB}
        supportEndpointEnabled
        apiBase={opts.apiBase}
        supportFetch={opts.fetchImpl}
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken=""
        client={{ async deleteAccount() { return { jobId: JOB }; }, async deletionStatus() { return { jobId: JOB, status: "failed" }; } }}
        onReauth={() => undefined}
        onSignedOut={() => undefined}
        onDone={onDone}
        onError={onError}
      />,
    );
    return { s, onError, onDone };
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it.each(["running", "queued"])("a 409 whose refresh says %s shows 'still in progress', sends no mail and no error", async (state) => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
    const { s, onError, onDone } = await screenWith({
      apiBase: "https://api.example.test",
      fetchImpl: (async (_u: unknown, init?: RequestInit) =>
        init?.method === "POST" ? json(409, { error: "support_not_needed" }) : json(200, { jobId: JOB, status: state })) as typeof fetch,
    });
    await fireEvent.press(s.getByTestId("contact-support"));
    await waitFor(() => expect(s.getByTestId("support-deletion-running")).toHaveTextContent(SUPPORT_DELETION_STILL_RUNNING));
    expect(SUPPORT_DELETION_STILL_RUNNING).toBe("Your deletion is still in progress.");
    expect(openURL).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    openURL.mockRestore();
  });

  it.each([[undefined], [""], ["  "]])("with no API base (%j) it mails support and sends nothing", async (apiBase) => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
    const fetchImpl = jest.fn();
    const { s } = await screenWith({ apiBase, fetchImpl: fetchImpl as never });
    await fireEvent.press(s.getByTestId("contact-support"));
    await waitFor(() => expect(openURL).toHaveBeenCalledWith(supportContactTarget(SUPPORT_CONTACT.value, JOB)));
    expect(fetchImpl).not.toHaveBeenCalled();
    openURL.mockRestore();
  });

  it("a saved job id that differs from the shown job makes zero requests and mails support (screen level)", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
    const secrets = new MemorySecretStore();
    await secrets.set("account-deletion:status-token", new TextEncoder().encode("tok"));
    await secrets.set("account-deletion:job-id", new TextEncoder().encode("00000000-0000-4000-8000-0000000000ff"));
    const fetchImpl = jest.fn(async () => json(202, { status: "received", requestId: "r1" }));
    const onReauth = jest.fn();
    const s = await render(
      <DeleteAccountScreen
        frame="not-retryable"
        jobId={JOB}
        supportEndpointEnabled
        apiBase="https://api.example.test"
        supportFetch={fetchImpl as never}
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken=""
        client={{ async deleteAccount() { return { jobId: JOB }; }, async deletionStatus() { return { jobId: JOB, status: "failed" }; } }}
        onReauth={onReauth}
        onSignedOut={() => undefined}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    await fireEvent.press(s.getByTestId("contact-support"));
    await waitFor(() => expect(openURL).toHaveBeenCalledWith(supportContactTarget(SUPPORT_CONTACT.value, JOB)));
    expect(fetchImpl).toHaveBeenCalledTimes(0);
    expect(onReauth).not.toHaveBeenCalled();
    expect(s.queryByTestId("support-request-sent")).toBeNull();
    openURL.mockRestore();
  });

  it("a body read error mails support", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
    const broken = { ok: true, status: 202, headers: new Headers({ "content-type": "application/json" }), json: async () => { throw new Error("read"); }, text: async () => { throw new Error("read"); }, clone() { return this; } };
    const { s, onError } = await screenWith({ apiBase: "https://api.example.test", fetchImpl: (async () => broken) as never });
    await fireEvent.press(s.getByTestId("contact-support"));
    await waitFor(() => expect(openURL).toHaveBeenCalledWith(supportContactTarget(SUPPORT_CONTACT.value, JOB)));
    expect(onError).not.toHaveBeenCalled();
    openURL.mockRestore();
  });
});

describe("create screen billing line", () => {
  it.each([
    ["feeWaived", { isFree: false, grandfathered: false, feeWaived: true, monthlyPriceCents: 0 }],
    ["grandfathered", { isFree: false, grandfathered: true, feeWaived: false, monthlyPriceCents: 0 }],
  ])("a %s quote with 0 cents never says billed monthly", async (_n, quote) => {
    const s = await render(<NewWorkspaceScreen pricingEnabled quote={quote} onCreate={() => undefined} />);
    expect(s.getByTestId("new-workspace-explain").props.children).not.toMatch(/billed monthly/);
  });
});
