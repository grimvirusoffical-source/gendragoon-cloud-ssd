import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsView } from "../src/SettingsView.js";
import type { Settings } from "@gendragoon/core";

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
      supportContact: "placeholder@example.com",
    });
    expect(html).toContain("placeholder@example.com");
    expect(html).toContain("delete-account-dismiss");
    expect(html).not.toContain("delete-account-retry");
  });
});
