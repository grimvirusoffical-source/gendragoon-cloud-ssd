import { readFileSync } from "node:fs";
import path from "node:path";
import { workspaceKeyId } from "@gendragoon/core";
import * as SecureStore from "expo-secure-store";
import { createExpoSecureStore } from "../src/platform/secureStore";

describe("expo secure store passed to core", () => {
  it("round-trips workspace key bytes and deletes them", async () => {
    const secrets = createExpoSecureStore();
    const key = workspaceKeyId("ws-secure");
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await secrets.set(key, bytes);
    const stored = await secrets.get(key);
    expect(stored).toEqual(bytes);
    const calls = (SecureStore.setItemAsync as jest.Mock).mock.calls;
    const storageKey = calls.at(-1)?.[0] as string;
    expect(storageKey.startsWith("gd.")).toBe(true);
    expect(storageKey.includes(":")).toBe(false);
    await secrets.delete(key);
    expect(await secrets.get(key)).toBeNull();
  });

  it("does not keep a second mobile secret adapter", () => {
    const source = readFileSync(path.join(__dirname, "../src/platform/secureStore.ts"), "utf8");
    const deletion = readFileSync(path.join(__dirname, "../src/account/deleteAccount.ts"), "utf8");
    expect(source).not.toMatch(/AsyncStorage/);
    expect(deletion).not.toMatch(/AsyncStorage/);
    expect(deletion).toMatch(/deleteAccountAndWipe/);
    expect(source).not.toMatch(/deletionResume|statusToken/);
  });
});
