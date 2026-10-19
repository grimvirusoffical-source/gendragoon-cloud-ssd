/**
 * Platform-neutral theme tokens for the dark-purple GenDragoon shell.
 * Desktop CSS in theme.css mirrors these values. React Native reads this
 * module and does not import the DOM components.
 */

export const colors = {
  bg: "#100e17",
  sidebar: "#17141f",
  sidebarLine: "#2a2538",
  card: "#1c1828",
  cardBorder: "#322c44",
  text: "#f6f3fb",
  muted: "#9c96ae",
  faint: "#6f6980",
  purple: "#7c5cff",
  purpleHot: "#8d6bff",
  selected: "#6d4aff",
  soft: "rgba(124, 92, 255, 0.16)",
  line: "#2c2740",
  input: "#12101a",
  ok: "#3dd68c",
  warn: "#ffb020",
  danger: "#ff6d8f",
  nav: "#d9d4e6",
  kicker: "#c8b7ff",
  chip: "#ddd4ff",
  dangerText: "#ffd0dc",
  dangerBorder: "#6a3144",
  ghostBorder: "#4a4168",
  bannerBorder: "#5c4d22",
  bannerText: "#ffe3a3",
  preview: "#120f1b",
  white: "#ffffff",
  glow: "rgba(109, 74, 255, 0.18)",
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  xxl: 28,
} as const;

export const radii = {
  sm: 10,
  md: 12,
  lg: 16,
  pill: 999,
} as const;

/** Minimum tap target in points. */
export const tapTarget = 44;

export const type = {
  family: "System",
  brandSize: 13,
  brandSpacing: 1.04,
  kickerSize: 11,
  kickerSpacing: 1.54,
  titleSize: 28,
  titleSpacing: -0.8,
  bodySize: 14,
  helpSize: 13,
  chipSize: 12,
  metaSize: 11,
} as const;

export const shadow = {
  card: {
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.28,
    shadowRadius: 40,
    elevation: 8,
  },
  button: {
    shadowColor: "#6d4aff",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.28,
    shadowRadius: 18,
    elevation: 4,
  },
} as const;
