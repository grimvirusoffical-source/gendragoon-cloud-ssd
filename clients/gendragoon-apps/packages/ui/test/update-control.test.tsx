import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UpdateControl, isUpdateBusy, updateLabel, type UpdateView } from "../src/UpdateControl.js";

const html = (state: UpdateView) => renderToStaticMarkup(<UpdateControl state={state} currentVersion="0.1.0" onCheck={() => undefined} />);

describe("UpdateControl states", () => {
  it("idle: shows the version and an enabled button", () => {
    const out = html({ status: "idle" });
    expect(out).toContain("Version 0.1.0");
    expect(out).toContain("Check for updates");
    expect(out).not.toMatch(/data-testid="update-check"[^>]*disabled/);
  });
  it("checking: disabled, busy, says checking", () => {
    const out = html({ status: "checking" });
    expect(out).toContain("Checking for updates");
    expect(out).toMatch(/disabled/);
    expect(out).toContain('aria-busy="true"');
  });
  it("up to date", () => {
    expect(html({ status: "up_to_date", currentVersion: "0.1.0" })).toContain("You&#x27;re up to date (version 0.1.0)");
  });
  it("downloading: determinate progress bar with percent", () => {
    const out = html({ status: "downloading", version: "0.2.0", percent: 42 });
    expect(out).toContain("Downloading 0.2.0: 42%");
    expect(out).toContain('aria-valuenow="42"');
    expect(out).toContain("scaleX(0.42)");
  });
  it("downloading with unknown size: indeterminate", () => {
    expect(html({ status: "downloading", version: "0.2.0", percent: null })).toContain("indeterminate");
  });
  it("verifying, ready, installing, relaunching are busy states", () => {
    for (const status of ["verifying", "ready", "installing", "relaunching"] as const) {
      expect(isUpdateBusy({ status, version: "0.2.0" })).toBe(true);
    }
    expect(updateLabel({ status: "relaunching", version: "0.2.0" })).toMatch(/restart by itself/);
  });
  it("deferred explains the wait and is not busy-locked", () => {
    expect(isUpdateBusy({ status: "deferred", version: "0.2.0" })).toBe(false);
    expect(html({ status: "deferred", version: "0.2.0" })).toContain("installs when your upload or backup finishes");
  });
  it("error: alert role, message and Try again", () => {
    const out = html({ status: "error", message: "Could not check for updates." });
    expect(out).toContain('role="alert"');
    expect(out).toContain("Try again");
  });
  it("available with a url (non-Windows) offers a manual download link", () => {
    expect(html({ status: "available", version: "0.2.0", url: "https://example.test/a.exe" })).toContain("Download version 0.2.0");
  });
});

describe("UpdateControl per distribution", () => {
  const render = (ui: "full" | "managed" | "hidden", note?: string) =>
    renderToStaticMarkup(<UpdateControl state={{ status: "idle" }} onCheck={() => undefined} ui={ui} note={note} />);
  it("full (direct build): shows the check button", () => {
    expect(render("full")).toContain('data-testid="update-check"');
  });
  it("managed (Rotten Apple): note only, no button", () => {
    const out = render("managed", "Updates are handled by the Rotten Apple launcher.");
    expect(out).toContain("Rotten Apple launcher");
    expect(out).not.toContain("update-check");
  });
  it("hidden (Mac App Store): renders nothing", () => {
    expect(render("hidden")).toBe("");
  });
});
