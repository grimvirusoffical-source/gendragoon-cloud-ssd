import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";
import { SettingsHome } from "../src/screens";
import { contrastRatio, palettes } from "../src/theme";
import { ThemeProvider, useTheme } from "../src/themeContext";

const TEXT: [keyof typeof palettes.dark, keyof typeof palettes.dark][] = [
  ["text", "bg"], ["text", "surface"], ["muted", "bg"], ["muted", "surface"], ["muted", "surfaceRaised"], ["primaryText", "primary"],
  ["secondaryText", "surface"], ["dangerText", "surface"], ["warnText", "bg"], ["infoText", "surface"], ["kicker", "bg"],
];
const UI: [keyof typeof palettes.dark, keyof typeof palettes.dark][] = [["controlBorder", "bg"], ["controlBorder", "surface"], ["focus", "bg"], ["focus", "surface"], ["secondaryBorder", "surface"]];

describe.each(["dark", "light"] as const)("mobile %s palette WCAG AA", (name) => {
  it.each(TEXT)("%s on %s >= 4.5", (fg, bg) => expect(contrastRatio(palettes[name][fg], palettes[name][bg])).toBeGreaterThanOrEqual(4.5));
  it.each(UI)("%s on %s >= 3", (fg, bg) => expect(contrastRatio(palettes[name][fg], palettes[name][bg])).toBeGreaterThanOrEqual(3));
});

function Probe() {
  const { scheme, preference } = useTheme();
  return <Text testID="probe">{`${preference}/${scheme}`}</Text>;
}

describe("ThemeProvider and picker", () => {
  it("defaults to dark", async () => {
    const s = await render(<ThemeProvider persist={false}><Probe /></ThemeProvider>);
    await waitFor(() => expect(s.getByTestId("probe").props.children).toBe("dark/dark"));
  });
  it("Settings has Dark/Light/System and switching applies at once", async () => {
    const s = await render(
      <ThemeProvider persist={false}>
        <Probe />
        <SettingsHome deleteDisabled={false} onSort={() => undefined} onDelete={() => undefined} onSignOut={() => undefined} />
      </ThemeProvider>,
    );
    fireEvent.press(s.getByTestId("theme-light"));
    await waitFor(() => expect(s.getByTestId("probe").props.children).toBe("light/light"));
    fireEvent.press(s.getByTestId("theme-dark"));
    await waitFor(() => expect(s.getByTestId("probe").props.children).toBe("dark/dark"));
    fireEvent.press(s.getByTestId("theme-system"));
    // System follows whatever the OS reports (Jest reports light).
    await waitFor(() => expect(s.getByTestId("probe").props.children).toMatch(/^system\/(dark|light)$/));
  });
});
