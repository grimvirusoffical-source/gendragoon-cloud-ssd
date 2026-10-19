interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
}

interface GendragoonBridge {
  platform: string;
  setTransferActive?: (active: boolean) => void;
  onUpdaterNotice?: (callback: (text: string) => void) => void;
  checkForUpdates?: () => Promise<unknown>;
  getUpdatePolicy?: () => Promise<unknown>;
  getUpdateState?: () => Promise<unknown>;
  onUpdateState?: (callback: (state: unknown) => void) => void;
  getSecret?: (name: string) => Promise<Uint8Array | null>;
  setSecret?: (name: string, bytes: Uint8Array) => Promise<void>;
  deleteSecret?: (name: string) => Promise<void>;
  getIdToken?: () => Promise<string | undefined>;
  openBilling?: (url: string) => Promise<boolean>;
}

declare global {
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
  interface Window {
    gendragoon?: GendragoonBridge;
  }
}

export {};
