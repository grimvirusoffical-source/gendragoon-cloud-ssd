/**
 * Avery's ruling: a 409 whose refresh comes back `failed` returns `fallback`
 * from core, and the screen mails support. "Your deletion is still in
 * progress." is only for running or queued. Core's result is mocked here so
 * this holds before and after Avery's PR #1 change lands.
 */
import { MemorySecretStore, SUPPORT_CONTACT } from "@gendragoon/core";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";
import { DeleteAccountScreen } from "../src/screens";
import { supportContactTarget } from "../src/supportContact";
import { SUPPORT_DELETION_STILL_RUNNING } from "../src/supportRequest";

const mockRequest = jest.fn();
jest.mock("@gendragoon/core", () => ({
  ...jest.requireActual("@gendragoon/core"),
  requestDeletionSupport: (...args: unknown[]) => mockRequest(...args),
}));

const JOB = "00000000-0000-4000-8000-000000000042";

async function press(result: unknown) {
  mockRequest.mockReset().mockResolvedValue(result);
  const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
  openURL.mockClear();
  const hooks = { onReauth: jest.fn(), onSignedOut: jest.fn(), onDone: jest.fn(), onError: jest.fn() };
  const s = await render(
    <DeleteAccountScreen
      frame="not-retryable"
      jobId={JOB}
      supportEndpointEnabled
      apiBase="https://api.example.test"
      activeTransfers={0}
      secrets={new MemorySecretStore()}
      workspaceIds={["ws-1"]}
      idToken=""
      client={{ async deleteAccount() { return { jobId: JOB }; }, async deletionStatus() { return { jobId: JOB, status: "failed" }; } }}
      {...hooks}
    />,
  );
  await fireEvent.press(s.getByTestId("contact-support"));
  await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
  return { s, openURL, hooks };
}

const mailto = supportContactTarget(SUPPORT_CONTACT.value, JOB);

describe("409 refresh outcomes on the screen", () => {
  afterEach(() => jest.restoreAllMocks());

  it("refresh failed: core returns fallback, the screen mails support and does not say 'still in progress'", async () => {
    const { s, openURL, hooks } = await press({ kind: "fallback", contact: SUPPORT_CONTACT });
    await waitFor(() => expect(openURL).toHaveBeenCalledWith(mailto));
    expect(s.queryByTestId("support-deletion-running")).toBeNull();
    expect(s.queryByText(SUPPORT_DELETION_STILL_RUNNING)).toBeNull();
    expect(hooks.onError).not.toHaveBeenCalled();
    expect(hooks.onReauth).not.toHaveBeenCalled();
  });

  it("refresh failed on an older core (not_needed + failed) also mails support", async () => {
    const { s, openURL, hooks } = await press({ kind: "not_needed", status: { jobId: JOB, status: "failed", retryable: false } });
    await waitFor(() => expect(openURL).toHaveBeenCalledWith(mailto));
    expect(s.queryByTestId("support-deletion-running")).toBeNull();
    expect(hooks.onError).not.toHaveBeenCalled();
  });

  it.each(["running", "queued"])("refresh %s shows 'still in progress' and sends no mail", async (state) => {
    const { s, openURL } = await press({ kind: "not_needed", status: { jobId: JOB, status: state } });
    await waitFor(() => expect(s.getByTestId("support-deletion-running")).toHaveTextContent(SUPPORT_DELETION_STILL_RUNNING));
    expect(openURL).not.toHaveBeenCalled();
  });

  it("refresh done finishes the deletion and sends no mail", async () => {
    const { openURL, hooks } = await press({ kind: "not_needed", status: { jobId: JOB, status: "done" } });
    await waitFor(() => expect(hooks.onDone).toHaveBeenCalled());
    expect(openURL).not.toHaveBeenCalled();
  });
});
