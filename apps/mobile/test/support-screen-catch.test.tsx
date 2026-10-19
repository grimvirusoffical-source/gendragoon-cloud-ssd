/**
 * Casey, PR #3 at 50edb6b: core now catches a rejecting SecureStore itself, so
 * bf23923 no longer reaches DeleteAccountScreen's own catch in contact(), and
 * reverting that catch broke no test. Make requestDeletionSupport itself reject
 * and require the screen to open the support email with no auth or error hook.
 */
import { SUPPORT_CONTACT, MemorySecretStore } from "@gendragoon/core";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";
import { DeleteAccountScreen } from "../src/screens";
import { supportContactTarget } from "../src/supportContact";

jest.mock("@gendragoon/core", () => ({
  ...jest.requireActual("@gendragoon/core"),
  requestDeletionSupport: jest.fn(async () => { throw new Error("core regression"); }),
}));

const JOB = "00000000-0000-4000-8000-000000000042";

it("a rejecting requestDeletionSupport still opens the support email, with no sign-in or error", async () => {
  const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
  const fetchImpl = jest.fn();
  const hooks = { onReauth: jest.fn(), onSignedOut: jest.fn(), onClearSession: jest.fn(), onError: jest.fn(), onDone: jest.fn() };
  const s = await render(
    <DeleteAccountScreen
      frame="not-retryable"
      jobId={JOB}
      supportEndpointEnabled
      apiBase="https://api.example.test"
      supportFetch={fetchImpl as never}
      activeTransfers={0}
      secrets={new MemorySecretStore()}
      workspaceIds={["ws-1"]}
      idToken=""
      client={{
        async deleteAccount() { return { jobId: JOB }; },
        async deletionStatus() { return { jobId: JOB, status: "failed", retryable: false }; },
      }}
      {...hooks}
    />,
  );
  await fireEvent.press(s.getByTestId("contact-support"));
  await waitFor(() => expect(openURL).toHaveBeenCalledWith(supportContactTarget(SUPPORT_CONTACT.value, JOB)));
  const { requestDeletionSupport } = jest.requireMock("@gendragoon/core") as { requestDeletionSupport: jest.Mock };
  expect(requestDeletionSupport).toHaveBeenCalledTimes(1);
  expect(fetchImpl).not.toHaveBeenCalled();
  for (const hook of Object.values(hooks)) expect(hook).not.toHaveBeenCalled();
  expect(s.queryByTestId("deletion-reauth")).toBeNull();
  openURL.mockRestore();
});
