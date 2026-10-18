/**
 * QA review probes for gendragoon-apps PR #3 at f1d3487 (Casey).
 * Passing tests pin behaviour that is correct today.
 * `it.failing` marks a gap found in review; it turns red once the gap is fixed,
 * so move it to a plain `it` in that commit.
 */
import { GenDragoonClient, MemorySecretStore, SUPPORT_CONTACT, requestDeletionSupport } from "@gendragoon/core";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { Linking, StyleSheet } from "react-native";
import { DeleteAccountScreen, NewWorkspaceScreen, WorkspacesScreen } from "../src/screens";
import { supportContactTarget } from "../src/supportContact";
import { contrastRatio, tapTarget } from "../src/theme";
import { graceBanner } from "../src/workspaceState";

const TOKEN = "status-token";
const JOB = "00000000-0000-4000-8000-000000000042";
const OTHER_JOB = "00000000-0000-4000-8000-0000000000ff";

function respond(status: number, body: unknown): Response {
  return new Response(body == null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Handler = (url: string, init?: RequestInit) => Promise<Response>;

async function store(savedJob = JOB) {
  const secrets = new MemorySecretStore();
  await secrets.set("account-deletion:status-token", new TextEncoder().encode(TOKEN));
  await secrets.set("account-deletion:job-id", new TextEncoder().encode(savedJob));
  return secrets;
}

async function pressContact(handler: Handler, savedJob = JOB) {
  const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
  const calls: string[] = [];
  const hooks = { onReauth: jest.fn(), onSignedOut: jest.fn(), onClearSession: jest.fn(), onError: jest.fn(), onDone: jest.fn() };
  const screen = await render(
    <DeleteAccountScreen
      frame="not-retryable"
      jobId={JOB}
      supportEndpointEnabled
      apiBase="https://api.example.test"
      supportFetch={(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${String(url)}`);
        return handler(String(url), init);
      }) as typeof fetch}
      activeTransfers={0}
      secrets={await store(savedJob)}
      workspaceIds={["ws-1"]}
      idToken=""
      client={{
        async deleteAccount() { return { jobId: JOB }; },
        async deletionStatus() { return { jobId: JOB, status: "failed", retryable: false }; },
      }}
      {...hooks}
    />,
  );
  await fireEvent.press(screen.getByTestId("contact-support"));
  return { screen, openURL, calls, hooks };
}

const mailto = supportContactTarget(SUPPORT_CONTACT.value, JOB);

async function expectMailNoSignIn(r: Awaited<ReturnType<typeof pressContact>>) {
  await waitFor(() => expect(r.openURL).toHaveBeenCalledWith(mailto));
  expect(r.hooks.onReauth).not.toHaveBeenCalled();
  expect(r.hooks.onSignedOut).not.toHaveBeenCalled();
  expect(r.hooks.onClearSession).not.toHaveBeenCalled();
  expect(r.hooks.onError).not.toHaveBeenCalled();
  expect(r.screen.queryByTestId("deletion-reauth")).toBeNull();
  r.openURL.mockRestore();
}

describe("PR #3 review: support request falls back to mail and never to sign-in", () => {
  const post = (status: number, body: unknown): Handler => async () => respond(status, body);
  it.each([
    [401, { error: "unauthorized" }],
    [401, null],
    [401, { error: "invalid_token" }],
    [401, { error: "reauth_required" }],
    [404, { error: "not_found" }],
    [400, { error: "bad_request" }],
    [403, { error: "forbidden" }],
    [409, { error: "something_else" }],
    [413, { error: "too_large" }],
    [422, { error: "unprocessable" }],
    [500, { error: "internal" }],
    [502, null],
    [503, { error: "unavailable" }],
  ])("HTTP %i %j mails support", async (status, body) => {
    await expectMailNoSignIn(await pressContact(post(status, body)));
  });

  it("a network error mails support", async () => {
    await expectMailNoSignIn(await pressContact(async () => { throw new TypeError("Network request failed"); }));
  });

  it.each([
    ["404", () => respond(404, { error: "not_found" })],
    ["401 invalid_token", () => respond(401, { error: "invalid_token" })],
    ["401 unauthorized", () => respond(401, { error: "unauthorized" })],
    ["500", () => respond(500, { error: "internal" })],
    ["network error", () => { throw new TypeError("offline"); }],
  ])("409 support_not_needed whose refresh fails with %s mails support", async (_name, refresh) => {
    const r = await pressContact(async (_url, init) => (init?.method === "POST" ? respond(409, { error: "support_not_needed" }) : refresh()));
    await expectMailNoSignIn(r);
    expect(r.calls.map((c) => c.split(" ")[0])).toEqual(["POST", "GET"]);
  });

  it("a saved job id that does not match sends nothing and mails support", async () => {
    const r = await pressContact(async () => respond(202, { status: "received", requestId: "r1" }), OTHER_JOB);
    await expectMailNoSignIn(r);
    expect(r.calls).toHaveLength(0);
  });

  it("no saved job id sends nothing and mails support", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("account-deletion:status-token", new TextEncoder().encode(TOKEN));
    let calls = 0;
    const result = await requestDeletionSupport(JOB, {
      client: new GenDragoonClient({ baseUrl: "https://api.example.test", getToken: async () => "", fetch: (async () => { calls += 1; return respond(202, {}); }) as typeof fetch }),
      secureStore: secrets,
    });
    expect(result).toEqual({ kind: "fallback", contact: SUPPORT_CONTACT });
    expect(calls).toBe(0);
  });

  // Gap: a 2xx other than 202, or a 3xx, makes core throw ApiError(status).
  // contact() then routes it through showFailure, which calls onError with a raw
  // message instead of mailing support.
  it.failing.each([[200], [204], [302]])("HTTP %i (unexpected) also mails support", async (status) => {
    await expectMailNoSignIn(await pressContact(post(status, status === 204 ? null : { ok: true })));
  });
});

const price = (p: Partial<{ isFree: boolean; grandfathered: boolean; feeWaived: boolean; monthlyPriceCents: number }>) => ({
  isFree: false, grandfathered: false, feeWaived: false, monthlyPriceCents: 500, ...p,
});
const ws = (id: string, name: string, p: Parameters<typeof price>[0], kind: "hosted" | "byo" = "hosted") => ({
  id, name, kind: kind as never, projectStatus: "active" as const, ...price(p),
});

describe("PR #3 review: pricing UI", () => {
  const free = ws("11111111-1111-4111-8111-000000000001", "First", { isFree: true, monthlyPriceCents: 0 });
  const extra = ws("11111111-1111-4111-8111-000000000002", "Extra", {});
  const byo = ws("11111111-1111-4111-8111-000000000003", "Mine", {}, "byo");
  const legacy = ws("11111111-1111-4111-8111-000000000004", "Legacy", { grandfathered: true, monthlyPriceCents: 0 });
  const waived = ws("11111111-1111-4111-8111-000000000005", "Owner", { feeWaived: true, monthlyPriceCents: 0 });

  it("first hosted is Free, BYO and extra are $5.00, grandfathered and feeWaived are Included", async () => {
    const s = await render(
      <WorkspacesScreen workspaces={[free, extra, byo, legacy, waived]} unpaidIds={[]} pricingEnabled onDelete={() => undefined} onMerge={() => undefined} />,
    );
    expect(s.getByTestId(`workspace-price-${free.id}`).props.children).toBe("Free");
    expect(s.getByTestId(`workspace-price-${extra.id}`).props.children).toBe("$5.00");
    expect(s.getByTestId(`workspace-price-${byo.id}`).props.children).toBe("$5.00");
    // Brief says grandfathered shows "$0"; core's workspacePriceLabel shows "Included". Needs a product call.
    expect(s.getByTestId(`workspace-price-${legacy.id}`).props.children).toBe("Included");
    expect(s.getByTestId(`workspace-price-${waived.id}`).props.children).toBe("Included");
  });

  it("the Payment due banner prints the server's date and no grace length", async () => {
    const a = graceBanner(Date.UTC(2026, 9, 21, 12));
    const b = graceBanner(Date.UTC(2026, 11, 2, 12));
    expect(a).toBe("Payment due, pay by Oct 21, 2026 to keep using this workspace.");
    expect(b).toContain("Dec 2, 2026");
    for (const text of [a, b]) expect(text).not.toMatch(/\b\d+\s*(day|days|hour|hours)\b|three|72/i);
  });

  // Gap: graceBanner formats in UTC. A deadline of 02:00Z on Oct 21 is 10 pm on
  // Oct 20 in New York, but the banner says Oct 21, a day after the real deadline.
  it.failing("the Payment due date is not later than the deadline in the user's zone (America/New_York)", () => {
    const deadline = Date.UTC(2026, 9, 21, 2); // Oct 20, 22:00 EDT
    expect(graceBanner(deadline)).toContain("Oct 20, 2026");
  });

  // Gap: a feeWaived (owner) quote labels Included, but the explanation says "billed monthly".
  it.failing("create screen does not say 'billed monthly' for a feeWaived quote", async () => {
    const s = await render(
      <NewWorkspaceScreen pricingEnabled quote={price({ feeWaived: true, monthlyPriceCents: 0 })} onCreate={() => undefined} />,
    );
    expect(s.getByTestId("new-workspace-price").props.children).toBe("Included");
    expect(s.getByTestId("new-workspace-explain").props.children).not.toMatch(/billed monthly/);
  });
});

describe("PR #3 review: create screen", () => {
  it("blocks a blank or whitespace name, trims it, and sends the chosen storage", async () => {
    const onCreate = jest.fn();
    const s = await render(<NewWorkspaceScreen quote={price({ isFree: true, monthlyPriceCents: 0 })} onCreate={onCreate} />);
    const create = s.getByTestId("create-workspace");
    expect(create.props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(s.getByTestId("workspace-name"), "   ");
    expect(s.getByTestId("create-workspace").props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(s.getByTestId("workspace-name"), "  Photos  ");
    expect(s.getByTestId("storage-hosted").props.accessibilityState.checked).toBe(true);
    await fireEvent.press(s.getByTestId("create-workspace"));
    expect(onCreate).toHaveBeenLastCalledWith({ name: "Photos", storage: "hosted", providerId: null });
    await fireEvent.press(s.getByTestId("storage-byo"));
    expect(s.getByTestId("storage-byo").props.accessibilityState.checked).toBe(true);
    expect(s.getByTestId("storage-hosted").props.accessibilityState.checked).toBe(false);
    await fireEvent.press(s.getByTestId("create-workspace"));
    expect(onCreate.mock.calls.at(-1)?.[0].storage).toBe("byo");
    expect(onCreate.mock.calls.at(-1)?.[0].providerId).toEqual(expect.any(String));
  });
});

describe("PR #3 review: merge section", () => {
  const A = ws("11111111-1111-4111-8111-00000000000a", "Alpha", {});
  const B = ws("11111111-1111-4111-8111-00000000000b", "Beta", {});
  const C = ws("11111111-1111-4111-8111-00000000000c", "Gamma", {});

  it("one workspace with a server merge result still shows the result and no pickers", async () => {
    const s = await render(
      <WorkspacesScreen workspaces={[A]} unpaidIds={[]} mergeError="Merge failed" onDelete={() => undefined} onMerge={() => undefined} />,
    );
    expect(s.getByTestId("merge-error")).toBeTruthy();
    expect(s.queryByTestId("merge-source")).toBeNull();
    expect(s.queryByTestId("merge-workspaces")).toBeNull();
  });

  // Gap: picker state is seeded once by useState. When the selected source is
  // removed from the list (deleted elsewhere), Merge stays enabled and posts the
  // removed workspace's id.
  it.failing("Merge never sends a workspace that is no longer in the list", async () => {
    const onMerge = jest.fn();
    const s = await render(<WorkspacesScreen workspaces={[A, B, C]} unpaidIds={[]} onDelete={() => undefined} onMerge={onMerge} />);
    await s.rerender(<WorkspacesScreen workspaces={[B, C]} unpaidIds={[]} onDelete={() => undefined} onMerge={onMerge} />);
    const merge = s.getByTestId("merge-workspaces");
    if (!merge.props.accessibilityState.disabled) await fireEvent.press(merge);
    for (const [source, target] of onMerge.mock.calls) {
      expect([B.id, C.id]).toContain(source);
      expect([B.id, C.id]).toContain(target);
    }
  });

  // Gap: same seeding. A list that arrives after mount (empty while loading) leaves
  // no source or target selected, so Merge is disabled with nothing highlighted.
  it.failing("a list that loads after mount preselects a source and a different target", async () => {
    const s = await render(<WorkspacesScreen workspaces={[]} unpaidIds={[]} onDelete={() => undefined} onMerge={() => undefined} />);
    await s.rerender(<WorkspacesScreen workspaces={[A, B]} unpaidIds={[]} onDelete={() => undefined} onMerge={() => undefined} />);
    expect(s.getByTestId(`merge-source-${A.id}`).props.accessibilityState.checked).toBe(true);
    expect(s.getByTestId("merge-workspaces").props.accessibilityState.disabled).toBe(false);
  });
});

describe("PR #3 review: theme", () => {
  it("contrastRatio is anchored to known WCAG values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });

  // Gap: the "Open <workspace>" Pressable has no minHeight or hitSlop, so its
  // target is one text line (~18pt), not 44pt.
  it.failing("the Open workspace control is at least 44pt tall", async () => {
    const A = ws("11111111-1111-4111-8111-00000000000a", "Alpha", {});
    const s = await render(<WorkspacesScreen workspaces={[A]} unpaidIds={[]} onDelete={() => undefined} onMerge={() => undefined} />);
    const open = s.getByTestId(`open-${A.id}`);
    const style = StyleSheet.flatten(typeof open.props.style === "function" ? open.props.style({ pressed: false }) : open.props.style) ?? {};
    const slop = typeof open.props.hitSlop === "number" ? open.props.hitSlop * 2 : 0;
    expect((Number(style.minHeight) || 0) + slop).toBeGreaterThanOrEqual(tapTarget);
  });

  // Gap: non-text contrast (WCAG 1.4.11, 3:1). Field and ghost borders are #3a3352
  // on #100e17 (1.62:1); the unchecked passphrase checkbox border is #5b4a99 (2.63:1).
  it.failing("input, ghost and checkbox borders are at least 3:1 against the screen", () => {
    expect(contrastRatio("#3a3352", "#100e17")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio("#5b4a99", "#100e17")).toBeGreaterThanOrEqual(3);
  });
});
