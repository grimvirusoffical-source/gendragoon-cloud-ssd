import { fireEvent, render } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { WorkspacesScreen, type ListedWorkspace, type ServerMergeResult } from "../src/screens";
import { colors, contrastRatio } from "../src/theme";

const A: ListedWorkspace = { id: "11111111-1111-4111-8111-00000000000a", name: "Alpha", kind: "paid", projectStatus: "active" };
const B: ListedWorkspace = { id: "11111111-1111-4111-8111-00000000000b", name: "Beta", kind: "paid", projectStatus: "active" };
/** Typed fixture for a workspace the server is deleting. */
const B_DELETING: ListedWorkspace = { ...B, projectStatus: "deleting" };

function screenWith(workspaces: ListedWorkspace[], onMerge = jest.fn(), extra: Partial<Parameters<typeof WorkspacesScreen>[0]> = {}) {
  return render(<WorkspacesScreen workspaces={workspaces} unpaidIds={[]} onDelete={() => undefined} onMerge={onMerge} {...extra} />);
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
    const screen = await screenWith([A, B_DELETING]);
    const merge = screen.getByTestId("merge-workspaces");
    expect(merge.props.accessibilityState.disabled).toBe(true);
    const style = flatStyle(merge);
    expect(style.backgroundColor).toBe(colors.surfaceRaised);
    expect(style.opacity).toBeUndefined();
    const label = screen.getByText("Merge");
    expect(StyleSheet.flatten(label.props.style).color).toBe(colors.muted);
    expect(contrastRatio(colors.muted, colors.surfaceRaised)).toBeGreaterThanOrEqual(4.5);
  });

  it("a merge result still shows when only one workspace is left, with no pickers", async () => {
    const screen = await screenWith([B], jest.fn(), {
      mergeResult: { merged: true, copied: 3, sourceId: A.id, workspaceId: B.id, sourceDeleted: true } satisfies ServerMergeResult,
      mergedFiles: [{ id: "f1", name: "Trip/IMG_0412.HEIC" }],
    });
    expect(screen.getByText("Merge workspaces")).toBeTruthy();
    expect(screen.getByTestId("merge-result")).toHaveTextContent(`Merged 3 into ${B.id}. Source deleted.`);
    expect(screen.getByTestId("merged-file-f1")).toHaveTextContent("Trip/IMG_0412.HEIC");
    expect(screen.queryByTestId("merge-source")).toBeNull();
    expect(screen.queryByTestId("merge-workspaces")).toBeNull();
  });
});
