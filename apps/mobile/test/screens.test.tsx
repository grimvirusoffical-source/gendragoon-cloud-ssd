import { MemorySecretStore, treeNode, type SortOverrides } from "@gendragoon/core";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { useState } from "react";
import { DeleteAccountScreen, FileTree, SettingsHome, SortScreen } from "../src/screens";

const file = treeNode({ path: "Pictures/vacation.jpg", directory: false });

describe("mobile screens", () => {
  it("backup lists files and does not offer encrypted upload while that flag is off", async () => {
    const screen = await render(
      <FileTree
        mode="backup"
        nodes={[file]}
        locked={false}
        selected={file}
        onSelect={() => undefined}
        onRefresh={() => undefined}
        onUpload={() => undefined}
        onBackup={() => undefined}
      />,
    );
    expect(screen.queryByTestId("upload-button")).toBeNull();
    expect(screen.queryByTestId("backup-button")).toBeNull();
    expect(screen.getByTestId("file-vacation.jpg")).toBeTruthy();
    expect(screen.getByTestId("refresh")).toBeTruthy();
  });

  it("applies a sort override for .jpg", async () => {
    function Harness() {
      const [overrides, setOverrides] = useState<SortOverrides>({});
      return <SortScreen overrides={overrides} onChange={setOverrides} />;
    }
    const screen = await render(<Harness />);
    expect(screen.getByTestId("sort-.jpg")).toHaveTextContent(/sorts to Pictures/);
    fireEvent.press(screen.getByTestId("sort-category-Documents"));
    await waitFor(() => {
      expect(screen.getByTestId("sort-.jpg")).toHaveTextContent(/sorts to Documents/);
    });
  });

  it("disables delete account during transfers", async () => {
    const secrets = new MemorySecretStore();
    const screen = await render(
      <DeleteAccountScreen
        activeTransfers={1}
        secrets={secrets}
        workspaceIds={["ws-1"]}
        idToken="token"
        client={{
          deleteAccount: async () => ({ jobId: "should-not-run" }),
          deletionStatus: async () => ({ jobId: "should-not-run", status: "done" }),
        }}
        onReauth={() => undefined}
        onSignedOut={() => undefined}
        onDone={() => undefined}
        onError={() => undefined}
      />,
    );
    expect(screen.getByTestId("delete-account-continue")).toBeDisabled();
    const home = await render(
      <SettingsHome
        deleteDisabled
        onSort={() => undefined}
        onConnect={() => undefined}
        onDelete={() => undefined}
        onSignOut={() => undefined}
      />,
    );
    expect(home.getByTestId("delete-account")).toBeDisabled();
  });
});
