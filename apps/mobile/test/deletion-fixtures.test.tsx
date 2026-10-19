import {
  ApiError,
  DeletionNotRetryableError,
  GenDragoonClient,
  InvalidTokenError,
  MemorySecretStore,
  SUPPORT_CONTACT,
  workspaceKeyId,
} from "@gendragoon/core";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";
import { applyAuthFailureSignal, deletionSessionAction, deleteSignedInAccount, savedDeletionUid } from "../src/account/deleteAccount";
import { sessionTokenAfterAuthFailure } from "../src/account/session";
import { DeleteAccountScreen } from "../src/screens";
import { supportContactTarget } from "../src/supportContact";
import { loadFixture } from "./loadFixture";

function idToken(sub = "user-1"): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const authTime = Math.floor(Date.now() / 1000) - 30;
  return `${encode({ alg: "none" })}.${encode({ auth_time: authTime, sub })}.sig`;
}

function responseFor(status: number, body: unknown, contentType: string): Response {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(payload, { status, headers: { "content-type": contentType } });
}

interface ErrorBody {
  error?: string;
  code?: string;
  message?: string;
}

interface AcceptedBody {
  jobId: string;
  status: string;
  statusToken: string;
}

interface StatusBody {
  jobId: string;
  status: string;
  retryable: boolean;
}

function clientFor(fetchImpl: typeof fetch): GenDragoonClient {
  return new GenDragoonClient({
    baseUrl: "https://api.example.test",
    getToken: () => idToken(),
    fetch: fetchImpl,
  });
}

async function textOf(secrets: MemorySecretStore, name: string): Promise<string | null> {
  const bytes = await secrets.get(name);
  if (!bytes || bytes.byteLength === 0) return null;
  return new TextDecoder().decode(bytes);
}

describe("deletion fixtures", () => {
  it("sends the accepted fixture confirm body and wipes only when status is done", async () => {
    const accepted = loadFixture<AcceptedBody>("account-deletion/accepted.json");
    const done = loadFixture<StatusBody>("account-deletion/status-done.json");
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("ws-1"), new Uint8Array([9]));
    const bodies: unknown[] = [];
    const client = clientFor(async (_input, init) => {
      if (init?.method === "DELETE") {
        bodies.push(JSON.parse(String(init.body)));
        return responseFor(accepted.response.status, accepted.response.body, "application/json");
      }
      return responseFor(done.response.status, done.response.body, "application/json");
    });
    const status = await deleteSignedInAccount({
      client,
      idToken: idToken(),
      workspaceIds: ["ws-1"],
      secrets,
    });
    expect(bodies).toEqual([accepted.request.body]);
    expect(status.status).toBe("done");
    expect(await secrets.get(workspaceKeyId("ws-1"))).toBeNull();
    expect(await textOf(secrets, "account-deletion:job-id")).toBeNull();
    expect(await savedDeletionUid(secrets)).toBeNull();
  });

  it("a failed job keeps workspace keys", async () => {
    const accepted = loadFixture<AcceptedBody>("account-deletion/accepted.json");
    const failed = loadFixture<StatusBody>("account-deletion/status-failed.json");
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("ws-1"), new Uint8Array([9]));
    const client = clientFor(async (_input, init) => {
      if (init?.method === "DELETE") {
        return responseFor(accepted.response.status, accepted.response.body, "application/json");
      }
      return responseFor(failed.response.status, failed.response.body, "application/json");
    });
    const status = await deleteSignedInAccount({
      client,
      idToken: idToken(),
      workspaceIds: ["ws-1"],
      secrets,
    });
    expect(status.status).toBe("failed");
    expect(failed.response.body.retryable).toBe(true);
    expect(await secrets.get(workspaceKeyId("ws-1"))).toEqual(new Uint8Array([9]));
  });

  it("a retryable failure shows Retry", async () => {
    const accepted = loadFixture<AcceptedBody>("account-deletion/accepted.json");
    const failed = loadFixture<StatusBody>("account-deletion/status-failed.json");
    const secrets = new MemorySecretStore();
    const client = clientFor(async (_input, init) => {
      if (init?.method === "DELETE") return responseFor(accepted.response.status, accepted.response.body, "application/json");
      return responseFor(failed.response.status, failed.response.body, "application/json");
    });
    const screen = await render(
      <DeleteAccountScreen
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken={idToken()}
        client={client}
        onReauth={() => undefined}
        onSignedOut={() => undefined}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    fireEvent.press(screen.getByTestId("delete-account-continue"));
    await waitFor(() => expect(screen.queryByTestId("delete-account-confirm")).not.toBeNull());
    fireEvent.press(screen.getByTestId("delete-account-confirm"));
    await waitFor(() => expect(screen.queryByTestId("deletion-retry")).not.toBeNull());
    expect(screen.queryByTestId("deletion-dismiss")).toBeNull();
    expect(screen.getByText("Deletion didn't finish. Retry picks up where it stopped.")).toBeTruthy();
  });

  it("a non-retryable failure shows Dismiss", async () => {
    const accepted = loadFixture<AcceptedBody>("account-deletion/accepted.json");
    const failed = loadFixture<StatusBody>("account-deletion/status-failed.json");
    const secrets = new MemorySecretStore();
    const client = clientFor(async (_input, init) => {
      if (init?.method === "DELETE") return responseFor(accepted.response.status, accepted.response.body, "application/json");
      return responseFor(failed.response.status, { ...failed.response.body, retryable: false }, "application/json");
    });
    const screen = await render(
      <DeleteAccountScreen
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken={idToken()}
        client={client}
        onReauth={() => undefined}
        onSignedOut={() => undefined}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    fireEvent.press(screen.getByTestId("delete-account-continue"));
    await waitFor(() => expect(screen.queryByTestId("delete-account-confirm")).not.toBeNull());
    fireEvent.press(screen.getByTestId("delete-account-confirm"));
    await waitFor(() => expect(screen.queryByTestId("deletion-dismiss")).not.toBeNull());
    expect(screen.queryByTestId("deletion-retry")).toBeNull();
    expect(screen.getByText("Account deletion failed.")).toBeTruthy();
    expect(screen.getByLabelText("Contact support")).toBeTruthy();
    expect(screen.queryByText(SUPPORT_CONTACT.value)).toBeNull();
  });

  it("failed with retryable true keeps the job and the repeat DELETE resumes it", async () => {
    const accepted = loadFixture<AcceptedBody>("account-deletion/accepted.json");
    const failed = loadFixture<StatusBody>("account-deletion/status-failed.json");
    const jobId = failed.response.body.jobId;
    const secrets = new MemorySecretStore();
    const methods: string[] = [];
    const client = clientFor(async (input, init) => {
      methods.push(init?.method ?? "");
      if (init?.method === "DELETE") {
        return responseFor(accepted.response.status, { ...accepted.response.body, jobId }, "application/json");
      }
      expect(String(input)).toContain(`/v2/account/deletions/${jobId}`);
      return responseFor(failed.response.status, failed.response.body, "application/json");
    });
    const screen = await render(
      <DeleteAccountScreen
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken={idToken()}
        client={client}
        onReauth={() => undefined}
        onSignedOut={() => undefined}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    fireEvent.press(screen.getByTestId("delete-account-continue"));
    await waitFor(() => expect(screen.queryByTestId("delete-account-confirm")).not.toBeNull());
    fireEvent.press(screen.getByTestId("delete-account-confirm"));
    await waitFor(() => expect(screen.queryByTestId("deletion-retry")).not.toBeNull());
    expect(await textOf(secrets, "account-deletion:job-id")).toBe(jobId);
    methods.length = 0;
    fireEvent.press(screen.getByTestId("deletion-retry"));
    await waitFor(() => expect(methods.filter((method) => method === "DELETE").length).toBe(1));
    expect(await textOf(secrets, "account-deletion:job-id")).toBe(jobId);
  });

  it("the saved job is cleared only after done or dismiss, not after failed", async () => {
    const accepted = loadFixture<AcceptedBody>("account-deletion/accepted.json");
    const failed = loadFixture<StatusBody>("account-deletion/status-failed.json");
    const secrets = new MemorySecretStore();
    const client = clientFor(async (_input, init) => {
      if (init?.method === "DELETE") return responseFor(accepted.response.status, accepted.response.body, "application/json");
      return responseFor(failed.response.status, { ...failed.response.body, retryable: false }, "application/json");
    });
    await deleteSignedInAccount({
      client,
      idToken: idToken(),
      workspaceIds: ["ws-1"],
      secrets,
    });
    expect(await textOf(secrets, "account-deletion:job-id")).toBe(accepted.response.body.jobId);
    expect(await textOf(secrets, "account-deletion:status-token")).toBe(accepted.response.body.statusToken);
  });

  it("invalid_token on DELETE signs out, keeps the uid, and wipes nothing", async () => {
    const invalid = loadFixture<ErrorBody>("account-deletion/invalid-token.json");
    expect(invalid.request.method).toBe("DELETE");
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("ws-1"), new Uint8Array([2]));
    const methods: string[] = [];
    const client = clientFor(async (_input, init) => {
      methods.push(init?.method ?? "");
      return responseFor(invalid.response.status, invalid.response.body, "application/json");
    });
    const error = await deleteSignedInAccount({
      client,
      idToken: idToken(),
      workspaceIds: ["ws-1"],
      secrets,
    }).catch((caught: unknown) => caught);
    expect(deletionSessionAction(error)).toBe("sign-out");
    expect(sessionTokenAfterAuthFailure("sign-out", "session-token")).toBe("");
    expect(methods).toEqual(["DELETE"]);
    expect(await savedDeletionUid(secrets)).toBe("user-1");
    expect(await textOf(secrets, "account-deletion:job-id")).toBeNull();
    expect(await secrets.get(workspaceKeyId("ws-1"))).toEqual(new Uint8Array([2]));
  });

  it("invalid_token signs out, clears only the session, and keeps polling the saved job", async () => {
    const accepted = loadFixture<AcceptedBody>("account-deletion/accepted.json");
    const invalid = loadFixture<ErrorBody>("account-deletion/status-invalid-token.json");
    expect(invalid.response.status).toBe(401);
    expect(invalid.response.body.error).toBe("invalid_token");
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("ws-1"), new Uint8Array([5]));
    const methods: string[] = [];
    const client = clientFor(async (_input, init) => {
      methods.push(init?.method ?? "");
      if (init?.method === "DELETE") {
        return responseFor(accepted.response.status, accepted.response.body, "application/json");
      }
      return responseFor(invalid.response.status, invalid.response.body, "application/json");
    });
    const signedOut = jest.fn();
    const reauth = jest.fn();
    const screen = await render(
      <DeleteAccountScreen
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken={idToken()}
        client={client}
        onReauth={reauth}
        onSignedOut={signedOut}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    fireEvent.press(screen.getByTestId("delete-account-continue"));
    await waitFor(() => {
      expect(screen.queryByTestId("delete-account-confirm")).not.toBeNull();
    });
    fireEvent.press(screen.getByTestId("delete-account-confirm"));
    await waitFor(() => {
      expect(reauth).toHaveBeenCalledTimes(1);
    });
    expect(signedOut).not.toHaveBeenCalled();
    expect(screen.getByTestId("deletion-reauth")).toBeTruthy();
    expect(sessionTokenAfterAuthFailure("sign-out", idToken())).toBe("");
    expect(await savedDeletionUid(secrets)).toBe("user-1");
    expect(await textOf(secrets, "account-deletion:job-id")).toBe(accepted.response.body.jobId);
    expect(await textOf(secrets, "account-deletion:status-token")).toBe(accepted.response.body.statusToken);
    expect(await secrets.get(workspaceKeyId("ws-1"))).toEqual(new Uint8Array([5]));

    methods.length = 0;
    const again = await deleteSignedInAccount({
      client,
      idToken: idToken(),
      workspaceIds: ["ws-1"],
      secrets,
    }).catch((caught: unknown) => caught);
    expect(deletionSessionAction(again)).toBe("reauth");
    expect(methods).toEqual(["DELETE", "GET"]);
    expect(await secrets.get(workspaceKeyId("ws-1"))).toEqual(new Uint8Array([5]));
    expect(await textOf(secrets, "account-deletion:job-id")).toBe(accepted.response.body.jobId);
  });

  it("a 401 with no error code goes to sign-in and keeps the saved job", async () => {
    const accepted = loadFixture<AcceptedBody>("account-deletion/accepted.json");
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("ws-1"), new Uint8Array([4]));
    const client = clientFor(async (_input, init) => {
      if (init?.method === "DELETE") {
        return responseFor(accepted.response.status, accepted.response.body, "application/json");
      }
      return responseFor(401, {}, "application/json");
    });
    const signedOut = jest.fn();
    const reauth = jest.fn();
    const screen = await render(
      <DeleteAccountScreen
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken={idToken()}
        client={client}
        onReauth={reauth}
        onSignedOut={signedOut}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    fireEvent.press(screen.getByTestId("delete-account-continue"));
    await waitFor(() => {
      expect(screen.queryByTestId("delete-account-confirm")).not.toBeNull();
    });
    fireEvent.press(screen.getByTestId("delete-account-confirm"));
    await waitFor(() => {
      expect(reauth).toHaveBeenCalledTimes(1);
    });
    expect(signedOut).not.toHaveBeenCalled();
    expect(sessionTokenAfterAuthFailure("reauth", "still-the-session")).toBe("still-the-session");
    expect(await secrets.get(workspaceKeyId("ws-1"))).toEqual(new Uint8Array([4]));
    expect(await textOf(secrets, "account-deletion:job-id")).toBe(accepted.response.body.jobId);
    expect(await savedDeletionUid(secrets)).toBe("user-1");
  });

  it("a network error while polling shows Retry and does not send DELETE again", async () => {
    const accepted = loadFixture<AcceptedBody>("account-deletion/accepted.json");
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("ws-1"), new Uint8Array([7]));
    const methods: string[] = [];
    const client = clientFor(async (_input, init) => {
      methods.push(init?.method ?? "");
      if (init?.method === "DELETE") {
        return responseFor(accepted.response.status, accepted.response.body, "application/json");
      }
      throw new Error("offline");
    });
    const screen = await render(
      <DeleteAccountScreen
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken={idToken()}
        client={client}
        onReauth={() => undefined}
        onSignedOut={() => undefined}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    fireEvent.press(screen.getByTestId("delete-account-continue"));
    await waitFor(() => {
      expect(screen.queryByTestId("delete-account-confirm")).not.toBeNull();
    });
    fireEvent.press(screen.getByTestId("delete-account-confirm"));
    await waitFor(() => {
      expect(screen.queryByTestId("deletion-retry")).not.toBeNull();
    });
    expect(screen.getByText("Could not reach the server. Try again.")).toBeTruthy();
    expect(await secrets.get(workspaceKeyId("ws-1"))).toEqual(new Uint8Array([7]));
    expect(await textOf(secrets, "account-deletion:job-id")).toBe(accepted.response.body.jobId);

    fireEvent.press(screen.getByTestId("deletion-retry"));
    await waitFor(() => {
      expect(methods.filter((method) => method === "GET").length).toBe(2);
    });
    expect(methods.filter((method) => method === "DELETE")).toEqual(["DELETE"]);
    expect(await secrets.get(workspaceKeyId("ws-1"))).toEqual(new Uint8Array([7]));
  });

  it("singular-path JSON 404 keeps the job, shows Retry, and wipes nothing", async () => {
    const accepted = loadFixture<AcceptedBody>("account-deletion/accepted.json");
    const singular = loadFixture<{ error: string }>("account-deletion/singular-path.json");
    expect(singular.response.status).toBe(404);
    expect(singular.response.body).toEqual({ error: "not_found" });
    expect(singular.request.path).toBe("/v2/account/deletion/00000000-0000-4000-8000-000000000099");
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("ws-1"), new Uint8Array([3]));
    const methods: string[] = [];
    const client = clientFor(async (_input, init) => {
      methods.push(init?.method ?? "");
      if (init?.method === "DELETE") {
        return responseFor(accepted.response.status, accepted.response.body, "application/json");
      }
      return responseFor(singular.response.status, singular.response.body, "application/json");
    });
    const screen = await render(
      <DeleteAccountScreen
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken={idToken()}
        client={client}
        onReauth={() => undefined}
        onSignedOut={() => undefined}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    fireEvent.press(screen.getByTestId("delete-account-continue"));
    await waitFor(() => {
      expect(screen.queryByTestId("delete-account-confirm")).not.toBeNull();
    });
    fireEvent.press(screen.getByTestId("delete-account-confirm"));
    await waitFor(() => {
      expect(screen.queryByTestId("deletion-retry")).not.toBeNull();
    });
    expect(screen.getByTestId("deletion-error")).toBeTruthy();
    expect(await textOf(secrets, "account-deletion:job-id")).toBe(accepted.response.body.jobId);
    expect(await textOf(secrets, "account-deletion:status-token")).toBe(accepted.response.body.statusToken);
    expect(await secrets.get(workspaceKeyId("ws-1"))).toEqual(new Uint8Array([3]));
    expect(methods.filter((method) => method === "DELETE")).toEqual(["DELETE"]);

    fireEvent.press(screen.getByTestId("deletion-retry"));
    await waitFor(() => {
      expect(methods.filter((method) => method === "GET").length).toBe(2);
    });
    expect(methods.filter((method) => method === "DELETE")).toEqual(["DELETE"]);
    expect(await secrets.get(workspaceKeyId("ws-1"))).toEqual(new Uint8Array([3]));
  });

  /** SYNTHETIC: not a server fixture. singular-path.json is now JSON `{error:"not_found"}`. */
  const SYNTHETIC_HTML_404 = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot GET /v2/account/deletion/00000000-0000-4000-8000-000000000099</pre>\n</body>\n</html>\n";

  it("SYNTHETIC: an HTML 404 poll body keeps the job, shows Retry, and wipes nothing", async () => {
    const accepted = loadFixture<AcceptedBody>("account-deletion/accepted.json");
    expect(SYNTHETIC_HTML_404.startsWith("<!DOCTYPE html>")).toBe(true);
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("ws-1"), new Uint8Array([3]));
    const methods: string[] = [];
    const client = clientFor(async (_input, init) => {
      methods.push(init?.method ?? "");
      if (init?.method === "DELETE") {
        return responseFor(accepted.response.status, accepted.response.body, "application/json");
      }
      return responseFor(404, SYNTHETIC_HTML_404, "text/html");
    });
    const screen = await render(
      <DeleteAccountScreen
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken={idToken()}
        client={client}
        onReauth={() => undefined}
        onSignedOut={() => undefined}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    fireEvent.press(screen.getByTestId("delete-account-continue"));
    await waitFor(() => {
      expect(screen.queryByTestId("delete-account-confirm")).not.toBeNull();
    });
    fireEvent.press(screen.getByTestId("delete-account-confirm"));
    await waitFor(() => {
      expect(screen.queryByTestId("deletion-retry")).not.toBeNull();
    });
    expect(screen.getByTestId("deletion-error")).toBeTruthy();
    expect(await textOf(secrets, "account-deletion:job-id")).toBe(accepted.response.body.jobId);
    expect(await secrets.get(workspaceKeyId("ws-1"))).toEqual(new Uint8Array([3]));
    expect(methods.filter((method) => method === "DELETE")).toEqual(["DELETE"]);
  });

  it("uses the error code, then code, and not the message text", async () => {
    const invalid = loadFixture<ErrorBody>("account-deletion/invalid-token.json");
    const reauth = loadFixture<ErrorBody>("account-deletion/reauth-required.json");
    const invalidError = await clientFor(async () => responseFor(invalid.response.status, invalid.response.body, "application/json"))
      .deleteAccount({ reauthenticatedAt: "", idToken: idToken() })
      .catch((caught: unknown) => caught);
    const reauthError = await clientFor(async () => responseFor(reauth.response.status, reauth.response.body, "application/json"))
      .deleteAccount({ reauthenticatedAt: "", idToken: idToken() })
      .catch((caught: unknown) => caught);
    const messageOnly = await clientFor(async () => responseFor(401, { message: "invalid_token", error: "Sign in again to continue" }, "application/json"))
      .deleteAccount({ reauthenticatedAt: "", idToken: idToken() })
      .catch((caught: unknown) => caught);
    expect(deletionSessionAction(invalidError)).toBe("sign-out");
    expect(deletionSessionAction(reauthError)).toBe("reauth");
    expect(deletionSessionAction(messageOnly)).toBeNull();
    expect(messageOnly).toBeInstanceOf(ApiError);
  });

  it("prefers the error field when it differs from code, and ignores message text", async () => {
    const error = await clientFor(async () => responseFor(401, {
      error: "invalid_token",
      code: "reauth_required",
      message: "invalid_token means sign out",
    }, "application/json"))
      .deleteAccount({ reauthenticatedAt: "", idToken: idToken() })
      .catch((caught: unknown) => caught);
    expect(deletionSessionAction(error)).toBe("sign-out");
  });

  it("the support contact is the real shared support address", () => {
    expect(SUPPORT_CONTACT).toEqual({ value: "support@infected-nation.com", isPlaceholder: false });
  });

  it("not-retryable deletion asks the user to contact support and hides the sign-in helper", async () => {
    const jobId = "22222222-2222-4222-8222-000000000004";
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
    const screen = await render(
      <DeleteAccountScreen
        frame="not-retryable"
        jobId={jobId}
        activeTransfers={0}
        secrets={new MemorySecretStore()}
        workspaceIds={["ws-1"]}
        idToken=""
        client={clientFor(async () => responseFor(500, {}, "application/json"))}
        onReauth={() => undefined}
        onSignedOut={() => undefined}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    expect(screen.getByText("We couldn't finish deleting your account. Contact support and we'll complete it for you.")).toBeTruthy();
    expect(screen.queryByTestId("deletion-signin-help")).toBeNull();
    expect(screen.queryByText(SUPPORT_CONTACT.value)).toBeNull();
    expect(screen.getByTestId("deletion-dismiss")).toBeTruthy();
    const contact = screen.getByTestId("contact-support");
    expect(contact.props.accessibilityLabel).toBe("Contact support");
    fireEvent.press(contact);
    expect(openURL).toHaveBeenCalledWith(supportContactTarget(SUPPORT_CONTACT.value, jobId));
    if (__DEV__ && SUPPORT_CONTACT.isPlaceholder) {
      expect(screen.getByText("placeholder contact")).toBeTruthy();
    } else {
      expect(screen.queryByText("placeholder contact")).toBeNull();
    }
    openURL.mockRestore();
  });

  it("Retry on a retryable failure sends DELETE again for the same job", async () => {
    const accepted = loadFixture<AcceptedBody>("account-deletion/accepted.json");
    const failed = loadFixture<StatusBody>("account-deletion/status-failed.json");
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("ws-1"), new Uint8Array([7]));
    const methods: string[] = [];
    const client = clientFor(async (_input, init) => {
      methods.push(init?.method ?? "");
      if (init?.method === "DELETE") return responseFor(accepted.response.status, accepted.response.body, "application/json");
      return responseFor(failed.response.status, failed.response.body, "application/json");
    });
    const screen = await render(
      <DeleteAccountScreen
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken={idToken()}
        client={client}
        onReauth={() => undefined}
        onSignedOut={() => undefined}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    fireEvent.press(screen.getByTestId("delete-account-continue"));
    await waitFor(() => expect(screen.queryByTestId("delete-account-confirm")).not.toBeNull());
    fireEvent.press(screen.getByTestId("delete-account-confirm"));
    await waitFor(() => expect(screen.queryByTestId("deletion-retry")).not.toBeNull());
    fireEvent.press(screen.getByTestId("deletion-retry"));
    await waitFor(() => expect(methods.filter((method) => method === "DELETE")).toEqual(["DELETE", "DELETE"]));
    expect(await textOf(secrets, "account-deletion:job-id")).toBe(accepted.response.body.jobId);
    expect(await secrets.get(workspaceKeyId("ws-1"))).toEqual(new Uint8Array([7]));
  });

  it("loads the real deletion retry, status-token, and payload fixtures", () => {
    const retry = loadFixture<AcceptedBody>("account-deletion/retry-after-failed.json");
    const blocked = loadFixture<{ error: string; jobId: string }>("account-deletion/retry-not-retryable.json");
    const statusInvalid = loadFixture<ErrorBody>("account-deletion/status-invalid-token.json");
    const unauthorized = loadFixture<ErrorBody>("account-deletion/status-unauthorized.json");
    const tooLarge = loadFixture<{ error: string }>("errors/payload-too-large.json");
    expect(retry.response.status).toBe(202);
    expect(retry.response.body.jobId).toBe("00000000-0000-4000-8000-000000000004");
    expect(blocked.response).toEqual({ status: 409, body: { error: "deletion_not_retryable", jobId: "00000000-0000-4000-8000-000000000009" } });
    expect(statusInvalid.request.method).toBe("GET");
    expect(statusInvalid.response).toEqual({ status: 401, body: { error: "invalid_token" } });
    expect(unauthorized.response).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect(tooLarge.request.path).toBe("/v2/account");
    expect(tooLarge.response).toEqual({ status: 413, body: { error: "payload_too_large" } });
  });

  it("onAuthFailure signed_out clears only the session and reauth_required shows re-sign-in", () => {
    const clearSession = jest.fn();
    const showReauth = jest.fn();
    applyAuthFailureSignal("signed_out", new InvalidTokenError(), { clearSession, showReauth });
    applyAuthFailureSignal("reauth_required", new Error("reauth_required"), { clearSession, showReauth });
    applyAuthFailureSignal("sign-out", new InvalidTokenError(), { clearSession, showReauth });
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(showReauth).toHaveBeenCalledTimes(1);
  });

  it("a status-token invalid_token signals reauth_required, shows re-sign-in, and keeps the job", async () => {
    const accepted = loadFixture<AcceptedBody>("account-deletion/accepted.json");
    const invalid = loadFixture<ErrorBody>("account-deletion/status-invalid-token.json");
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("ws-1"), new Uint8Array([5]));
    const methods: string[] = [];
    const client = clientFor(async (_input, init) => {
      methods.push(init?.method ?? "");
      if (init?.method === "DELETE") return responseFor(accepted.response.status, accepted.response.body, "application/json");
      return responseFor(invalid.response.status, invalid.response.body, "application/json");
    });
    const clearSession = jest.fn();
    const signedOut = jest.fn();
    const screen = await render(
      <DeleteAccountScreen
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken={idToken()}
        client={client}
        onReauth={() => undefined}
        onSignedOut={signedOut}
        onClearSession={clearSession}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    fireEvent.press(screen.getByTestId("delete-account-continue"));
    await waitFor(() => expect(screen.queryByTestId("delete-account-confirm")).not.toBeNull());
    fireEvent.press(screen.getByTestId("delete-account-confirm"));
    await waitFor(() => expect(screen.queryByTestId("deletion-reauth")).not.toBeNull());
    expect(clearSession).not.toHaveBeenCalled();
    expect(signedOut).not.toHaveBeenCalled();
    expect(await textOf(secrets, "account-deletion:job-id")).toBe(accepted.response.body.jobId);
    expect(await secrets.get(workspaceKeyId("ws-1"))).toEqual(new Uint8Array([5]));
  });

  it("a Firebase-token invalid_token signals signed_out, clears only the session, and keeps polling", async () => {
    const invalid = loadFixture<ErrorBody>("account-deletion/invalid-token.json");
    expect(invalid.request.method).toBe("DELETE");
    const secrets = new MemorySecretStore();
    const client = clientFor(async () => responseFor(invalid.response.status, invalid.response.body, "application/json"));
    const clearSession = jest.fn();
    const signedOut = jest.fn();
    const screen = await render(
      <DeleteAccountScreen
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken={idToken()}
        client={client}
        onReauth={() => undefined}
        onSignedOut={signedOut}
        onClearSession={clearSession}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    fireEvent.press(screen.getByTestId("delete-account-continue"));
    await waitFor(() => expect(screen.queryByTestId("delete-account-confirm")).not.toBeNull());
    fireEvent.press(screen.getByTestId("delete-account-confirm"));
    await waitFor(() => expect(clearSession).toHaveBeenCalledTimes(1));
    expect(signedOut).not.toHaveBeenCalled();
    expect(screen.getByTestId("deletion-progress")).toBeTruthy();
    expect(screen.queryByTestId("deletion-reauth")).toBeNull();
  });

  it("409 deletion_not_retryable is DeletionNotRetryableError and shows support beside Dismiss", async () => {
    expect(DeletionNotRetryableError).toBeInstanceOf(Function);
    const blocked = loadFixture<{ error: string; jobId: string }>("account-deletion/retry-not-retryable.json");
    const jobId = blocked.response.body.jobId;
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("ws-1"), new Uint8Array([8]));
    const client = clientFor(async () => responseFor(blocked.response.status, blocked.response.body, "application/json"));
    const screen = await render(
      <DeleteAccountScreen
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken={idToken()}
        client={client}
        onReauth={() => undefined}
        onSignedOut={() => undefined}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    fireEvent.press(screen.getByTestId("delete-account-continue"));
    await waitFor(() => expect(screen.queryByTestId("delete-account-confirm")).not.toBeNull());
    fireEvent.press(screen.getByTestId("delete-account-confirm"));
    await waitFor(() => expect(screen.queryByTestId("deletion-dismiss")).not.toBeNull());
    expect(screen.getByLabelText("Contact support")).toBeTruthy();
    expect(screen.queryByText(SUPPORT_CONTACT.value)).toBeNull();
    expect(screen.getByText("We couldn't finish deleting your account. Contact support and we'll complete it for you.")).toBeTruthy();
    expect(screen.queryByTestId("deletion-retry")).toBeNull();
    expect(await textOf(secrets, "account-deletion:job-id")).toBe(jobId);
    expect(await secrets.get(workspaceKeyId("ws-1"))).toEqual(new Uint8Array([8]));
    fireEvent.press(screen.getByTestId("deletion-dismiss"));
    await waitFor(async () => {
      expect(await textOf(secrets, "account-deletion:job-id")).toBeNull();
    });
    expect(await secrets.get(workspaceKeyId("ws-1"))).toEqual(new Uint8Array([8]));
  });

  it("a failed status with retryable false shows Contact support and Dismiss and does not retry", async () => {
    const accepted = loadFixture<AcceptedBody>("account-deletion/accepted.json");
    const failed = loadFixture<StatusBody>("account-deletion/status-failed-not-retryable.json");
    expect(failed.response.status).toBe(200);
    expect(failed.response.body).toMatchObject({ status: "failed", retryable: false });
    const secrets = new MemorySecretStore();
    const methods: string[] = [];
    const client = clientFor(async (_input, init) => {
      methods.push(init?.method ?? "");
      if (init?.method === "DELETE") return responseFor(accepted.response.status, accepted.response.body, "application/json");
      return responseFor(failed.response.status, failed.response.body, "application/json");
    });
    const screen = await render(
      <DeleteAccountScreen
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken={idToken()}
        client={client}
        onReauth={() => undefined}
        onSignedOut={() => undefined}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    fireEvent.press(screen.getByTestId("delete-account-continue"));
    await waitFor(() => expect(screen.queryByTestId("delete-account-confirm")).not.toBeNull());
    fireEvent.press(screen.getByTestId("delete-account-confirm"));
    await waitFor(() => expect(screen.getByLabelText("Contact support")).toBeTruthy());
    expect(screen.getByTestId("deletion-dismiss")).toBeTruthy();
    expect(screen.queryByTestId("deletion-retry")).toBeNull();
    expect(methods.filter((method) => method === "DELETE")).toEqual(["DELETE"]);
    expect(await textOf(secrets, "account-deletion:job-id")).toBe(accepted.response.body.jobId);
  });

  it("a status GET 401 unauthorized or a bare 401 is reauth_required and keeps the job", async () => {
    const accepted = loadFixture<AcceptedBody>("account-deletion/accepted.json");
    const unauthorized = loadFixture<ErrorBody>("account-deletion/status-unauthorized.json");
    expect(unauthorized.response).toEqual({ status: 401, body: { error: "unauthorized" } });
    const secrets = new MemorySecretStore();
    const methods: string[] = [];
    const client = clientFor(async (_input, init) => {
      methods.push(init?.method ?? "");
      if (init?.method === "DELETE") return responseFor(accepted.response.status, accepted.response.body, "application/json");
      return responseFor(unauthorized.response.status, unauthorized.response.body, "application/json");
    });
    const screen = await render(
      <DeleteAccountScreen
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken={idToken()}
        client={client}
        onReauth={() => undefined}
        onSignedOut={() => undefined}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    fireEvent.press(screen.getByTestId("delete-account-continue"));
    await waitFor(() => expect(screen.queryByTestId("delete-account-confirm")).not.toBeNull());
    fireEvent.press(screen.getByTestId("delete-account-confirm"));
    await waitFor(() => expect(screen.getByTestId("deletion-reauth")).toBeTruthy());
    expect(screen.queryByTestId("deletion-progress")).toBeNull();
    expect(methods.filter((method) => method === "GET")).toHaveLength(1);
    expect(await textOf(secrets, "account-deletion:job-id")).toBe(accepted.response.body.jobId);

    const bare = new MemorySecretStore();
    const bareMethods: string[] = [];
    const bareClient = clientFor(async (_input, init) => {
      bareMethods.push(init?.method ?? "");
      if (init?.method === "DELETE") return responseFor(accepted.response.status, accepted.response.body, "application/json");
      return responseFor(401, {}, "application/json");
    });
    const bareScreen = await render(
      <DeleteAccountScreen
        activeTransfers={0}
        secrets={bare}
        workspaceIds={["ws-1"]}
        idToken={idToken()}
        client={bareClient}
        onReauth={() => undefined}
        onSignedOut={() => undefined}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    fireEvent.press(bareScreen.getByTestId("delete-account-continue"));
    await waitFor(() => expect(bareScreen.queryByTestId("delete-account-confirm")).not.toBeNull());
    fireEvent.press(bareScreen.getByTestId("delete-account-confirm"));
    await waitFor(() => expect(bareScreen.getByTestId("deletion-reauth")).toBeTruthy());
    expect(bareMethods.filter((method) => method === "GET")).toHaveLength(1);
    expect(await textOf(bare, "account-deletion:job-id")).toBe(accepted.response.body.jobId);
  });
});
