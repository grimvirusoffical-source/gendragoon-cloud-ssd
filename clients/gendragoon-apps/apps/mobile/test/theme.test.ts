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
    ["input placeholder on input", colors.muted, colors.input],
  ];
  it.each(pairs)("%s meets AA 4.5:1", (_name, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
  // WCAG 1.4.11 non-text contrast: a control outline needs 3:1 against what it sits on.
  const borders: [string, string, string][] = [
    ["control border on bg", colors.controlBorder, colors.bg],
    ["control border on surface", colors.controlBorder, colors.surface],
    ["control border on raised", colors.controlBorder, colors.surfaceRaised],
    ["control border on input", colors.controlBorder, colors.input],
    ["selected choice border on surface", colors.focus, colors.surface],
  ];
  it.each(borders)("%s meets 3:1", (_name, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(3);
  });
  it("touch target token is at least 44pt", () => {
    expect(tapTarget).toBeGreaterThanOrEqual(44);
  });
});
