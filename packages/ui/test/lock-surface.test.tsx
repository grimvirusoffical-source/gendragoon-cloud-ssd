import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, WorkspaceLockedError, type LockAssessment, type WorkspaceRecord } from "@gendragoon/core";
import { AccountSurface } from "../src/AccountSurface.js";

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
