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
import { SUPPORT_FIXTURE_SHA, loadFixture } from "./loadFixture";

const TOKEN = "status-token";

interface SupportBody {
  status?: string;
  requestId?: string;
  error?: string;
  retryAfterSec?: number;
}

function support(name: string) {
  const fixture = loadFixture<SupportBody>(`account-deletion/${name}.json`);
  expect(fixture.sourceSha).toBe(SUPPORT_FIXTURE_SHA);
  expect(fixture.request.method).toBe("POST");
  expect(fixture.request.body).toBeNull();
  return fixture;
}

function jobIdOf(path: string): string {
  const id = path.split("/")[4];
  if (!id) throw new Error(`No job id in ${path}`);
  return id;
}

function responseFor(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("deletion support request", () => {
  const received = support("support-received");
  const repeat = support("support-repeat");
  const missing = support("support-bad-token");
  const limited = support("support-rate-limited");
  const unneeded = support("support-not-needed");
  const jobId = jobIdOf(received.request.path);
  const requestId = received.response.body.requestId ?? "";

  it("stays off until production has the webhook", () => {
    expect(DELETION_SUPPORT_ENDPOINT_ENABLED).toBe(false);
    expect(DELETION_SUPPORT_REQUEST_PATH).toBe("/v2/account/deletions/:jobId/support-request");
    expect(deletionSupportRequestPath(jobId)).toBe(`/v2/account/deletions/${jobId}/support-request`);
    expect(received.response.status).toBe(202);
    expect(repeat.response.status).toBe(202);
    expect(repeat.response.body.requestId).toBe(requestId);
    expect(repeat.request.path).toBe(received.request.path);
    expect(missing.response).toEqual({ status: 404, body: { error: "not_found" } });
    expect(limited.response.status).toBe(429);
    expect(limited.response.body.error).toBe("rate_limited");
    expect(unneeded.response).toEqual({ status: 409, body: { error: "support_not_needed" } });
    expect(jobIdOf(unneeded.request.path)).not.toBe(jobId);
  });

  it("202 and a repeat of the same requestId send no body and only the status token", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      const fixture = seen.length === 1 ? received : repeat;
      return responseFor(fixture.response.status, fixture.response.body);
    }) as typeof fetch;
    const first = await requestDeletionSupport({
      baseUrl: "https://api.example.test",
      jobId,
      statusToken: TOKEN,
      fetchImpl,
    });
    const second = await requestDeletionSupport({
      baseUrl: "https://api.example.test",
      jobId,
      statusToken: TOKEN,
      fetchImpl,
    });
    expect(first).toEqual({ kind: "sent", requestId });
    expect(second).toEqual({ kind: "sent", requestId });
    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.url).toBe(`https://api.example.test${received.request.path}`);
      expect(call.init?.method).toBe("POST");
      expect(call.init?.body).toBeUndefined();
      const headers = new Headers(call.init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(JSON.stringify(call.init?.headers)).not.toMatch(/uid|email|user/i);
    }
  });

  it("409 support_not_needed asks for a status refresh and 429 does not mail", async () => {
    const refresh = await requestDeletionSupport({
      baseUrl: "https://api.example.test",
      jobId: jobIdOf(unneeded.request.path),
      statusToken: TOKEN,
      fetchImpl: (async () => responseFor(unneeded.response.status, unneeded.response.body)) as typeof fetch,
    });
    expect(refresh).toEqual({ kind: "refresh" });
    const already = await requestDeletionSupport({
      baseUrl: "https://api.example.test",
      jobId,
      statusToken: TOKEN,
      fetchImpl: (async () => responseFor(limited.response.status, limited.response.body)) as typeof fetch,
    });
    expect(already).toEqual({ kind: "already" });
  });

  it("a network error or HTTP 5xx falls back, and the screen mails when the flag is off", async () => {
    const failed = await requestDeletionSupport({
      baseUrl: "https://api.example.test",
      jobId,
      statusToken: TOKEN,
      fetchImpl: (async () => responseFor(500, { error: "unavailable" })) as typeof fetch,
    });
    expect(failed).toEqual({ kind: "fallback" });
    const thrown = await requestDeletionSupport({
      baseUrl: "https://api.example.test",
      jobId,
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
        jobId={jobId}
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken=""
        client={{
          async deleteAccount() {
            return { jobId };
          },
          async deletionStatus() {
            return { jobId, status: "failed" };
          },
        }}
        onReauth={() => undefined}
        onSignedOut={() => undefined}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    fireEvent.press(screen.getByTestId("contact-support"));
    await waitFor(() => expect(openURL).toHaveBeenCalledWith(supportContactTarget(SUPPORT_CONTACT.value, jobId)));
    expect(screen.queryByTestId("support-request-sent")).toBeNull();
    openURL.mockRestore();
  });

  it("with the endpoint enabled, 202 shows the sent message and does not mail", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
    const secrets = new MemorySecretStore();
    await secrets.set("account-deletion:status-token", new TextEncoder().encode(TOKEN));
    const screen = await render(
      <DeleteAccountScreen
        frame="not-retryable"
        jobId={jobId}
        supportEndpointEnabled
        apiBase="https://api.example.test"
        supportFetch={(async () => responseFor(received.response.status, received.response.body)) as typeof fetch}
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken=""
        client={{
          async deleteAccount() {
            return { jobId };
          },
          async deletionStatus() {
            return { jobId, status: "failed" };
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
      jobId,
      statusToken: TOKEN,
      fetchImpl: (async () => responseFor(missing.response.status, missing.response.body)) as typeof fetch,
    });
    expect(missed).toEqual({ kind: "fallback" });

    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
    const onReauth = jest.fn();
    const secrets = new MemorySecretStore();
    await secrets.set("account-deletion:status-token", new TextEncoder().encode(TOKEN));
    const screen = await render(
      <DeleteAccountScreen
        frame="not-retryable"
        jobId={jobId}
        supportEndpointEnabled
        apiBase="https://api.example.test"
        supportFetch={(async () => responseFor(missing.response.status, missing.response.body)) as typeof fetch}
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken=""
        client={{
          async deleteAccount() {
            return { jobId };
          },
          async deletionStatus() {
            return { jobId, status: "failed", retryable: false };
          },
        }}
        onReauth={onReauth}
        onSignedOut={() => undefined}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    fireEvent.press(screen.getByTestId("contact-support"));
    await waitFor(() => expect(openURL).toHaveBeenCalledWith(supportContactTarget(SUPPORT_CONTACT.value, jobId)));
    expect(onReauth).not.toHaveBeenCalled();
    expect(screen.queryByTestId("deletion-reauth")).toBeNull();
    expect(screen.queryByText("Sign in again. Your last sign-in is older than 5 minutes.")).toBeNull();
    openURL.mockRestore();
  });

  it("409 refreshes deletion status and 429 shows the already-sent message", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
    const secrets = new MemorySecretStore();
    await secrets.set("account-deletion:status-token", new TextEncoder().encode(TOKEN));
    let statusCalls = 0;
    const refresh = await render(
      <DeleteAccountScreen
        frame="not-retryable"
        jobId={jobIdOf(unneeded.request.path)}
        supportEndpointEnabled
        apiBase="https://api.example.test"
        supportFetch={(async () => responseFor(unneeded.response.status, unneeded.response.body)) as typeof fetch}
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken=""
        client={{
          async deleteAccount() {
            return { jobId: jobIdOf(unneeded.request.path) };
          },
          async deletionStatus() {
            statusCalls += 1;
            return { jobId: jobIdOf(unneeded.request.path), status: "failed", retryable: true };
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
        jobId={jobId}
        supportEndpointEnabled
        apiBase="https://api.example.test"
        supportFetch={(async () => responseFor(limited.response.status, limited.response.body)) as typeof fetch}
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken=""
        client={{
          async deleteAccount() {
            return { jobId };
          },
          async deletionStatus() {
            return { jobId, status: "failed" };
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
