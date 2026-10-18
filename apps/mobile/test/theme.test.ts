import { colors, contrastRatio, tapTarget } from "../src/theme";

describe("mobile theme", () => {
  const pairs: [string, string, string][] = [
    ["text on bg", colors.text, colors.bg],
    ["text on surface", colors.text, colors.surface],
    ["muted on bg", colors.muted, colors.bg],
    ["muted on surface", colors.muted, colors.surface],
    ["muted on raised", colors.muted, colors.surfaceRaised],
    ["primary label", colors.primaryText, colors.primary],
    ["secondary label on surface", colors.secondaryText, colors.surface],
    ["danger label on surface", colors.dangerText, colors.surface],
    ["warn text on surface", colors.warnText, colors.surface],
    ["info text on surface", colors.infoText, colors.surface],
  ];
  it.each(pairs)("%s meets AA 4.5:1", (_name, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
  it("touch targets are at least 44pt", () => {
    expect(tapTarget).toBeGreaterThanOrEqual(44);
  });
});
