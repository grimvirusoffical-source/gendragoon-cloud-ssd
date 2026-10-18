import {
  GenDragoonClient,
  MemorySecretStore,
  workspaceKeyId,
} from "@gendragoon/core";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { deletionSessionAction, deleteSignedInAccount, savedDeletionUid } from "../src/account/deleteAccount";
import { DeleteAccountScreen } from "../src/screens";

function idToken(authTimeSeconds: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ auth_time: authTimeSeconds, sub: "user-1" })}.sig`;
}

function freshToken(): string {
  return idToken(Math.floor(Date.now() / 1000) - 30);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientFor(fetchImpl: typeof fetch): GenDragoonClient {
  return new GenDragoonClient({
    baseUrl: "https://api.example.test",
    getToken: () => freshToken(),
    fetch: fetchImpl,
  });
}

describe("deletion poll rulings", () => {
  it("a 401 with no error code goes to sign-in, keeps the saved job, and wipes nothing", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("ws-1"), new Uint8Array([4]));
    const methods: string[] = [];
    const client = clientFor(async (_input, init) => {
      methods.push(init?.method ?? "");
      if (init?.method === "DELETE") {
        return json(202, { status: "deleting", jobId: "job-401", statusToken: "token-401" });
      }
      return json(401, {});
    });
    const error = await deleteSignedInAccount({
      client,
      idToken: freshToken(),
      workspaceIds: ["ws-1"],
      secrets,
    }).catch((caught: unknown) => caught);
    expect(deletionSessionAction(error)).toBe("reauth");
    expect(await secrets.get(workspaceKeyId("ws-1"))).toEqual(new Uint8Array([4]));
    expect(await savedDeletionUid(secrets)).toBe("user-1");
    expect(await secrets.get("account-deletion:job-id")).not.toBeNull();

    methods.length = 0;
    const again = await deleteSignedInAccount({
      client,
      idToken: freshToken(),
      workspaceIds: ["ws-1"],
      secrets,
    }).catch((caught: unknown) => caught);
    expect(deletionSessionAction(again)).toBe("reauth");
    expect(methods).toEqual(["GET"]);
    expect(await savedDeletionUid(secrets)).toBe("user-1");
    expect(await secrets.get("account-deletion:job-id")).not.toBeNull();
    expect(await secrets.get(workspaceKeyId("ws-1"))).toEqual(new Uint8Array([4]));
  });

  it("a 404 while polling keeps the job and shows Retry", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("ws-1"), new Uint8Array([6]));
    const methods: string[] = [];
    const client = clientFor(async (_input, init) => {
      methods.push(init?.method ?? "");
      const header = new Headers(init?.headers).get("authorization");
      if (init?.method === "DELETE") {
        return json(202, { status: "deleting", jobId: "job-404", statusToken: "token-404" });
      }
      expect(header).toBe("Bearer token-404");
      return json(404, { error: "not_found" });
    });
    const screen = await render(
      <DeleteAccountScreen
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken={freshToken()}
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
    expect(await savedDeletionUid(secrets)).toBe("user-1");
    expect(await secrets.get("account-deletion:job-id")).not.toBeNull();
    expect(await secrets.get(workspaceKeyId("ws-1"))).toEqual(new Uint8Array([6]));

    fireEvent.press(screen.getByTestId("deletion-retry"));
    await waitFor(() => {
      expect(methods.filter((method) => method === "GET").length).toBe(2);
    });
    expect(methods.filter((method) => method === "DELETE")).toEqual(["DELETE"]);
    expect(await savedDeletionUid(secrets)).toBe("user-1");
    expect(await secrets.get("account-deletion:job-id")).not.toBeNull();
    expect(await secrets.get(workspaceKeyId("ws-1"))).toEqual(new Uint8Array([6]));
  });

  it("dismissing the poll error clears the saved job and wipes nothing", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("ws-1"), new Uint8Array([8]));
    const client = clientFor(async (_input, init) => {
      if (init?.method === "DELETE") {
        return json(202, { status: "deleting", jobId: "job-dismiss", statusToken: "token-dismiss" });
      }
      return json(404, { error: "not_found" });
    });
    const screen = await render(
      <DeleteAccountScreen
        activeTransfers={0}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken={freshToken()}
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
      expect(screen.queryByTestId("deletion-dismiss")).not.toBeNull();
    });
    fireEvent.press(screen.getByTestId("deletion-dismiss"));
    await waitFor(() => {
      expect(screen.queryByTestId("deletion-error")).toBeNull();
    });
    expect(await savedDeletionUid(secrets)).toBeNull();
    expect(await secrets.get("account-deletion:job-id")).toBeNull();
    expect(await secrets.get(workspaceKeyId("ws-1"))).toEqual(new Uint8Array([8]));
  });
});
