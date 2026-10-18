import { SUPPORT_CONTACT, MemorySecretStore } from "@gendragoon/core";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";
import { DELETION_SUPPORT_ENDPOINT_ENABLED } from "../src/flags";
import { DeleteAccountScreen } from "../src/screens";
import { supportContactTarget } from "../src/supportContact";
import {
  DELETION_SUPPORT_REQUEST_PATH,
  SUPPORT_REQUEST_ALREADY,
  SUPPORT_REQUEST_SENT,
  deletionSupportRequestPath,
  requestDeletionSupport,
} from "../src/supportRequest";

const JOB = "22222222-2222-4222-8222-000000000004";
const TOKEN = "status-token-provisional";
const REQUEST_ID = "req-provisional-1";

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
  });
}

function received(requestId = REQUEST_ID): Response {
  return jsonResponse(202, { status: "received", requestId });
}

/**
 * PROVISIONAL. The support endpoint is not shipped, so these calls use a mocked
 * transport. They are not server fixtures. The production flag stays off.
 */
describe("provisional deletion support request", () => {
  it("stays off until the backend endpoint ships", () => {
    expect(DELETION_SUPPORT_ENDPOINT_ENABLED).toBe(false);
    expect(DELETION_SUPPORT_REQUEST_PATH).toBe("/v2/account/deletions/:jobId/support-request");
    expect(deletionSupportRequestPath(JOB)).toBe(`/v2/account/deletions/${JOB}/support-request`);
  });

  it("PROVISIONAL: 202 and a repeat of the same requestId send no body and only the status token", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      return received();
    }) as typeof fetch;
    const first = await requestDeletionSupport({
      baseUrl: "https://api.example.test",
      jobId: JOB,
      statusToken: TOKEN,
      fetchImpl,
    });
    const second = await requestDeletionSupport({
      baseUrl: "https://api.example.test",
      jobId: JOB,
      statusToken: TOKEN,
      fetchImpl,
    });
    expect(first).toEqual({ kind: "sent", requestId: REQUEST_ID });
    expect(second).toEqual({ kind: "sent", requestId: REQUEST_ID });
    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.url).toBe(`https://api.example.test/v2/account/deletions/${JOB}/support-request`);
      expect(call.init?.method).toBe("POST");
      expect(call.init?.body).toBeUndefined();
      const headers = new Headers(call.init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(JSON.stringify(call.init?.headers)).not.toMatch(/uid|email|user/i);
    }
  });

  it("PROVISIONAL: 409 support_not_needed asks for a status refresh and 429 does not mail", async () => {
    const refresh = await requestDeletionSupport({
      baseUrl: "https://api.example.test",
      jobId: JOB,
      statusToken: TOKEN,
      fetchImpl: (async () => jsonResponse(409, { error: "support_not_needed" })) as typeof fetch,
    });
    expect(refresh).toEqual({ kind: "refresh" });
    const already = await requestDeletionSupport({
      baseUrl: "https://api.example.test",
      jobId: JOB,
      statusToken: TOKEN,
      fetchImpl: (async () => jsonResponse(429)) as typeof fetch,
    });
    expect(already).toEqual({ kind: "already" });
  });

  it("PROVISIONAL: a network error or HTTP 5xx falls back, and the screen mails when the flag is off", async () => {
    const failed = await requestDeletionSupport({
      baseUrl: "https://api.example.test",
      jobId: JOB,
      statusToken: TOKEN,
      fetchImpl: (async () => jsonResponse(500)) as typeof fetch,
    });
    expect(failed).toEqual({ kind: "fallback" });
    const thrown = await requestDeletionSupport({
      baseUrl: "https://api.example.test",
      jobId: JOB,
      statusToken: TOKEN,
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    expect(thrown).toEqual({ kind: "fallback" });

    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
    const secrets = new MemorySecretStore();
    await secrets.set("account-deletion:status-token", new TextEncoder().encode(TOKEN));
    const screen = await render(
      <DeleteAccountScreen
        frame="not-retryable"
        jobId={JOB}
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken=""
        client={{
          async deleteAccount() {
            return { jobId: JOB };
          },
          async deletionStatus() {
            return { jobId: JOB, status: "failed" };
          },
        }}
        onReauth={() => undefined}
        onSignedOut={() => undefined}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    fireEvent.press(screen.getByTestId("contact-support"));
    await waitFor(() => expect(openURL).toHaveBeenCalledWith(supportContactTarget(SUPPORT_CONTACT.value, JOB)));
    expect(screen.queryByTestId("support-request-sent")).toBeNull();
    openURL.mockRestore();
  });

  it("PROVISIONAL: with the endpoint enabled, 202 shows the sent message and does not mail", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
    const secrets = new MemorySecretStore();
    await secrets.set("account-deletion:status-token", new TextEncoder().encode(TOKEN));
    const screen = await render(
      <DeleteAccountScreen
        frame="not-retryable"
        jobId={JOB}
        supportEndpointEnabled
        apiBase="https://api.example.test"
        supportFetch={(async () => received()) as typeof fetch}
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken=""
        client={{
          async deleteAccount() {
            return { jobId: JOB };
          },
          async deletionStatus() {
            return { jobId: JOB, status: "failed" };
          },
        }}
        onReauth={() => undefined}
        onSignedOut={() => undefined}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    fireEvent.press(screen.getByTestId("contact-support"));
    await waitFor(() => expect(screen.getByTestId("support-request-sent")).toBeTruthy());
    expect(screen.getByText(SUPPORT_REQUEST_SENT)).toBeTruthy();
    expect(openURL).not.toHaveBeenCalled();
    openURL.mockRestore();
  });

  it("a 404 falls back to the support email and never shows sign-in", async () => {
    const missed = await requestDeletionSupport({
      baseUrl: "https://api.example.test",
      jobId: JOB,
      statusToken: TOKEN,
      fetchImpl: (async () => jsonResponse(404, { error: "not_found" })) as typeof fetch,
    });
    expect(missed).toEqual({ kind: "fallback" });

    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
    const onReauth = jest.fn();
    const secrets = new MemorySecretStore();
    await secrets.set("account-deletion:status-token", new TextEncoder().encode(TOKEN));
    const screen = await render(
      <DeleteAccountScreen
        frame="not-retryable"
        jobId={JOB}
        supportEndpointEnabled
        apiBase="https://api.example.test"
        supportFetch={(async () => jsonResponse(404, { error: "not_found" })) as typeof fetch}
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken=""
        client={{
          async deleteAccount() {
            return { jobId: JOB };
          },
          async deletionStatus() {
            return { jobId: JOB, status: "failed", retryable: false };
          },
        }}
        onReauth={onReauth}
        onSignedOut={() => undefined}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    fireEvent.press(screen.getByTestId("contact-support"));
    await waitFor(() => expect(openURL).toHaveBeenCalledWith(supportContactTarget(SUPPORT_CONTACT.value, JOB)));
    expect(onReauth).not.toHaveBeenCalled();
    expect(screen.queryByTestId("deletion-reauth")).toBeNull();
    expect(screen.queryByText("Sign in again. Your last sign-in is older than 5 minutes.")).toBeNull();
    openURL.mockRestore();
  });

  it("PROVISIONAL: 409 refreshes deletion status and 429 shows the already-sent message", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
    const secrets = new MemorySecretStore();
    await secrets.set("account-deletion:status-token", new TextEncoder().encode(TOKEN));
    let statusCalls = 0;
    const refresh = await render(
      <DeleteAccountScreen
        frame="not-retryable"
        jobId={JOB}
        supportEndpointEnabled
        apiBase="https://api.example.test"
        supportFetch={(async () => jsonResponse(409, { error: "support_not_needed" })) as typeof fetch}
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken=""
        client={{
          async deleteAccount() {
            return { jobId: JOB };
          },
          async deletionStatus() {
            statusCalls += 1;
            return { jobId: JOB, status: "failed", retryable: true };
          },
        }}
        onReauth={() => undefined}
        onSignedOut={() => undefined}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    fireEvent.press(refresh.getByTestId("contact-support"));
    await waitFor(() => expect(refresh.getByTestId("deletion-retry")).toBeTruthy());
    expect(statusCalls).toBe(1);
    expect(openURL).not.toHaveBeenCalled();

    const already = await render(
      <DeleteAccountScreen
        frame="not-retryable"
        jobId={JOB}
        supportEndpointEnabled
        apiBase="https://api.example.test"
        supportFetch={(async () => jsonResponse(429)) as typeof fetch}
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken=""
        client={{
          async deleteAccount() {
            return { jobId: JOB };
          },
          async deletionStatus() {
            return { jobId: JOB, status: "failed" };
          },
        }}
        onReauth={() => undefined}
        onSignedOut={() => undefined}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    fireEvent.press(already.getByTestId("contact-support"));
    await waitFor(() => expect(already.getByTestId("support-request-already")).toBeTruthy());
    expect(already.getByText(SUPPORT_REQUEST_ALREADY)).toBeTruthy();
    expect(openURL).not.toHaveBeenCalled();
    openURL.mockRestore();
  });
});
