import { colors, radii, space, tapTarget, type as typeScale } from "@gendragoon/ui/theme";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type PressableProps, type StyleProp, type ViewStyle } from "react-native";

export function Screen(props: { children: ReactNode; testID?: string }) {
  return (
    <View style={styles.screen} testID={props.testID}>
      {props.children}
    </View>
  );
}

export function Title(props: { kicker?: string; children: string }) {
  return (
    <View style={styles.titleBlock}>
      {props.kicker ? <Text style={styles.kicker}>{props.kicker}</Text> : null}
      <Text style={styles.title} accessibilityRole="header">{props.children}</Text>
    </View>
  );
}

export function Button(props: {
  label: string;
  onPress: () => void;
  testID?: string;
  tone?: "primary" | "danger" | "ghost";
  disabled?: boolean;
  accessibilityLabel?: string;
} & Pick<PressableProps, "accessibilityHint">) {
  const tone = props.tone ?? "primary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      testID={props.testID}
      style={({ pressed }) => [
        styles.button,
        tone === "danger" ? styles.danger : tone === "ghost" ? styles.ghost : styles.primary,
        props.disabled ? styles.disabled : null,
        pressed && !props.disabled ? styles.pressed : null,
      ]}
    >
      <Text style={tone === "ghost" ? styles.ghostText : tone === "danger" ? styles.dangerText : styles.buttonText}>{props.label}</Text>
    </Pressable>
  );
}

export function Banner(props: { children: string; testID?: string }) {
  return (
    <View accessibilityRole="alert" style={styles.banner} testID={props.testID}>
      <Text style={styles.bannerText}>{props.children}</Text>
    </View>
  );
}

export function cardStyle(extra?: StyleProp<ViewStyle>): StyleProp<ViewStyle> {
  return [styles.card, extra];
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: space.xl,
    gap: space.lg,
  },
  titleBlock: { gap: space.xs },
  kicker: {
    color: colors.kicker,
    fontSize: typeScale.kickerSize,
    letterSpacing: typeScale.kickerSpacing,
    textTransform: "uppercase",
  },
  title: {
    color: colors.text,
    fontSize: typeScale.titleSize,
    letterSpacing: typeScale.titleSpacing,
  },
  button: {
    minHeight: tapTarget,
    minWidth: tapTarget,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  primary: { backgroundColor: colors.purple },
  danger: { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.dangerBorder },
  ghost: { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.ghostBorder },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.85 },
  buttonText: { color: colors.white, fontSize: typeScale.bodySize },
  dangerText: { color: colors.dangerText, fontSize: typeScale.bodySize },
  ghostText: { color: colors.text, fontSize: typeScale.bodySize },
  banner: {
    backgroundColor: "rgba(255, 176, 32, 0.08)",
    borderWidth: 1,
    borderColor: colors.bannerBorder,
    borderRadius: radii.md,
    padding: space.md,
  },
  bannerText: { color: colors.bannerText, fontSize: typeScale.helpSize },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: space.md,
    gap: space.sm,
  },
});
