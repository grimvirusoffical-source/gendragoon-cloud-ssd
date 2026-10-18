import { supportContactTarget } from "../src/support";

describe("support contact target", () => {
  it("mails an email address with the deletion job in the subject", () => {
    expect(supportContactTarget("help@example.com", "job-4")).toBe(
      "mailto:help@example.com?subject=Account%20deletion%20job-4",
    );
  });

  it("opens a URL unchanged", () => {
    expect(supportContactTarget("https://support.example.test/account", "job-4")).toBe(
      "https://support.example.test/account",
    );
  });
});