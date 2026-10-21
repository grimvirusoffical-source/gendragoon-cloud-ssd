/** Avery's PR #3 nits: outline contrast on rendered buttons, Field error and label, Banner live regions. */
import { render } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { WorkspacesScreen, type ListedWorkspace } from "../src/screens";
import { colors, contrastRatio } from "../src/theme";
import { Banner, Button, Field } from "../src/ui";

type Node = { props: { style?: unknown } };
function flat(node: Node): Record<string, unknown> {
  const style = typeof node.props.style === "function" ? (node.props.style as (s: { pressed: boolean }) => unknown)({ pressed: false }) : node.props.style;
  return (StyleSheet.flatten(style as never) as Record<string, unknown> | undefined) ?? {};
}
const SURFACES: [string, string][] = [["bg", colors.bg], ["surface", colors.surface], ["surfaceRaised", colors.surfaceRaised]];

describe("button outlines are at least 3:1 on the screen and on cards (rendered)", () => {
  it.each([
    ["danger", <Button key="d" label="Delete" tone="danger" testID="b" onPress={() => undefined} />],
    ["secondary", <Button key="s" label="Contact" tone="secondary" testID="b" onPress={() => undefined} />],
    ["selected choice", <Button key="c" label="Alpha" tone="secondary" selected testID="b" onPress={() => undefined} />],
    ["unselected choice", <Button key="u" label="Beta" tone="ghost" selected={false} testID="b" onPress={() => undefined} />],
  ])("%s", async (_name, ui) => {
    const s = await render(ui);
    const border = String(flat(s.getByTestId("b")).borderColor);
    for (const [, bg] of SURFACES) expect(contrastRatio(border, bg)).toBeGreaterThanOrEqual(3);
  });

  it("a selected choice reads stronger than an unselected one (brighter and thicker outline)", async () => {
    const A: ListedWorkspace = { id: "11111111-1111-4111-8111-00000000000a", name: "Alpha", kind: "paid", projectStatus: "active" };
    const B: ListedWorkspace = { id: "11111111-1111-4111-8111-00000000000b", name: "Beta", kind: "paid", projectStatus: "active" };
    const s = await render(<WorkspacesScreen workspaces={[A, B]} unpaidIds={[]} onDelete={() => undefined} onMerge={() => undefined} />);
    const on = flat(s.getByTestId(`merge-source-${A.id}`));
    const off = flat(s.getByTestId(`merge-source-${B.id}`));
    expect(s.getByTestId(`merge-source-${A.id}`).props.accessibilityState.checked).toBe(true);
    for (const [, bg] of SURFACES) {
      expect(contrastRatio(String(on.borderColor), bg)).toBeGreaterThan(contrastRatio(String(off.borderColor), bg));
    }
    expect(Number(on.borderWidth)).toBeGreaterThan(Number(off.borderWidth));
  });

  it("the danger outline stays a soft rose, not a solid fill", async () => {
    const s = await render(<Button label="Delete" tone="danger" testID="b" onPress={() => undefined} />);
    expect(flat(s.getByTestId("b")).backgroundColor).toBe(colors.dangerBg);
  });
});

describe("Field", () => {
  it("shows its error on screen and announces it", async () => {
    const s = await render(<Field label="Confirm" testID="c" error="Passphrases don't match" helper="Must match exactly." />);
    const error = s.getByTestId("c-error");
    expect(error).toHaveTextContent("Passphrases don't match");
    expect(error.props.accessibilityRole).toBe("alert");
    expect(error.props.accessibilityLiveRegion).toBe("assertive");
    expect(StyleSheet.flatten(error.props.style).color).toBe(colors.dangerText);
    expect(contrastRatio(colors.dangerText, colors.bg)).toBeGreaterThanOrEqual(4.5);
  });
  it("renders no error text without an error", async () => {
    const s = await render(<Field label="Confirm" testID="c" />);
    expect(s.queryByTestId("c-error")).toBeNull();
  });
  it.each([["with a testID", "c"], ["without a testID", undefined]])("links the label to the input %s", async (_n, testID) => {
    const s = await render(<Field label="Workspace name" testID={testID} />);
    const label = s.getByText("Workspace name");
    const input = s.getByLabelText("Workspace name");
    expect(typeof label.props.nativeID).toBe("string");
    expect(input.props.accessibilityLabelledBy).toBe(label.props.nativeID);
  });
});

describe("Banner live regions", () => {
  it("a non-urgent banner (grace, info) is a polite live region, not an alert", async () => {
    const s = await render(<><Banner testID="w">Payment due</Banner><Banner tone="info" testID="i">Sent</Banner></>);
    for (const id of ["w", "i"]) {
      expect(s.getByTestId(id).props.accessibilityRole).toBeUndefined();
      expect(s.getByTestId(id).props.accessibilityLiveRegion).toBe("polite");
    }
  });
  it("a real error stays an alert", async () => {
    const s = await render(<><Banner alert testID="e">Merge failed</Banner><Banner tone="danger" testID="d">Failed</Banner></>);
    for (const id of ["e", "d"]) {
      expect(s.getByTestId(id).props.accessibilityRole).toBe("alert");
      expect(s.getByTestId(id).props.accessibilityLiveRegion).toBe("assertive");
    }
  });
  it("the grace banner on the workspaces screen is polite and the merge error is an alert", async () => {
    const W: ListedWorkspace = { id: "11111111-1111-4111-8111-00000000000a", name: "Alpha", kind: "paid", projectStatus: "active" };
    const s = await render(
      <WorkspacesScreen workspaces={[W]} unpaidIds={[]} graceEndsAt={{ [W.id]: Date.UTC(2026, 9, 21, 2) }} mergeError="Merge failed" onDelete={() => undefined} onMerge={() => undefined} />,
    );
    expect(s.getByTestId(`workspace-grace-${W.id}`).props.accessibilityLiveRegion).toBe("polite");
    expect(s.getByTestId(`workspace-grace-${W.id}`).props.accessibilityRole).toBeUndefined();
    expect(s.getByTestId("merge-error").props.accessibilityRole).toBe("alert");
  });
});
