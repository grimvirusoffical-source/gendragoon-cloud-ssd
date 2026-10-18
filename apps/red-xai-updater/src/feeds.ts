import type { UpdateChannel } from "@gendragoon/updater";

/** Public GitHub releases only. No separate binaries repository and no tokens. */
export interface AppFeed {
  id: string;
  repo: string;
  assetPattern: string;
  channel: UpdateChannel;
}

export const RED_XAI_FEEDS: readonly AppFeed[] = [
  {
    id: "gendragoon-cloud-ssd",
    repo: "grimvirusoffical-source/gendragoon-cloud-ssd",
    assetPattern: "^GenDragoon-Cloud-SSD-Mac-.*\\.zip$",
    channel: "stable",
  },
];

export const DEFAULT_MAC_ASSET = "GenDragoon-Cloud-SSD-Mac-v0.18.0.zip";
