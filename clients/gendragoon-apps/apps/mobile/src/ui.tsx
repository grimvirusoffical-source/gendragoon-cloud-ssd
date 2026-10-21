import { useId, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import { radii, space, tapTarget, type as typeScale, type MobileColors } from "./theme";
import { useStyles, useTheme } from "./themeContext";

export function Screen(props: { children: ReactNode; testID?: string }) {
  const styles = useStyles(makeStyles);
  return (
    <ScrollView
      style={styles.screenScroll}
      contentContainerStyle={styles.screen}
      testID={props.testID}
      keyboardShouldPersistTaps="handled"
    >
      {props.children}
    </ScrollView>
  );
}

export function Title(props: { kicker?: string; children: string; subtitle?: string }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.titleBlock}>
      {props.kicker ? <Text style={styles.kicker}>{props.kicker}</Text> : null}
      <Text style={styles.title} accessibilityRole="header">{props.children}</Text>
      {props.subtitle ? <Text style={styles.subtitle}>{props.subtitle}</Text> : null}
    </View>
  );
}

export type ButtonTone = "primary" | "secondary" | "ghost" | "danger";

/**
 * One button for every screen.
 * - primary: solid purple, one per screen for the main action.
 * - secondary: tinted purple outline for alternate actions and choices.
 * - ghost: quiet outline for low-emphasis actions.
 * - danger: soft rose tint with outline. Never a solid red slab.
 */
export function Button(props: {
  label: string;
  onPress: () => void;
  testID?: string;
  tone?: ButtonTone;
  disabled?: boolean;
  accessibilityLabel?: string;
  /** Shrinks the control to its label so a destructive action is not full width. */
  compact?: boolean;
  /** Ghost text in the danger color for a low-emphasis destructive action. */
  destructive?: boolean;
  /** Renders as a selected choice (radio) instead of a plain button. */
  selected?: boolean;
} & Pick<PressableProps, "accessibilityHint">) {
  const styles = useStyles(makeStyles);
  const tone = props.tone ?? "primary";
  const isChoice = typeof props.selected === "boolean";
  const textStyle = props.disabled
    ? styles.disabledText
    : props.destructive || tone === "danger"
    ? styles.dangerText
    : tone === "primary"
      ? styles.primaryText
      : tone === "secondary"
        ? styles.secondaryText
        : styles.ghostText;
  return (
    <Pressable
      accessibilityRole={isChoice ? "radio" : "button"}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={isChoice ? { disabled: props.disabled === true, checked: props.selected } : { disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      testID={props.testID}
      hitSlop={4}
      style={({ pressed }) => [
        styles.button,
        tone === "danger" ? styles.danger : tone === "ghost" ? styles.ghost : tone === "secondary" ? styles.secondary : styles.primary,
        props.compact ? styles.compact : null,
        props.selected === true && !props.disabled ? styles.selectedChoice : null,
        props.disabled ? styles.disabled : null,
        pressed && !props.disabled ? (tone === "primary" ? styles.primaryPressed : styles.pressed) : null,
      ]}
    >
      <Text style={textStyle}>{props.label}</Text>
    </Pressable>
  );
}

export type BannerTone = "warn" | "info" | "danger";

/**
 * `alert` is for real errors the user has to act on now and is announced
 * assertively. Every other banner (payment due, grace, info) is a polite live
 * region so it does not interrupt. A danger banner is always an alert.
 */
export function Banner(props: { children: ReactNode; testID?: string; tone?: BannerTone; action?: ReactNode; alert?: boolean }) {
  const styles = useStyles(makeStyles);
  const tone = props.tone ?? "warn";
  const urgent = props.alert === true || tone === "danger";
  return (
    <View
      accessibilityRole={urgent ? "alert" : undefined}
      accessibilityLiveRegion={urgent ? "assertive" : "polite"}
      style={[styles.banner, tone === "info" ? styles.bannerInfo : tone === "danger" ? styles.bannerDanger : styles.bannerWarn]}
      testID={props.testID}
    >
      <Text style={tone === "info" ? styles.bannerInfoText : tone === "danger" ? styles.dangerText : styles.bannerText}>{props.children}</Text>
      {props.action ? <View style={styles.bannerAction}>{props.action}</View> : null}
    </View>
  );
}

/** Labelled text input with helper text tied to it for screen readers. */
export function Field(props: {
  label: string;
  helper?: string;
  error?: string | null;
  testID?: string;
  helperTestID?: string;
} & Pick<TextInputProps, "value" | "onChangeText" | "secureTextEntry" | "placeholder" | "autoCapitalize" | "autoComplete" | "textContentType">) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const hint = props.error ?? props.helper;
  const generatedId = useId();
  const labelId = props.testID ? `${props.testID}-label` : `field-${generatedId}-label`;
  return (
    <View style={styles.field}>
      <Text style={styles.label} nativeID={labelId}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        accessibilityLabelledBy={labelId}
        accessibilityHint={hint ?? undefined}
        placeholder={props.placeholder ?? props.label}
        placeholderTextColor={colors.muted}
        secureTextEntry={props.secureTextEntry}
        autoCapitalize={props.autoCapitalize}
        autoComplete={props.autoComplete}
        textContentType={props.textContentType}
        style={[styles.input, props.error ? styles.inputError : null]}
        value={props.value}
        onChangeText={props.onChangeText}
        testID={props.testID}
      />
      {props.error ? (
        <Text
          testID={props.testID ? `${props.testID}-error` : undefined}
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          style={styles.fieldError}
        >
          {props.error}
        </Text>
      ) : null}
      {props.helper ? <Text testID={props.helperTestID} style={styles.helper}>{props.helper}</Text> : null}
    </View>
  );
}

/** Running server operation, e.g. a merge. Announced politely, with a spinner. */
export function ProgressCard(props: { title: string; detail?: string; testID?: string; detailTestID?: string }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View
      style={[styles.card, styles.progressCard]}
      testID={props.testID}
      accessibilityRole="progressbar"
      accessibilityLabel={props.detail ? `${props.title}. ${props.detail}` : props.title}
      accessibilityLiveRegion="polite"
      accessibilityState={{ busy: true }}
    >
      <ActivityIndicator color={colors.focus} />
      <View style={styles.progressText}>
        <Text style={styles.progressTitle}>{props.title}</Text>
        {props.detail ? <Text testID={props.detailTestID} style={styles.helper}>{props.detail}</Text> : null}
      </View>
    </View>
  );
}

export function SectionLabel(props: { children: string }) {
  const styles = useStyles(makeStyles);
  return <Text style={styles.label} accessibilityRole="header">{props.children}</Text>;
}

/** Card style for the active theme. */
export function useCardStyle(): (extra?: StyleProp<ViewStyle>) => StyleProp<ViewStyle> {
  const styles = useStyles(makeStyles);
  return (extra) => [styles.card, extra];
}

const makeStyles = (colors: MobileColors) => StyleSheet.create({
  screenScroll: { flex: 1, backgroundColor: colors.bg },
  screen: {
    flexGrow: 1,
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
    fontWeight: "600",
  },
  title: {
    color: colors.text,
    fontSize: typeScale.titleSize,
    letterSpacing: typeScale.titleSpacing,
    fontWeight: typeScale.titleWeight,
  },
  subtitle: { color: colors.muted, fontSize: typeScale.helpSize },
  button: {
    minHeight: tapTarget,
    minWidth: tapTarget,
    borderRadius: radii.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  primary: { backgroundColor: colors.primary, borderColor: colors.primary },
  primaryPressed: { backgroundColor: colors.primaryPressed, borderColor: colors.primaryPressed },
  secondary: { backgroundColor: colors.secondaryBg, borderColor: colors.secondaryBorder },
  danger: { backgroundColor: colors.dangerBg, borderColor: colors.dangerBorder },
  ghost: { backgroundColor: "transparent", borderColor: colors.controlBorder },
  /** A selected choice must stand out from the now-brighter ghost outline of its siblings. */
  selectedChoice: { borderColor: colors.focus, borderWidth: 2 },
  /** Muted surface + muted text instead of opacity, so the label keeps AA contrast. */
  disabled: { backgroundColor: colors.surfaceRaised, borderColor: colors.border },
  disabledText: { color: colors.muted, fontSize: typeScale.bodySize, fontWeight: typeScale.buttonWeight },
  pressed: { opacity: 0.8 },
  primaryText: { color: colors.primaryText, fontSize: typeScale.bodySize, fontWeight: typeScale.buttonWeight },
  secondaryText: { color: colors.secondaryText, fontSize: typeScale.bodySize, fontWeight: typeScale.buttonWeight },
  dangerText: { color: colors.dangerText, fontSize: typeScale.bodySize, fontWeight: typeScale.buttonWeight },
  ghostText: { color: colors.text, fontSize: typeScale.bodySize },
  compact: { alignSelf: "flex-start", minWidth: tapTarget, paddingHorizontal: space.md },
  banner: { borderWidth: 1, borderRadius: radii.md, padding: space.md, gap: space.sm },
  bannerWarn: { backgroundColor: colors.warnBg, borderColor: colors.warnBorder },
  bannerInfo: { backgroundColor: colors.infoBg, borderColor: colors.infoBorder },
  bannerDanger: { backgroundColor: colors.dangerBg, borderColor: colors.dangerBorder },
  bannerText: { color: colors.warnText, fontSize: typeScale.helpSize },
  bannerInfoText: { color: colors.infoText, fontSize: typeScale.helpSize },
  bannerAction: { flexDirection: "row" },
  field: { gap: space.xs },
  label: { color: colors.text, fontSize: typeScale.labelSize, fontWeight: typeScale.labelWeight },
  helper: { color: colors.muted, fontSize: typeScale.helpSize },
  input: {
    minHeight: tapTarget,
    borderWidth: 1,
    borderColor: colors.controlBorder,
    borderRadius: radii.md,
    color: colors.text,
    fontSize: typeScale.bodySize,
    paddingHorizontal: space.md,
    backgroundColor: colors.input,
  },
  inputError: { borderColor: colors.dangerBorder },
  fieldError: { color: colors.dangerText, fontSize: typeScale.helpSize },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: space.md,
    gap: space.sm,
  },
  progressCard: { flexDirection: "row", alignItems: "center", gap: space.md, borderColor: colors.infoBorder },
  progressText: { flex: 1, gap: space.xs },
  progressTitle: { color: colors.text, fontSize: typeScale.bodySize, fontWeight: "600" },
});
