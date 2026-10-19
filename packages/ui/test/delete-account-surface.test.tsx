import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ABOUT_OWNERSHIP,
  GenDragoonClient,
  MemorySecretStore,
  SUPPORT_CONTACT,
  resumeAccountDeletion,
  workspaceKeyId,
  type Settings,
} from "@gendragoon/core";
import { loadServerFixture } from "../../core/test/fixtures/server/load.js";
import { SettingsView, deletionFailureNotice } from "../src/SettingsView.js";

const settings: Settings = { schema: 1, sortOverrides: { extensions: {}, mimeTypes: {} } };

function view(extra: Partial<Parameters<typeof SettingsView>[0]> = {}) {
  return renderToStaticMarkup(
    <SettingsView
      settings={settings}
      rows={[]}
      onChange={() => undefined}
      onDeleteAccount={() => undefined}
      {...extra}
    />,
  );
}

describe("SettingsView deletion notice", () => {
  it("offers Retry when a failed deletion is retryable", () => {
    const html = view({ deletionMessage: "Account deletion failed. You can retry it.", deletionRetryable: true });
    expect(html).toContain("delete-account-retry");
    expect(html).toContain("delete-account-dismiss");
    expect(html).not.toContain("delete-account-support");
  });

  it("shows the support contact and Dismiss when deletion cannot be retried", () => {
    const html = view({
      deletionMessage: "Account deletion cannot be retried.",
      deletionRetryable: false,
      supportContact: "support@infected-nation.com",
    });
    expect(html).toContain("support@infected-nation.com");
    expect(html).toContain("delete-account-dismiss");
    expect(html).not.toContain("delete-account-retry");
  });

  it("status-failed-not-retryable keeps the job, wipes nothing, and shows support plus Dismiss", async () => {
    const fixture = loadServerFixture("account-deletion", "status-failed-not-retryable");
    const body = fixture.response.body as { jobId: string; status: string; retryable: boolean };
    expect(fixture.response.status).toBe(200);
    expect(body).toMatchObject({ status: "failed", retryable: false });
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("w1"), new Uint8Array([7]));
    const secureStore = new MemorySecretStore();
    const encoder = new TextEncoder();
    await secureStore.set("account-deletion:job-id", encoder.encode(body.jobId));
    await secureStore.set("account-deletion:status-token", encoder.encode("<redacted>"));
    let gets = 0;
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => {
        throw new Error("firebase token should stay unused");
      },
      fetch: async (input, init) => {
        gets += 1;
        expect(init?.method ?? "GET").toBe("GET");
        expect(String(input)).toBe(`https://api.example.test${fixture.request.path}`);
        return new Response(JSON.stringify(fixture.response.body), {
          status: fixture.response.status,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const result = await resumeAccountDeletion({
      client,
      workspaceIds: ["w1"],
      secrets,
      secureStore,
      sleep: async () => {
        throw new Error("polling continued");
      },
    });
    expect(gets).toBe(1);
    expect(result).toMatchObject({ status: "failed", retryable: false, jobId: body.jobId });
    expect(await secrets.get(workspaceKeyId("w1"))).not.toBeNull();
    expect(new TextDecoder().decode(await secureStore.get("account-deletion:job-id"))).toBe(body.jobId);
    expect(new TextDecoder().decode(await secureStore.get("account-deletion:status-token"))).toBe("<redacted>");
    const notice = deletionFailureNotice(result!);
    const html = view({
      deletionMessage: notice?.message,
      deletionRetryable: notice?.retryable,
      supportContact: notice?.supportContact,
    });
    expect(html).toContain(SUPPORT_CONTACT.value);
    expect(html).toContain("delete-account-support");
    expect(html).toContain("delete-account-dismiss");
    expect(html).not.toContain("delete-account-retry");
  });
});

describe("Settings About", () => {
  it("shows the exact ownership copy", () => {
    const html = view();
    expect(html).toContain('data-testid="about-panel"');
    expect(html).toContain(ABOUT_OWNERSHIP.replace("©", "©"));
  });
});
