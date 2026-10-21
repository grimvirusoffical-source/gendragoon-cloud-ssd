import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { INITIAL_CUSTOM_STORAGE } from "@gendragoon/core";
import { NewWorkspace } from "../src/NewWorkspace.js";
import { CustomStorageWizard } from "../src/CustomStorageWizard.js";

const pricing = {
  storage: { "100GB": { gb: 100, monthlyCents: 640, yearlyCents: 6400 }, "2TB": { gb: 2000, monthlyCents: 7200, yearlyCents: 72000 } },
  performance: { boost: { workers: 4, monthlyCents: 600, yearlyCents: 6000 }, lite: { workers: 2, monthlyCents: 300, yearlyCents: 3000 } },
};
const noop = () => {};

describe("NewWorkspace", () => {
  it("first workspace: free, no pickers, no checkout", () => {
    const html = renderToStaticMarkup(<NewWorkspace freeProjectAvailable pricing={pricing} intentId="i" onSubmit={noop} />);
    expect(html).toContain("2 GB storage and the free performance plan");
    expect(html).not.toContain('data-testid="storage-plans"');
    expect(html).not.toContain('data-testid="performance-plans"');
    expect(html).toContain("Create free workspace");
  });
  it("additional workspace: one storage picker and one performance picker, total with no fee line", () => {
    const html = renderToStaticMarkup(<NewWorkspace freeProjectAvailable={false} pricing={pricing} intentId="i" onSubmit={noop} initial={{ name: "Studio", storageTier: "100GB", performanceTier: "boost" }} />);
    expect(html.match(/data-testid="storage-plans"/g)).toHaveLength(1);
    expect(html.match(/data-testid="performance-plans"/g)).toHaveLength(1);
    expect(html).toContain("100GB storage plan");
    expect(html).toContain("Boost performance plan");
    expect(html).toContain("$12.40/mo");
    expect(html).not.toMatch(/fee/i);
    expect(html).not.toContain("$5");
    expect(html).not.toMatch(/bundle/i);
    expect(html).toContain("Continue to checkout");
  });
  it("disables checkout until both plans are picked", () => {
    const html = renderToStaticMarkup(<NewWorkspace freeProjectAvailable={false} pricing={pricing} intentId="i" onSubmit={noop} initial={{ name: "Studio", storageTier: "100GB" }} />);
    expect(html).toMatch(/data-testid="create-workspace" disabled=""/);
  });
  it("custom storage: no storage picker, performance required, even when the free slot is open", () => {
    const html = renderToStaticMarkup(<NewWorkspace freeProjectAvailable pricing={pricing} intentId="i" onSubmit={noop} initial={{ name: "Own S3", storage: "custom", performanceTier: "lite" }} />);
    expect(html).not.toContain('data-testid="storage-plans"');
    expect(html).toContain('data-testid="performance-plans"');
    expect(html).toContain("Lite performance plan");
    expect(html).toContain("$3.00/mo");
    expect(html).not.toContain("first-free");
  });
});

describe("CustomStorageWizard", () => {
  it("shows the four steps with the current one marked", () => {
    const html = renderToStaticMarkup(<CustomStorageWizard workspaceName="Own S3" onTest={async () => {}} />);
    for (const step of ["provider", "credentials", "test", "finish"]) expect(html).toContain(`data-testid="step-${step}"`);
    expect(html).toMatch(/class="step current" aria-current="step" data-testid="step-provider"/);
    expect(html).toContain('data-testid="provider-r2"');
  });
  it("credentials step keeps keys on the device", () => {
    const html = renderToStaticMarkup(<CustomStorageWizard workspaceName="Own S3" onTest={async () => {}} initialState={{ ...INITIAL_CUSTOM_STORAGE, step: "credentials", provider: "r2" }} />);
    expect(html).toContain("Keys stay on this device");
    expect(html).toContain('type="password"');
  });
  it("test and finish steps", () => {
    const test = renderToStaticMarkup(<CustomStorageWizard workspaceName="Own S3" onTest={async () => {}} initialState={{ ...INITIAL_CUSTOM_STORAGE, step: "test", provider: "r2", endpoint: "https://a.r2.cloudflarestorage.com", bucket: "library", hasCredentials: true }} />);
    expect(test).toContain("Test connection");
    expect(test).toContain("library");
    const done = renderToStaticMarkup(<CustomStorageWizard workspaceName="Own S3" onTest={async () => {}} initialState={{ ...INITIAL_CUSTOM_STORAGE, step: "finish", provider: "r2" }} />);
    expect(done).toContain("Connected.");
    expect(done).toMatch(/class="step done"/);
  });
});

describe("theme", () => {
  it("plan and wizard styles use tokens only and respect reduced motion", () => {
    const css = readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");
    const block = css.slice(css.indexOf("/* New workspace"));
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
    expect(block).toContain("prefers-reduced-motion");
  });
});
