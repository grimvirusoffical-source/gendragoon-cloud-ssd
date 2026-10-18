import {
  base64ToBytes,
  bytesToBase64,
  type SecretStore,
} from "@gendragoon/core";
import * as SecureStore from "expo-secure-store";

/**
 * Core's SecretStore (async get, set, delete), backed by expo-secure-store.
 * Workspace keys and BYO credentials go through this object and are passed
 * into core. There is no second mobile store for those secrets.
 */
export function createExpoSecureStore(): SecretStore {
  return {
    async get(name) {
      const stored = await SecureStore.getItemAsync(storageKey(name));
      if (stored === null) return null;
      return base64ToBytes(stored);
    },
    async set(name, bytes) {
      await SecureStore.setItemAsync(storageKey(name), bytesToBase64(bytes), {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
      });
    },
    async delete(name) {
      await SecureStore.deleteItemAsync(storageKey(name));
    },
  };
}

/** SecureStore keys are limited to alphanumerics, ".", "-", and "_". */
function storageKey(name: string): string {
  const encoded = bytesToBase64(new TextEncoder().encode(name))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
  return `gd.${encoded}`;
}
