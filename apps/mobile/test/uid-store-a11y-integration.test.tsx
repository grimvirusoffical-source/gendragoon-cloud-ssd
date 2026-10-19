/**
 * Integration of the uid-store stack (core saves/clears the deletion uid, strict
 * accountUidFromIdToken) with the a11y stack (mobile SignInSession swap guard,
 * test-only session-uid element). Both behaviors must hold together.
 */
import { DELETION_UID_KEY, GenDragoonClient, MemorySecretStore, accountUidFromIdToken, readDeletionUid } from "@gendragoon/core";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { deleteSignedInAccount, dismissSignedInDeletion, savedDeletionUid } from "../src/account/deleteAccount";
import { SAME_ACCOUNT_MESSAGE } from "../src/account/session";
import { SignInSession } from "../src/screens";

function token(claims: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc({ auth_time: Math.floor(Date.now() / 1000) - 30, ...claims })}.sig`;
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function clientFor(idToken: string) {
  return new GenDragoonClient({
    baseUrl: "https://api.example.test",
    getToken: () => idToken,
    fetch: async (_i, init) =>
      init?.method === "DELETE" ? json(202, { status: "deleting", jobId: "job-1", statusToken: "st-1" }) : json(401, {}),
  });
}

describe("uid-store + a11y integration", () => {
  it("uses the strict core parser (user_id mismatch is not an account)", () => {
    expect(accountUidFromIdToken(token({ sub: "user-1", user_id: "someone-else" }))).toBeNull();
    expect(accountUidFromIdToken(token({ sub: "user-1", user_id: "user-1" }))).toBe("user-1");
    expect(accountUidFromIdToken("not-a-jwt")).toBeNull();
  });

  it("mobile and core agree on the saved uid key and value", async () => {
    const secrets = new MemorySecretStore();
    const t = token({ sub: "user-1" });
    await deleteSignedInAccount({ client: clientFor(t), idToken: t, workspaceIds: [], secrets }).catch(() => undefined);
    expect(await readDeletionUid(secrets)).toBe("user-1");
    expect(await savedDeletionUid(secrets)).toBe("user-1");
    expect(new TextDecoder().decode((await secrets.get(DELETION_UID_KEY)) ?? new Uint8Array())).toBe("user-1");
  });

  it("a token the strict parser rejects saves no uid", async () => {
    const secrets = new MemorySecretStore();
    const t = token({ sub: "user-1", user_id: "other" });
    await deleteSignedInAccount({ client: clientFor(t), idToken: t, workspaceIds: [], secrets }).catch(() => undefined);
    expect(await readDeletionUid(secrets)).toBeNull();
  });

  it("swap guard blocks another account using the saved uid", async () => {
    const secrets = new MemorySecretStore();
    const original = token({ sub: "user-1" });
    await deleteSignedInAccount({ client: clientFor(original), idToken: original, workspaceIds: [], secrets }).catch(() => undefined);
    const swapped = jest.fn();
    const blocked = await render(
      <SignInSession secrets={secrets} sessionToken="" nextToken={token({ sub: "user-2" })} googleEnabled={false} onSwapped={swapped} />,
    );
    fireEvent.press(blocked.getByTestId("sign-in"));
    await waitFor(() => expect(blocked.getByText(SAME_ACCOUNT_MESSAGE)).toBeTruthy());
    expect(swapped).not.toHaveBeenCalled();
  });

  it("swap guard allows the same account", async () => {
    const secrets = new MemorySecretStore();
    const original = token({ sub: "user-1" });
    await deleteSignedInAccount({ client: clientFor(original), idToken: original, workspaceIds: [], secrets }).catch(() => undefined);
    const swapped = jest.fn();
    const ok = await render(
      <SignInSession secrets={secrets} sessionToken="" nextToken={token({ sub: "user-1" })} googleEnabled={false} onSwapped={swapped} />,
    );
    fireEvent.press(ok.getByTestId("sign-in"));
    await waitFor(() => expect(swapped).toHaveBeenCalledTimes(1));
  });

  it("dismissing the deletion clears the uid so another account may sign in", async () => {
    const secrets = new MemorySecretStore();
    const original = token({ sub: "user-1" });
    await deleteSignedInAccount({ client: clientFor(original), idToken: original, workspaceIds: [], secrets }).catch(() => undefined);
    await dismissSignedInDeletion(secrets);
    expect(await readDeletionUid(secrets)).toBeNull();
    const swapped = jest.fn();
    const s = await render(
      <SignInSession secrets={secrets} sessionToken="" nextToken={token({ sub: "user-2" })} googleEnabled={false} onSwapped={swapped} />,
    );
    fireEvent.press(s.getByTestId("sign-in"));
    await waitFor(() => expect(swapped).toHaveBeenCalledTimes(1));
  });
});
