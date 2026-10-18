import { fireEvent, render } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { WorkspacesScreen } from "../src/screens";
import { colors, contrastRatio } from "../src/theme";

const A = { id: "11111111-1111-4111-8111-00000000000a", name: "Alpha", kind: "paid" as const, projectStatus: "active" as const };
const B = { id: "11111111-1111-4111-8111-00000000000b", name: "Beta", kind: "paid" as const, projectStatus: "active" as const };

function screenWith(workspaces: (typeof A)[], onMerge = jest.fn()) {
  return render(<WorkspacesScreen workspaces={workspaces} unpaidIds={[]} onDelete={() => undefined} onMerge={onMerge} />);
}

function flatStyle(node: { props: { style?: unknown } }) {
  const style = node.props.style;
  return StyleSheet.flatten(typeof style === "function" ? style({ pressed: false }) : style) ?? {};
}

describe("merge workspaces UI", () => {
  it("hides the whole merge section with fewer than 2 workspaces", async () => {
    const one = await screenWith([A]);
    expect(one.queryByText("Merge workspaces")).toBeNull();
    expect(one.queryByTestId("merge-source")).toBeNull();
    expect(one.queryByTestId("merge-target")).toBeNull();
    expect(one.queryByTestId("merge-workspaces")).toBeNull();
    const none = await screenWith([]);
    expect(none.queryByTestId("merge-workspaces")).toBeNull();
    const two = await screenWith([A, B]);
    expect(two.getByTestId("merge-workspaces")).toBeTruthy();
  });

  it("disables the source workspace in the target picker so they never match", async () => {
    const onMerge = jest.fn();
    const screen = await screenWith([A, B], onMerge);
    expect(screen.getByTestId(`merge-target-${A.id}`).props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId(`merge-target-${B.id}`).props.accessibilityState.disabled).toBe(false);
    // Choosing the current target as source moves the target off it.
    await fireEvent.press(screen.getByTestId(`merge-source-${B.id}`));
    expect(screen.getByTestId(`merge-target-${B.id}`).props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId(`merge-target-${A.id}`).props.accessibilityState.checked).toBe(true);
    await fireEvent.press(screen.getByTestId(`merge-target-${B.id}`));
    await fireEvent.press(screen.getByTestId("merge-workspaces"));
    expect(onMerge).toHaveBeenCalledWith(B.id, A.id);
  });

  it("a disabled Merge button reads as disabled with AA text", async () => {
    const screen = await screenWith([A, { ...B, projectStatus: "deleting" as never }]);
    const merge = screen.getByTestId("merge-workspaces");
    expect(merge.props.accessibilityState.disabled).toBe(true);
    const style = flatStyle(merge);
    expect(style.backgroundColor).toBe(colors.surfaceRaised);
    expect(style.opacity).toBeUndefined();
    const label = screen.getByText("Merge");
    expect(StyleSheet.flatten(label.props.style).color).toBe(colors.muted);
    expect(contrastRatio(colors.muted, colors.surfaceRaised)).toBeGreaterThanOrEqual(4.5);
  });
});
