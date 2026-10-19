import { readFileSync } from "node:fs";
import path from "node:path";
import {
  GenDragoonClient,
  BYO_PRESIGNED_URL_MESSAGE,
  assertNoCredentialFields,
  byoErrorMessage,
  challengeObjectKey,
  type WorkspaceRecord,
} from "@gendragoon/core";
import { fireEvent, render } from "@testing-library/react-native";
import { byoServerFlowReady, connectBucket } from "../src/byoReady";
import { ConnectStorageScreen, LockScreen, SettingsHome, WorkspacesScreen, lockReasonMessage } from "../src/screens";
import { FIXTURE_SOURCE_SHA, FIXTURE_SOURCE_SHA_BY_AREA, loadFixture } from "./loadFixture";

const LOCKS = [
  "lapsed",
  "merge-in-progress",
  "over-cap-and-lapsed",
  "over-cap",
  "scope-unavailable",
] as const;

interface LockBody {
  error: string;
  reason: string;
  overBy: number;
  unpaidWorkspaceIds: string[];
}

interface WorkspaceRow {
  id: string;
  name: string;
  kind: WorkspaceRecord["kind"];
}

interface WorkspaceListBody {
  policy: { workspaceMonthlyCents: number };
  workspaces: WorkspaceRow[];
}

interface CreateBody {
  policy: { workspaceMonthlyCents: number };
  project: WorkspaceRow;
}

interface CapBody {
  error: string;
  message: string;
}

interface MergePreviewBody {
  confirmName: string;
  sourceId: string;
  targetId: string;
  files: { name: string; renamedTo: string; sizeBytes: number }[];
}

interface MergeResultBody {
  copied: number;
  merged: boolean;
  sourceDeleted: boolean;
  sourceId: string;
  workspaceId: string;
}

interface MergeErrorBody {
  error: string;
  message: string;
}

interface FileListBody {
  files: { id: string; name: string; sizeBytes: number }[];
}

interface RegisterBody {
  bucketFingerprint: string;
  byoRegistered: boolean;
  endpoint: string;
  providerType: string;
}

interface ChallengeBody {
  expiresAtMs: number;
  nonce: string;
  ttlMs: number;
}

interface VerifyBody {
  bucketFingerprint?: string;
  verified?: boolean;
  workspaceId?: string;
  error?: string;
  message?: string;
  provider?: string;
}

function listedWorkspaces(): WorkspaceRecord[] {
  const list = loadFixture<WorkspaceListBody>("workspaces/list.json");
  return list.response.body.workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    kind: workspace.kind,
  }));
}

async function errorFromFixture(rel: string): Promise<unknown> {
  const fixture = loadFixture(rel);
  const client = new GenDragoonClient({
    baseUrl: "https://api.example.test",
    getToken: () => "token",
    fetch: async () => new Response(JSON.stringify(fixture.response.body), {
      status: fixture.response.status,
      headers: { "content-type": "application/json" },
    }),
  });
  try {
    await client.pricing();
  } catch (error) {
    return error;
  }
  throw new Error(`${rel} did not fail`);
}

function textOf(node: { props: { children?: unknown } } | null): string {
  if (!node) return "";
  const children = node.props.children;
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) {
    return children.map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : "")).join("");
  }
  return "";
}

const LOCK_LEAD: Record<(typeof LOCKS)[number], string> = {
  "over-cap": "This account is over the workspace cap.",
  lapsed: "A workspace payment has lapsed. Pay to restore this workspace.",
  "over-cap-and-lapsed": "This account is over the cap and a workspace payment has lapsed. Pay to restore this workspace.",
  "merge-in-progress": "A merge is in progress.",
  "scope-unavailable": "Workspace scope is unavailable.",
};

describe("vendored cloud-ssd fixtures", () => {
  it("records the workspace pricing SHA from gendragoon-cloud-ssd PR #5", () => {
    const fixture = loadFixture("workspaces/list.json");
    expect(fixture.sourceSha).toBe(FIXTURE_SOURCE_SHA_BY_AREA.workspaces);
    expect(fixture.sourceSha).toBe("4c3dd13587fae1ddfa907ad2b84c0886d7794ade");
    expect(FIXTURE_SOURCE_SHA).toBe("da3927627fee76103981714f9f8ffa954843b74b");
    expect(fixture.response.status).toBe(200);
    expect(fixture.request.path).toBe("/v2/workspaces");
  });

  it.each(LOCKS)("lock fixture %s has its own reason message", async (name) => {
    const fixture = loadFixture<LockBody>(`workspace-lock/${name}.json`);
    expect(fixture.response.status).toBe(423);
    expect(fixture.response.body.error).toBe("workspace_lock");
    const message = lockReasonMessage(fixture.response.body.reason, fixture.response.body.overBy);
    const others = LOCKS.filter((item) => item !== name).map((item) => LOCK_LEAD[item]);
    expect(others).not.toContain(message);
    expect(message).not.toMatch(/Over by 0/);
    if (name === "over-cap" || name === "over-cap-and-lapsed") {
      expect(message).toContain("You're 1 workspace over your plan.");
    } else {
      expect(message).not.toMatch(/over your plan/);
    }
    const onReview = jest.fn();
    const onPay = jest.fn();
    const screen = await render(
      <LockScreen workspaces={listedWorkspaces()} lock={fixture.response.body} onReview={onReview} onPay={onPay} />,
    );
    const reason = screen.getByTestId("lock-reason");
    expect(textOf(reason)).toBe(message);
    expect(textOf(reason)).not.toBe(fixture.response.body.reason);
    for (const id of fixture.response.body.unpaidWorkspaceIds) {
      const row = screen.queryByTestId(`lock-workspace-${id}`);
      if (row) expect(textOf(row)).toContain("· unpaid");
      else expect(textOf(screen.getByTestId(`lock-unmatched-${id}`))).toBe(`${id} · unpaid`);
    }
    if (fixture.response.body.unpaidWorkspaceIds.length === 0) {
      expect(screen.queryByText(/· unpaid/)).toBeNull();
    }
    fireEvent.press(screen.getByTestId("review-workspaces"));
    expect(onReview).toHaveBeenCalledTimes(1);
    const pays = name === "lapsed" || name === "over-cap-and-lapsed";
    if (pays) expect(screen.getByTestId("pay-to-restore")).toBeTruthy();
    else expect(screen.queryByTestId("pay-to-restore")).toBeNull();
    if (name === "merge-in-progress") {
      expect(textOf(screen.getByTestId("merge-in-progress-detail"))).toBe(
        "Uploads and changes stay paused until the merge finishes.",
      );
    } else {
      expect(screen.queryByTestId("merge-in-progress-detail")).toBeNull();
    }
  });

  it("pay to restore is the action for a lapsed lock", async () => {
    const fixture = loadFixture<LockBody>("workspace-lock/lapsed.json");
    const onPay = jest.fn();
    const screen = await render(
      <LockScreen workspaces={listedWorkspaces()} lock={fixture.response.body} onReview={() => undefined} onPay={onPay} />,
    );
    fireEvent.press(screen.getByTestId("pay-to-restore"));
    expect(onPay).toHaveBeenCalledTimes(1);
  });

  it("omits an over-plan count unless the lock is over cap and overBy is positive", () => {
    expect(lockReasonMessage("lapsed", 0)).toBe("A workspace payment has lapsed. Pay to restore this workspace.");
    expect(lockReasonMessage("over_cap", 0)).toBe("This account is over the workspace cap.");
    expect(lockReasonMessage("over_cap", 2)).toBe("This account is over the workspace cap. You're 2 workspaces over your plan.");
  });

  it("workspaces screen lists the server project and the monthly fee", async () => {
    const list = loadFixture<WorkspaceListBody>("workspaces/list.json");
    const created = loadFixture<CreateBody>("workspaces/create.json");
    const capped = loadFixture<CapBody>("workspaces/cap-reached.json");
    expect(capped.response.status).toBe(409);
    expect(capped.response.body.error).toBe("PROJECT_LIMIT_REACHED");
    const screen = await render(
      <WorkspacesScreen
        workspaces={listedWorkspaces()}
        unpaidIds={[]}
        additionalMonthlyCents={list.response.body.policy.workspaceMonthlyCents}
        capMessage={capped.response.body.message}
        onDelete={() => undefined}
        onMerge={() => undefined}
      />,
    );
    const listed = list.response.body.workspaces[0];
    expect(listed).toBeTruthy();
    expect(textOf(screen.getByTestId(`workspace-name-${listed!.id}`))).toBe(listed!.name);
    expect(screen.getByText("An additional workspace is $5.00/mo.")).toBeTruthy();
    expect(screen.getByText(capped.response.body.message)).toBeTruthy();
    expect(created.response.body.project.name).toBe(listed!.name);
    expect(created.response.body.policy.workspaceMonthlyCents).toBe(list.response.body.policy.workspaceMonthlyCents);
  });

  it("merge screen shows the server preview, confirm error, and completed names", async () => {
    const preview = loadFixture<MergePreviewBody>("merge/preview.json");
    const denied = loadFixture<MergeErrorBody>("merge/confirm-name.json");
    const completed = loadFixture<MergeResultBody>("merge/completed.json");
    const renamed = loadFixture<FileListBody>("merge/renamed-file.json");
    expect(preview.request.path).toContain("/merge/preview");
    expect(denied.response.status).toBe(400);
    expect(denied.response.body.error).toBe("CONFIRM_NAME_REQUIRED");
    const list = loadFixture<WorkspaceListBody>("workspaces/list.json");
    const screen = await render(
      <WorkspacesScreen
        workspaces={listedWorkspaces()}
        unpaidIds={[]}
        additionalMonthlyCents={list.response.body.policy.workspaceMonthlyCents}
        serverPreview={preview.response.body}
        mergeError={denied.response.body.message}
        mergeResult={completed.response.body}
        mergedFiles={renamed.response.body.files}
        onDelete={() => undefined}
        onMerge={() => undefined}
      />,
    );
    const file = preview.response.body.files[0];
    expect(file).toBeTruthy();
    expect(screen.getByText(`${file!.name} → ${file!.renamedTo}`)).toBeTruthy();
    expect(screen.getByText(denied.response.body.message)).toBeTruthy();
    expect(textOf(screen.getByTestId("merge-result"))).toContain(completed.response.body.workspaceId);
    expect(textOf(screen.getByTestId("merge-result"))).toContain("Source deleted.");
    for (const entry of renamed.response.body.files) {
      expect(textOf(screen.getByTestId(`merged-file-${entry.id}`))).toBe(entry.name);
    }
  });

  it("keeps BYO connect off the encrypted key and manifest path", () => {
    const flow = readFileSync(path.join(__dirname, "../src/byoReady.ts"), "utf8");
    expect(byoServerFlowReady()).toBe(true);
    expect(flow).not.toMatch(/establishWorkspaceKey|openWorkspaceKey|commitManifest|mergeSealedManifest|putKeyEnvelope|getKeyEnvelope/);
    expect(flow).toMatch(/registerByo/);
    expect(flow).toMatch(/verifyByo/);
  });

  it("shows S3 launch providers and keeps SFTP, Azure, and WebDAV as coming soon", async () => {
    expect(byoServerFlowReady()).toBe(true);
    const flow = readFileSync(path.join(__dirname, "../src/byoReady.ts"), "utf8");
    const screens = readFileSync(path.join(__dirname, "../src/screens.tsx"), "utf8");
    const app = readFileSync(path.join(__dirname, "../App.tsx"), "utf8");
    expect(flow).toMatch(/registerByo/);
    expect(flow).toMatch(/createByoChallenge/);
    expect(flow).toMatch(/verifyByo/);
    expect(flow).toMatch(/createSigV4ChallengeWriter/);
    expect(`${flow}\n${screens}\n${app}`).not.toMatch(/byo\/proof|byoSecretId|secretAccessKey|DeviceByoCredentials/);
    const register = loadFixture<RegisterBody>("byo/register.json");
    const challenge = loadFixture<ChallengeBody>("byo/challenge.json");
    const verified = loadFixture<VerifyBody>("byo/verify-success.json");
    const unsupported = loadFixture<VerifyBody>("byo/provider-unsupported.json");
    expect(register.request.path).toContain("/byo/register");
    expect(challenge.request.body).toBeNull();
    expect(challenge.request.path).toContain("/byo/challenge");
    expect(unsupported.response.status).toBe(422);
    expect(unsupported.response.body.error).toBe("byo_provider_unsupported");
    expect(unsupported.response.body.provider).toBe("sftp");
    assertNoCredentialFields(register.request.body);
    const objectKey = challengeObjectKey(challenge.response.body.nonce);
    const proof = verified.request.body as { presignedUrl?: string; readBack?: string };
    expect(proof.readBack).toBeUndefined();
    expect(proof.presignedUrl).toContain(`/${objectKey}`);
    expect(Object.keys(verified.request.body as object)).toEqual(["presignedUrl"]);
    const unsupportedError = await errorFromFixture("byo/provider-unsupported.json");
    const screen = await render(
      <ConnectStorageScreen
        registration={register.response.body}
        challengeNonce={challenge.response.body.nonce}
        verified={{
          verified: verified.response.body.verified === true,
          workspaceId: verified.response.body.workspaceId ?? "",
        }}
        error={unsupportedError}
      />,
    );
    expect(screen.queryByTestId("byo-unavailable")).toBeNull();
    expect(screen.getByTestId("byo-aws")).toBeTruthy();
    expect(screen.getByTestId("byo-r2")).toBeTruthy();
    expect(screen.queryByTestId("byo-sftp")).toBeNull();
    expect(textOf(screen.getByTestId("byo-soon-sftp"))).toBe("SFTP · Coming soon");
    expect(screen.getByTestId("byo-soon-azure-blob")).toBeTruthy();
    expect(screen.getByTestId("byo-soon-webdav")).toBeTruthy();
    expect(textOf(screen.getByTestId("byo-registered"))).toContain(register.response.body.endpoint);
    expect(textOf(screen.getByTestId("byo-registered"))).toContain(register.response.body.providerType);
    expect(textOf(screen.getByTestId("byo-challenge-key"))).toBe(objectKey);
    expect(textOf(screen.getByTestId("byo-verified"))).toBe(verified.response.body.workspaceId ?? "");
    expect(screen.getByText(byoErrorMessage(unsupportedError))).toBeTruthy();
    const home = await render(
      <SettingsHome
        deleteDisabled={false}
        onSort={() => undefined}
        onDelete={() => undefined}
        onSignOut={() => undefined}
      />,
    );
    expect(home.queryByTestId("open-connect")).toBeNull();

    for (const name of ["verify-expired", "verify-host-mismatch", "verify-mismatch", "verify-used"]) {
      const fixture = loadFixture<VerifyBody>(`byo/${name}.json`);
      expect(fixture.response.status).toBe(400);
      expect(fixture.request.path).toContain("/byo/verify");
      expect(Object.keys(fixture.request.body as object)).toEqual(["presignedUrl"]);
      expect(JSON.stringify(fixture.request.body)).not.toContain("readBack");
      const error = await errorFromFixture(`byo/${name}.json`);
      const failed = await render(<ConnectStorageScreen error={error} />);
      expect(failed.getByText(byoErrorMessage(error))).toBeTruthy();
      expect(failed.getByTestId("byo-aws")).toBeTruthy();
      expect(textOf(failed.getByTestId("byo-soon-azure-blob"))).toContain("Coming soon");
      expect(textOf(failed.getByTestId("byo-soon-webdav"))).toContain("Coming soon");
      await failed.unmount();
    }
  });

  it("shows presigned_url_required from byo/verify-missing-url as a friendly error", async () => {
    const fixture = loadFixture<VerifyBody>("byo/verify-missing-url.json");
    expect(fixture.response.status).toBe(400);
    expect(fixture.response.body.error).toBe("presigned_url_required");
    expect(fixture.request.body).toEqual({});
    expect(JSON.stringify(fixture.request.body)).not.toContain("readBack");
    expect(fixture.request.path).toContain("/byo/verify");
    const missing = await errorFromFixture("byo/verify-missing-url.json");
    const screen = await render(<ConnectStorageScreen error={missing} />);
    expect(screen.getByText(BYO_PRESIGNED_URL_MESSAGE)).toBeTruthy();
    expect(BYO_PRESIGNED_URL_MESSAGE).not.toBe("presigned_url_required");
    expect(screen.getByTestId("byo-aws")).toBeTruthy();
    expect(textOf(screen.getByTestId("byo-soon-sftp"))).toContain("Coming soon");
  });

  it("registers, writes the challenge with a SigV4 writer, and verifies {presignedUrl}", async () => {
    const register = loadFixture<RegisterBody>("byo/register.json");
    const registration = register.request.body as { provider: string; endpoint: string; bucketFingerprint: string };
    const challenge = loadFixture<ChallengeBody>("byo/challenge.json");
    const verified = loadFixture<VerifyBody>("byo/verify-success.json");
    const nonce = challenge.response.body.nonce;
    const objectKey = challengeObjectKey(nonce);
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const presignedUrl = `https://bucket.s3.us-east-1.amazonaws.com/${objectKey}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260101T000000Z&X-Amz-Expires=300&X-Amz-Signature=fixture`;
    const writes: { key: string; body: string }[] = [];
    const seen: { url: string; body: unknown }[] = [];
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => "token",
      fetch: async (input, init) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
        seen.push({ url, body });
        if (url.endsWith("/byo/register")) {
          return new Response(JSON.stringify(register.response.body), { status: register.response.status, headers: { "content-type": "application/json" } });
        }
        if (url.endsWith("/byo/challenge")) {
          return new Response(JSON.stringify(challenge.response.body), { status: challenge.response.status, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify(verified.response.body), { status: verified.response.status, headers: { "content-type": "application/json" } });
      },
    });
    const result = await connectBucket({
      client,
      workspaceId: "11111111-1111-4111-8111-000000000001",
      registration,
      now,
      writer: {
        async write(key, body) {
          writes.push({ key, body });
        },
        async presignGet() {
          return presignedUrl;
        },
      },
    });
    expect(writes).toEqual([{ key: objectKey, body: nonce }]);
    expect(result.presignedUrl).toBe(presignedUrl);
    const verify = seen.find((call) => call.url.endsWith("/byo/verify"));
    expect(verify?.body).toEqual({ presignedUrl });
    expect(Object.keys(verify?.body as object)).toEqual(["presignedUrl"]);
    const registered = seen.find((call) => call.url.endsWith("/byo/register"));
    expect(registered?.body).toEqual(register.request.body);
  });
});
