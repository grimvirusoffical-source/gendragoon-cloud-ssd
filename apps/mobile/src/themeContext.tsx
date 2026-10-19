import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import * as SecureStore from "expo-secure-store";
import { DEFAULT_THEME_PREFERENCE, resolveTheme, type ThemeName, type ThemePreference } from "@gendragoon/ui/theme";
import { palettes, type MobileColors } from "./theme";

const KEY = "gendragoon.theme";

export interface ThemeValue {
  preference: ThemePreference;
  scheme: ThemeName;
  colors: MobileColors;
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeValue>({
  preference: DEFAULT_THEME_PREFERENCE,
  scheme: "dark",
  colors: palettes.dark,
  setPreference: () => undefined,
});

function isPreference(value: unknown): value is ThemePreference {
  return value === "dark" || value === "light" || value === "system";
}

/**
 * Dark by default; Light and System (follow the OS, live) are saved. The saved value is the
 * only thing stored here: a theme name, nothing sensitive, so SecureStore is just the available key-value store.
 */
export function ThemeProvider(props: { children: ReactNode; initialPreference?: ThemePreference; persist?: boolean }) {
  const system = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>(props.initialPreference ?? DEFAULT_THEME_PREFERENCE);
  const persist = props.persist !== false;
  useEffect(() => {
    if (!persist) return;
    let live = true;
    SecureStore.getItemAsync(KEY).then((saved) => { if (live && isPreference(saved)) setPreferenceState(saved); }).catch(() => undefined);
    return () => { live = false; };
  }, [persist]);
  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    if (persist) void SecureStore.setItemAsync(KEY, next).catch(() => undefined);
  }, [persist]);
  const scheme = resolveTheme(preference, system === "light");
  const value = useMemo<ThemeValue>(() => ({ preference, scheme, colors: palettes[scheme], setPreference }), [preference, scheme, setPreference]);
  return <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}

/** Build a StyleSheet from the active palette. `factory` must be a stable module-level function. */
export function useStyles<T>(factory: (colors: MobileColors) => T): T {
  const { colors } = useTheme();
  return useMemo(() => factory(colors), [factory, colors]);
}
