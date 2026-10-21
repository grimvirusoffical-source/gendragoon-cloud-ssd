import {
  GenDragoonClient,
  MemorySecretStore,
  workspaceKeyId,
} from "@gendragoon/core";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { deleteSignedInAccount, savedDeletionUid } from "../src/account/deleteAccount";
import { SAME_ACCOUNT_MESSAGE } from "../src/account/session";
import { SignInSession } from "../src/screens";

function idToken(sub: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const authTime = Math.floor(Date.now() / 1000) - 30;
  return `${encode({ alg: "none" })}.${encode({ auth_time: authTime, sub })}.sig`;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("re-sign-in checks the deletion account", () => {
  it("saves the original uid with the deletion job", async () => {
    const secrets = new MemorySecretStore();
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => idToken("user-1"),
      fetch: async (_input, init) => {
        if (init?.method === "DELETE") {
          return json(202, { status: "deleting", jobId: "job-uid", statusToken: "token-uid" });
        }
        return json(401, {});
      },
    });
    await deleteSignedInAccount({
      client,
      idToken: idToken("user-1"),
      workspaceIds: [],
      secrets,
    }).catch(() => undefined);
    expect(await savedDeletionUid(secrets)).toBe("user-1");
    expect(new TextDecoder().decode((await secrets.get("account-deletion:job-id")) ?? new Uint8Array())).toBe("job-uid");
    expect(new TextDecoder().decode((await secrets.get("account-deletion:status-token")) ?? new Uint8Array())).toBe("token-uid");
  });

  it("refuses a different account before swapping the session and wipes nothing", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("ws-1"), new Uint8Array([3]));
    const original = idToken("user-1");
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => original,
      fetch: async (_input, init) => {
        if (init?.method === "DELETE") {
          return json(202, { status: "deleting", jobId: "job-swap", statusToken: "token-swap" });
        }
        return json(401, {});
      },
    });
    await deleteSignedInAccount({
      client,
      idToken: original,
      workspaceIds: ["ws-1"],
      secrets,
    }).catch(() => undefined);
    const swapped = jest.fn();
    const screen = await render(
      <SignInSession
        secrets={secrets}
        sessionToken={original}
        nextToken={idToken("user-2")}
        googleEnabled={false}
        onSwapped={swapped}
      />,
    );
    expect(screen.getByTestId("session-uid").props.children).toBe("user-1");
    fireEvent.press(screen.getByTestId("sign-in"));
    await waitFor(() => {
      expect(screen.getByText(SAME_ACCOUNT_MESSAGE)).toBeTruthy();
    });
    expect(screen.getByTestId("session-uid").props.children).toBe("user-1");
    expect(swapped).not.toHaveBeenCalled();
    expect(await savedDeletionUid(secrets)).toBe("user-1");
    expect(new TextDecoder().decode((await secrets.get("account-deletion:job-id")) ?? new Uint8Array())).toBe("job-swap");
    expect(new TextDecoder().decode((await secrets.get("account-deletion:status-token")) ?? new Uint8Array())).toBe("token-swap");
    expect(await secrets.get(workspaceKeyId("ws-1"))).toEqual(new Uint8Array([3]));
  });

  it("swaps the session when the new sign-in is the same account", async () => {
    const secrets = new MemorySecretStore();
    const original = idToken("user-1");
    const next = idToken("user-1");
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => original,
      fetch: async (_input, init) => {
        if (init?.method === "DELETE") {
          return json(202, { status: "deleting", jobId: "job-same", statusToken: "token-same" });
        }
        return json(401, {});
      },
    });
    await deleteSignedInAccount({
      client,
      idToken: original,
      workspaceIds: [],
      secrets,
    }).catch(() => undefined);
    const swapped = jest.fn();
    const screen = await render(
      <SignInSession
        secrets={secrets}
        sessionToken={original}
        nextToken={next}
        googleEnabled={false}
        onSwapped={swapped}
      />,
    );
    fireEvent.press(screen.getByTestId("sign-in"));
    await waitFor(() => {
      expect(swapped).toHaveBeenCalledWith(next);
    });
    expect(screen.queryByText(SAME_ACCOUNT_MESSAGE)).toBeNull();
    expect(screen.getByTestId("session-uid").props.children).toBe("user-1");
  });

  it("refuses a different account before swapping even when no deletion job is saved", async () => {
    const secrets = new MemorySecretStore();
    const original = idToken("user-1");
    const swapped = jest.fn();
    const screen = await render(
      <SignInSession
        secrets={secrets}
        sessionToken={original}
        nextToken={idToken("user-2")}
        googleEnabled={false}
        onSwapped={swapped}
      />,
    );
    fireEvent.press(screen.getByTestId("sign-in"));
    await waitFor(() => {
      expect(screen.getByText(SAME_ACCOUNT_MESSAGE)).toBeTruthy();
    });
    expect(swapped).not.toHaveBeenCalled();
    expect(screen.getByTestId("session-uid").props.children).toBe("user-1");
    expect(await savedDeletionUid(secrets)).toBeNull();
  });

  it("allows the first sign-in when there is no current session and no saved job", async () => {
    const secrets = new MemorySecretStore();
    const next = idToken("user-2");
    const swapped = jest.fn();
    const screen = await render(
      <SignInSession
        secrets={secrets}
        sessionToken=""
        nextToken={next}
        googleEnabled={false}
        onSwapped={swapped}
      />,
    );
    fireEvent.press(screen.getByTestId("sign-in"));
    await waitFor(() => {
      expect(swapped).toHaveBeenCalledWith(next);
    });
    expect(screen.queryByText(SAME_ACCOUNT_MESSAGE)).toBeNull();
  });
});
