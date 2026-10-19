/**
 * Mobile theme tokens. Built on the shared `@gendragoon/ui/theme` palette and
 * extended with the roles mobile screens use. Every text/background pair below
 * is checked for WCAG AA (4.5:1 body, 3:1 large/UI) in test/theme.test.ts.
 */
import { colors as shared, radii as sharedRadii, shadow, space as sharedSpace, tapTarget, type as sharedType } from "@gendragoon/ui/theme";

export const colors = {
  ...shared,
  /** Screen and surface layers, darkest to lightest. */
  bg: "#100e17",
  surface: "#1c1828",
  surfaceRaised: "#241f34",
  border: "#3a3352",
  /**
   * Outline of an interactive control that has no fill of its own (unchecked
   * checkbox, ghost button). WCAG 1.4.11 needs 3:1 against the surface it sits
   * on: 4.2:1 on `bg`, 3.8:1 on `surface`, 3.5:1 on `surfaceRaised`.
   */
  controlBorder: "#7a6fa0",
  /** Text roles. `muted` is lifted from the shared value to clear AA on raised cards. */
  text: "#f6f3fb",
  muted: "#b3adc4",
  /** Brand purple. White label on `primary` is 5.15:1. */
  primary: "#6d4aff",
  primaryPressed: "#5a3ae0",
  primaryText: "#ffffff",
  /** Secondary: tinted purple outline. */
  secondaryBg: "rgba(124, 92, 255, 0.14)",
  /** 4.9:1 on `surface`, 5.4:1 on `bg` (WCAG 1.4.11 needs 3:1). */
  secondaryBorder: "#8c76ee",
  secondaryText: "#ddd4ff",
  /** Lighter destructive: soft rose tint and outline, not a solid red slab. */
  dangerBg: "rgba(255, 109, 143, 0.10)",
  /** Lighter rose outline: 4.0:1 on `surface`, 4.4:1 on `bg`. */
  dangerBorder: "#b0607f",
  dangerText: "#ffc2d1",
  /** Warning banner (payment due / grace). */
  warnBg: "rgba(255, 176, 32, 0.10)",
  warnBorder: "#6b5622",
  warnText: "#ffe3a3",
  /** Info / progress banner. */
  infoBg: "rgba(124, 92, 255, 0.12)",
  infoBorder: "#4a3d80",
  infoText: "#e4dcff",
  /** Focus ring and selected-choice outline: brighter than every resting outline. */
  focus: "#a58bff",
} as const;

export const space = { ...sharedSpace } as const;

export const radii = { ...sharedRadii } as const;

export const type = {
  ...sharedType,
  labelSize: 14,
  labelWeight: "600" as const,
  titleWeight: "700" as const,
  buttonWeight: "600" as const,
} as const;

/** Minimum touch target, points (Apple HIG / Material 48dp ≈ 44pt). */
export const touchTarget = tapTarget;

export { shadow, tapTarget };

/** Relative luminance contrast ratio for opaque #rrggbb colors. */
export function contrastRatio(fg: string, bg: string): number {
  const lum = (hex: string) => {
    const n = hex.replace("#", "");
    const [r, g, b] = [0, 2, 4].map((i) => {
      const c = parseInt(n.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a! + 0.05) / (b! + 0.05);
}
