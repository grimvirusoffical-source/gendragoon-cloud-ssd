import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, GenDragoonClient, WorkspaceLockedError, type LockAssessment, type WorkspaceRecord } from "@gendragoon/core";
import { AccountSurface } from "../src/AccountSurface.js";

const lockDir = join(dirname(fileURLToPath(import.meta.url)), "../../core/test/fixtures/server/workspace-lock");

function workspace(id: string, name: string): WorkspaceRecord {
  return {
    id,
    name,
    kind: "paid",
    projectStatus: "active",
    projectFeeStatus: "paid",
    storage: { kind: "gendragoon", storageTier: "100GB" },
  };
}

const clear: LockAssessment = {
  locked: false,
  cap: 10,
  activeCount: 2,
  overCap: false,
  unpaidIds: [],
  lapsedIds: [],
  readable: true,
  downloadsAllowed: true,
  uploadsBlocked: false,
  normalUseBlocked: false,
  highTier: false,
};

describe("AccountSurface", () => {
  const workspaces = [workspace("a", "Personal"), workspace("b", "Library")];

  it("shows the delete-or-merge lock screen for HTTP 423 instead of a generic error", () => {
    const html = renderToStaticMarkup(
      <AccountSurface
        phase="ready"
        error={new WorkspaceLockedError()}
        assessment={clear}
        workspaces={workspaces}
        onDelete={() => undefined}
      >
        <p data-testid="uploader">Uploader</p>
      </AccountSurface>,
    );
    expect(html).toContain("data-testid=\"lock-screen\"");
    expect(html).toContain("data-testid=\"lock-from-server\"");
    expect(html).not.toContain("data-testid=\"generic-error\"");
    expect(html).not.toContain("Uploader");
    expect(html).not.toContain("Request failed");
  });

  it("keeps a non-lock failure as a generic error and still shows the page", () => {
    const html = renderToStaticMarkup(
      <AccountSurface
        phase="ready"
        error={new ApiError(500, "REQUEST_FAILED", "Request failed")}
        assessment={clear}
        workspaces={workspaces}
        onDelete={() => undefined}
      >
        <p>Uploader</p>
      </AccountSurface>,
    );
    expect(html).toContain("data-testid=\"generic-error\"");
    expect(html).toContain("Request failed");
    expect(html).not.toContain("data-testid=\"lock-screen\"");
    expect(html).toContain("Uploader");
  });

  it("renders every workspace-lock fixture: reason, overBy, and unpaid workspace ids", async () => {
    for (const file of readdirSync(lockDir).filter((name) => name.endsWith(".json"))) {
      const fixture = JSON.parse(readFileSync(join(lockDir, file), "utf8")) as {
        response: { status: number; body: { reason: string; overBy: number; unpaidWorkspaceIds: string[] } };
      };
      const body = fixture.response.body;
      const client = new GenDragoonClient({
        baseUrl: "https://api.example.test",
        getToken: () => "token",
        fetch: async () => new Response(JSON.stringify(body), { status: fixture.response.status }),
      });
      const error = await client.createUpload("w", { name: "blocked.txt", sizeBytes: 4 }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(WorkspaceLockedError);
      const listed = [
        ...workspaces,
        ...body.unpaidWorkspaceIds.map((id) => workspace(id, id)),
      ];
      const html = renderToStaticMarkup(
        <AccountSurface
          phase="ready"
          error={error}
          assessment={clear}
          workspaces={listed}
          onDelete={() => undefined}
        >
          <p>Uploader</p>
        </AccountSurface>,
      );
      expect(html).toContain("data-testid=\"lock-screen\"");
      expect(html).toContain(`data-reason="${body.reason}"`);
      expect(html).toContain(`data-over-by="${body.overBy}"`);
      expect(html).toContain(`Over by ${body.overBy}.`);
      if (body.unpaidWorkspaceIds.length === 0) {
        expect(html).toContain("No unpaid workspaces.");
      }
      for (const id of body.unpaidWorkspaceIds) expect(html).toContain(id);
      expect(html).not.toContain("data-testid=\"generic-error\"");
      expect(html).not.toContain("Uploader");
    }
  });

  it("shows the lock screen when the account phase is already delete-or-merge", () => {
    const html = renderToStaticMarkup(
      <AccountSurface
        phase="delete_or_merge"
        assessment={{ ...clear, locked: true, uploadsBlocked: true, normalUseBlocked: true, overCap: true }}
        workspaces={workspaces}
        onDelete={() => undefined}
      >
        <p>Uploader</p>
      </AccountSurface>,
    );
    expect(html).toContain("Resolve workspaces to continue");
    expect(html).not.toContain("Uploader");
  });
});
