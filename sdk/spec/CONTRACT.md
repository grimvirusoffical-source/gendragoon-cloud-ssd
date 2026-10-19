# Contract suite

Every SDK runs the same scenarios against local backends. A scenario passes only when the SDK produces the
same observable result as the others; `contract/run.sh` then checks that every SDK reads the files every other
SDK wrote.

## Backends

| Suite | Server | Started by |
|---|---|---|
| C01–C16 | `provider_dev_server.js` from gendragoon-cloud-ssd `feature/sdk-backend`, with `PROVIDER_V1_ENABLED=true` | `GD_DEV_SERVER=<path>` (or `GD_SDK_BASE=<url>` for a running one) |
| T01–T11 | [`contract/teams_dev_server.cjs`](../contract/teams_dev_server.cjs), which mounts the Teams routes of a gendragoon-cloud-ssd `feature/teams` checkout | `GD_TEAMS_SERVER=<path>` and `GD_TEAMS_BACKEND=<cloud-ssd>/native/Backend` (or `GD_TEAMS_ORIGIN=<url>`) |

Both run in memory on `127.0.0.1`, accept `Authorization: Bearer dev-user:<uid>` as a signed-in account, and
exit when their standard input closes. The Teams server replaces Stripe with a local double; `POST
/__dev/pay {"url": "<checkout url>"}` completes a checkout by sending a signed subscription webhook. Without
these variables the suites are skipped, not failed. `POST /__dev/personal-workspace {"uid", "workspaceId",
"name"}` on the Teams server creates a personal workspace for an account (used by T11).

## Provider scenarios

| Id | Scenario | Passes when |
|---|---|---|
| C01 | Connect with a connect code | the code redeems to a working key; capabilities report polling events, no webhook, 16 MiB blobs; a forged code fails with `invalid_grant` |
| C02 | Connect with PKCE | the approved link redirects with the same state; the code fails with a wrong verifier and succeeds with the right one |
| C03 | Master key lifecycle | create, then a second create fails as a precondition (412); a wrong passphrase fails; unlock, passphrase change and re-unlock work; exporting the key is refused at the default cap |
| C04 | Encrypted files and folders | write, list (folders first), read, mkdir, move, delete; a non-empty folder is not deleted without `deleteFolder`; nothing readable is stored on the server |
| C05 | Plain drive | files round-trip and chunks are content-addressed by SHA-256 |
| C06 | Concurrent writers | several writers on one drive commit in parallel and no write is lost |
| C07 | Quota | a write above the quota fails with `quota_exceeded`; usage reports bytes and objects |
| C08 | Gate | an L2 client is refused `files.deleteFolder` (L3), `storage.wipe` (L4), `files.delete`, `blobs.delete`, `manifests.delete` and `keyEnvelope.replace` (all L3) before any request |
| C09 | Events | `watch` reports the watched drive's manifest being created and updated, and ends with `binding.revoked` when the binding is revoked |
| C10 | Sharing | a file sealed to an identity opens for it and not for another; the read key cannot write or read the key envelope; a revoked read key stops working |
| C11 | Folder sync | push uploads once; pull restores content; mirror (with dry run) removes files deleted on the other side |
| C12 | Garbage collection and wipe | unreferenced blobs are collected and live ones kept; collection refuses to run when a drive cannot be read; an L4 wipe leaves no manifests and zero usage |
| C13 | Key rotation | rotation returns a different key and the client keeps working with it |
| C14 | Account bindings | the account lists its binding with its usage; revoke-and-delete is refused at the default cap; another account cannot revoke it (404) |
| C15 | Cloud save at L2 | on a fresh binding an L2 client finds no key (404), creates the first key, cannot create a second one (412) or replace it (level error); it saves, overwrites in place, reads back and deletes one slot with `deleteSlot`; `deleteSlot` refuses folders (404) and names that are not a single path segment |
| C16 | Sync stays inside | pull refuses drive paths with `..`, a leading slash, or a path through a symbolic link in the local folder (to outside or inside it) and writes nothing; push skips symbolic links |

## Teams scenarios

| Id | Scenario | Passes when |
|---|---|---|
| T01 | Catalog | at least three tiers are listed |
| T02 | Create and pay | an L2 client is refused `teams.create`; the owner gets a checkout URL; after payment the team is active |
| T03 | Invite and join | the invite previews the team and its free colors; joining works once and reports `alreadyMember` the second time; the invite can be revoked |
| T04 | View and update | the owner sees both members; the member's new display name is visible |
| T05 | Chat | a posted message is listed with the latest sequence number; `watchChat` delivers the next message |
| T06 | Report and remove | a member can report but not remove a message; the owner removes it and it is listed as removed |
| T07 | Team workspace and roles | creating a workspace returns a checkout and its `/v3/cloud/<id>` route; a viewer sees it with read access |
| T08 | Mute | a muted member cannot post (403); after unmute they can |
| T09 | Audit | only the owner reads the audit log; the hash chain verifies and a tampered chain does not |
| T10 | Levels and removal | transfer and delete are refused at the default cap (L4); a kicked member loses access |
| T11 | Personal workspace card | an L2 client is refused a personal card (`teams.share`, L3); without the share flag the server refuses a card for an unshared workspace (403 `SHARE_REQUIRED`); with it the card is posted and the other member sees the workspace as shared; a card for a shared workspace needs no flag |

Godot runs a subset (C01, C03, C04, C07 with the write above the quota, C08 with every call in its table
refused before any request, C15, and a player-side Teams flow: preview, join, list, update, chat, watch,
workspaces, leave). The Unreal C ABI runs offline checks, the interop round and C15 on a fresh binding
(`cabi_test --first-run`).

## Interop

`contract/run.sh` connects one binding and runs every available SDK twice against the shared encrypted drive
`interop`: Go, JS, Python, C#, Swift, Godot and the C ABI (`unreal`). The first participant creates the master
key. In the second round every participant must decrypt `from-<lang>.txt` from all the others.
