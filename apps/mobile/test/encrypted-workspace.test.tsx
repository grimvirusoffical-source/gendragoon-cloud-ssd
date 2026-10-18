import {
  GenDragoonClient,
  LIBRARY_OBJECT_ID,
  MemorySecretStore,
  treeNode,
  workspaceKeyId,
  type SecretStore,
} from "@gendragoon/core";
import { render } from "@testing-library/react-native";
import { createEncryptedWorkspace, encryptedReplaceRequests } from "../src/encryptedWorkspace";
import { ENCRYPTED_WORKSPACE_ENABLED } from "../src/flags";
import { FileTree } from "../src/screens";
import { loadFixture } from "./loadFixture";

const WORKSPACE = "11111111-1111-4111-8111-000000000001";

interface EnvelopeError {
  error: string;
}

interface ServerEnvelope {
  kdf: string;
  version: number;
  wrappedKey: string;
}

function tracingStore(events: string[]): SecretStore {
  const inner = new MemorySecretStore();
  return {
    async get(name) {
      return inner.get(name);
    },
    async set(name, bytes) {
      events.push(`set:${name}`);
      await inner.set(name, bytes);
    },
    async delete(name) {
      events.push(`delete:${name}`);
      await inner.delete(name);
    },
  };
}

describe("encrypted workspace flag", () => {
  it("is off, so encrypted upload and the passphrase route stay hidden", async () => {
    expect(ENCRYPTED_WORKSPACE_ENABLED).toBe(false);
    const file = treeNode({ path: "Pictures/vacation.jpg", directory: false });
    const screen = await render(
      <FileTree
        mode="upload"
        nodes={[file]}
        locked={false}
        selected={file}
        onSelect={() => undefined}
        onRefresh={() => undefined}
        onUpload={() => undefined}
      />,
    );
    expect(screen.queryByTestId("upload-button")).toBeNull();
    expect(screen.getByTestId("file-vacation.jpg")).toBeTruthy();
  });

  it.failing("a 409 on envelope create leaves no new key in SecureStore and uses the fetched key", async () => {
    const conflict = loadFixture<EnvelopeError>("key-envelope/conflict.json");
    const fetched = loadFixture<ServerEnvelope>("key-envelope/get.json");
    expect(conflict.response.status).toBe(409);
    expect(conflict.response.body.error).toBe("envelope_exists");
    expect(conflict.request.headers["if-none-match"]).toBe("*");
    expect(fetched.response.status).toBe(200);

    const events: string[] = [];
    const secrets = tracingStore(events);
    const methods: string[] = [];
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => "token",
      fetch: async (_input, init) => {
        const method = init?.method ?? "";
        methods.push(method);
        if (method === "PUT") {
          events.push("put-409");
          return new Response(JSON.stringify(conflict.response.body), {
            status: conflict.response.status,
            headers: { "content-type": "application/json" },
          });
        }
        events.push("get");
        return new Response(JSON.stringify(fetched.response.body), {
          status: fetched.response.status,
          headers: { "content-type": "application/json" },
        });
      },
    });

    let key: Uint8Array | undefined;
    let thrown: unknown;
    try {
      key = await createEncryptedWorkspace({
        client,
        secrets,
        workspaceId: WORKSPACE,
        passphrase: "correct horse",
      });
    } catch (error) {
      thrown = error;
    }
    const stored = await secrets.get(workspaceKeyId(WORKSPACE));
    const setAt = events.findIndex((event) => event.startsWith("set:"));
    const rejectedAt = events.indexOf("put-409");
    expect({
      thrown: thrown instanceof Error ? thrown.name : thrown,
      methods,
      savedNewKeyBeforeServerAccepted: setAt >= 0 && (rejectedAt < 0 || setAt < rejectedAt),
      usedFetchedKey: stored !== null && key !== undefined && stored.length === key.length && stored.every((byte, index) => byte === key?.[index]),
    }).toEqual({
      thrown: undefined,
      methods: ["PUT", "GET"],
      savedNewKeyBeforeServerAccepted: false,
      usedFetchedKey: true,
    });
  });

  it.failing("replacing a file uploads the new copy, commits the manifest with ifGeneration, then deletes the old object", () => {
    const put = loadFixture("storage-urls/put.json");
    const manifest = loadFixture("storage-urls/manifest-put.json");
    const remove = loadFixture("storage-urls/delete.json");
    expect(manifest.request.body).toMatchObject({ op: "put", objects: ["manifest"], ifGeneration: 0 });
    const steps = encryptedReplaceRequests({
      oid: LIBRARY_OBJECT_ID,
      sizeBytes: 4,
    });
    expect(steps).toEqual([
      put.request.body,
      manifest.request.body,
      remove.request.body,
    ]);
  });
});
