# @gendragoon/updater

App-agnostic update cycle used by Red-XAI Updater, the Windows GenDragoon client, and any later app (for example LumiAI) that can hand over a release manifest. The package does not know about a product UI. Callers pass a small config and hooks.

## Release manifest

This JSON object is the interchange format. LumiAI's existing updater can swap to it without a UI change. Required fields are exactly `version`, `url`, `sha256`, and `notes`. `channel` is optional. Unknown fields are rejected.

```json
{
  "version": "1.4.0",
  "url": "https://github.com/example/app/releases/download/v1.4.0/App-1.4.0.zip",
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "notes": "What changed.",
  "channel": "stable"
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | Semantic version. A leading `v` is stripped. |
| `url` | yes | `https` download URL. Userinfo is rejected. |
| `sha256` | yes | Lowercase hex SHA-256 of the downloaded bytes. |
| `notes` | yes | Release notes shown by the host UI. May be empty. |
| `channel` | no | `stable` or `beta`. Omitted prerelease versions are treated as beta. |

```ts
import { parseReleaseManifest, chooseRelease, runUpdate } from "@gendragoon/updater";

const manifest = parseReleaseManifest(jsonFromYourFeed);
const chosen = chooseRelease([manifest], "stable");
if (chosen) {
  await runUpdate({
    manifest: chosen,
    download: async (item) => fetchBytes(item.url),
    install: async (_item, bytes) => writeInstall(bytes),
    relaunch: async () => restart(),
    healthCheck: async () => probe(),
    rollback: async () => restorePrevious(),
  });
}
```

## Channels

- **stable** selects the highest version that is not a prerelease and whose channel is not `beta`.
- **beta** selects the highest version, including prereleases.

The default public feed is the existing GitHub Releases list for `grimvirusoffical-source/gendragoon-cloud-ssd`. There is no separate releases repository. A prerelease on that feed is beta. Stable stays empty until a non-prerelease is published.

## Config

```ts
interface FeedConfig {
  repo: string;          // "owner/name"
  assetPattern: string;  // regex matched against asset file names
  readToken?: () => Promise<string | undefined>;
}
```

`assetPattern` is how each app finds its own file (`^GenDragoon-Cloud-SSD-Setup-.*\\.exe$`, `^GenDragoon-Cloud-SSD-Mac-.*\\.zip$`, and so on). Checksums come from a sibling `sha256.txt` asset (`<hash>  <filename>`). Assets without a checksum are not candidates.

## Cycle

1. Choose a manifest for the channel.
2. Download the URL.
3. Verify SHA-256. On mismatch, stop. Nothing is installed or relaunched.
4. `install`.
5. Show a non-blocking `Updating...` notice. There is no Restart button.
6. If an upload or backup is in progress, defer. Call `relaunchIfIdle` when it finishes.
7. Otherwise `relaunch` immediately.
8. `healthCheck`.
9. If the check fails, `rollback` to the previous version.

Hosts that exit inside `relaunch` should persist a pending marker and call `settleHealth` on the next launch. That runs the same health check and rollback.

## Tokens

Public repositories need no token. A token for a private repository is read only through `readToken`, which the host implements against the OS keychain (Electron `safeStorage`, macOS Keychain, Windows Credential Manager). The token is placed on the GitHub request and is not written into manifests, logs, errors, or the repository. This package never bundles a token.
