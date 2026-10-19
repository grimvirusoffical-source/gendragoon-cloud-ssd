import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProviderBinding } from "@gendragoon/core";
import { RedxConnections } from "../src/RedxConnections.js";

const noop = () => {};
const base = { error: null, grant: null, pendingRequest: null, onCreateGrant: noop, onApproveRequest: noop, onDenyRequest: noop, onRevoke: noop, onRetry: noop };
const workspaces = [{ id: "w1", name: "Studio" }];
const binding = (over: Partial<ProviderBinding> = {}): ProviderBinding => ({
  id: "0f1e2d3c-4b5a-4968-8776-655443322110", workspaceId: "w1", client: { name: "RedX", host: "josh-mac" }, scopes: ["blobs:rw"],
  usedBytes: 250_000_000, quotaBytes: 1_000_000_000, objectCount: 12, createdAt: "2026-10-01T00:00:00Z", lastUsedAt: null, lastError: null, active: true, ...over,
});

describe("RedxConnections", () => {
  it("shows loading, empty and error states", () => {
    expect(renderToStaticMarkup(<RedxConnections {...base} bindings={null} workspaces={workspaces} />)).toContain("skeleton");
    expect(renderToStaticMarkup(<RedxConnections {...base} bindings={[]} workspaces={workspaces} />)).toContain("No connected apps");
    const err = renderToStaticMarkup(<RedxConnections {...base} bindings={null} error="Down" workspaces={workspaces} />);
    expect(err).toContain('role="alert"');
    expect(err).toContain("Try again");
  });
  it("lists a connection with an accessible quota meter and a revoke button", () => {
    const html = renderToStaticMarkup(<RedxConnections {...base} bindings={[binding()]} workspaces={workspaces} />);
    expect(html).toContain("RedX");
    expect(html).toContain("Studio");
    expect(html).toContain("Read and write");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="25"');
    expect(html).toContain("250 MB of 1 GB");
    expect(html).toContain("scaleX(0.25)");
    expect(html).toContain('data-testid="revoke-0f1e2d3c-4b5a-4968-8776-655443322110"');
  });
  it("flags a full connection and hides revoke on revoked ones", () => {
    const html = renderToStaticMarkup(<RedxConnections {...base} bindings={[binding({ usedBytes: 1_000_000_000 }), binding({ id: "1".repeat(8) + "-1111-4111-8111-" + "1".repeat(12), active: false })]} workspaces={workspaces} />);
    expect(html).toContain('data-level="full"');
    expect(html).toContain("Limit reached");
    expect(html).toContain("Revoked");
    expect(html).not.toContain('data-testid="revoke-11111111');
  });
  it("shows the one-time code and a connect request", () => {
    const html = renderToStaticMarkup(
      <RedxConnections
        {...base}
        bindings={[]}
        workspaces={workspaces}
        grant={{ grant: "gdpg_" + "A".repeat(43), expiresAt: "", ttlSeconds: 300 }}
        pendingRequest={{ requester: { name: "RedX", host: "josh-mac" }, scopes: ["blobs:r"], codeChallenge: "x", codeChallengeMethod: "S256", redirectUri: "http://127.0.0.1:1/cb", state: "s" }}
        onCopy={noop}
      />,
    );
    expect(html).toContain("within 5 minutes");
    expect(html).toContain("gdpg_");
    expect(html).toContain("RedX wants to connect");
    expect(html).toContain("Read only");
    expect(html).toContain('data-testid="approve-request"');
  });
  it("asks for a workspace first when there is none", () => {
    const html = renderToStaticMarkup(<RedxConnections {...base} bindings={[]} workspaces={[]} />);
    expect(html).toContain("Create a workspace first");
    expect(html).not.toContain('data-testid="create-grant"');
  });
  it("styles use theme tokens only (dark default, light and system)", () => {
    const css = readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");
    const block = css.slice(css.indexOf("/* Connected apps (RedX)"));
    expect(block.length).toBeGreaterThan(100);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
