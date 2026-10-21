import { MemorySecretStore, treeNode, type SortOverrides } from "@gendragoon/core";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { useState } from "react";
import { DeleteAccountScreen, FileTree, PassphraseScreen, SettingsHome, SortScreen } from "../src/screens";

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

  it("keeps Save disabled until the passphrase matches, meets the hint, and is acknowledged", async () => {
    const onSubmit = jest.fn();
    const screen = await render(<PassphraseScreen onSubmit={onSubmit} />);
    expect(screen.getByText("Passphrase")).toBeTruthy();
    expect(screen.getByText("Confirm passphrase")).toBeTruthy();
    expect(screen.getByLabelText("Passphrase")).toBeTruthy();
    expect(screen.getByLabelText("Confirm passphrase")).toBeTruthy();
    expect(screen.getByTestId("passphrase-hint")).toHaveTextContent("Use at least 8 characters.");
    expect(screen.getByTestId("passphrase")).toHaveProp("secureTextEntry", true);
    expect(screen.getByTestId("passphrase-save")).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId("passphrase"), "correct horse");
    await fireEvent.changeText(screen.getByTestId("passphrase-confirm"), "wrong horse");
    expect(screen.getByText("Passphrases don't match")).toBeTruthy();
    expect(screen.getByTestId("passphrase-save")).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId("passphrase-confirm"), "correct horse");
    expect(screen.queryByText("Passphrases don't match")).toBeNull();
    expect(screen.getByTestId("passphrase-hint")).toHaveTextContent("At least 8 characters.");
    expect(screen.getByTestId("passphrase-save")).toBeDisabled();
    await fireEvent.press(screen.getByTestId("passphrase-ack"));
    expect(screen.getByTestId("passphrase-ack")).toHaveProp("accessibilityState", { checked: true });
    expect(screen.getByTestId("passphrase-save")).not.toBeDisabled();
    await fireEvent.press(screen.getByTestId("passphrase-visibility"));
    expect(screen.getByTestId("passphrase")).toHaveProp("secureTextEntry", false);
    await fireEvent.press(screen.getByTestId("passphrase-save"));
    expect(onSubmit).toHaveBeenCalledWith("correct horse");
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
    expect(home.getByTestId("about-ownership")).toHaveTextContent(
      "Gendragoon is developed and maintained by Red-XAI LLC. Red-XAI LLC is wholly owned by GRIM-VIRUS, an independent recording artist who leads development under the alias MainDirectory. © Red-XAI LLC. All rights reserved.",
    );
  });
});
