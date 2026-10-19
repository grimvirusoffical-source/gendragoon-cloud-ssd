# Levels

Rotten Apple grants SDK access by developer level (Rotten Apple `docs/SDK_LEVELS.md`, branch `audit-fill`,
section 2):

| Level | Name | Unlocks when |
|---|---|---|
| L0 | Applicant | account only |
| L1 | Starter | developer license active, ID verified, 2FA, certificate issued, device registered |
| L2 | Established | at least one approved app, license 30 days old, no open strikes, crash-free sessions of 98 % and analytics for a shipped build |
| L3 | Trusted | three approved apps, license 90 days old, 1,000 installs, no strike in 180 days, payout set up |
| L4 | By approval | manual approval per service, with documents |

The GenDragoon services, `gendragoon` and `data.storage`, are L2 services. Every GenDragoon call is therefore
at least L2. Calls that can do lasting harm are placed higher. These per-call placements are GenDragoon's method
list under section 8 of `SDK_LEVELS.md`; ra-core registers them and confirms them with Josh, and
`spec/operations.json` is updated if they change.

## How the gate works

* Every SDK call names an operation. Before any network request the client's gate compares the operation's
  level with the client's cap and refuses the call with a level error (`LevelError`, `LevelException`, or
  `GD_ERR_LEVEL` in the C ABI).
* The default cap is **L3**. L4 calls need the caller to set the cap to L4 explicitly.
* `GENDRAGOON_SDK_MAX_LEVEL` (`L0`–`L4` or `0`–`4`) lowers the cap for every client in the process. It cannot
  raise it. An unreadable value locks the client to L0. The Rotten Apple launcher sets it to the developer's
  level.
* The Unity component and the Unreal plugin default to L2, which is all that cloud saves need.
* The gate is a guard against mistakes in the app, not a security boundary: the server enforces scopes,
  ownership and roles on its own.

## Risks

| Risk | Meaning |
|---|---|
| read | Reads data or metadata |
| write | Adds or changes data |
| credential | Creates or replaces a credential |
| destructive | Deletes or removes one thing |
| bulk-destructive | Deletes many things at once |
| key | Creates, replaces or uses the master key |
| key-export | Exports the master key in clear |
| sharing | Gives or removes someone else's access |
| billing | Starts or changes a paid subscription (opens a checkout) |

## Calls above L2

| Operation | Level | Risk |
|---|---|---|
| `keyEnvelope.create`, `keyEnvelope.replace` | L3 | key |
| `files.deleteFolder`, `files.collectGarbage`, `sync.mirror` | L3 | bulk-destructive |
| `share.export`, `share.createReadKey`, `share.revokeReadKey` | L3 | sharing |
| `account.createGrant`, `account.authorize`, `account.revokeBinding` | L3 | sharing |
| `teams.create`, `teams.checkout`, `teams.createWorkspace`, `teams.checkoutWorkspace` | L3 | billing |
| `teams.createInvite`, `teams.revokeInvite`, `teams.join`, `teams.share`, `teams.unshare`, `teams.members.setRole` | L3 | sharing |
| `teams.leave`, `teams.chat.delete`, `teams.members.mute`, `teams.members.kick`, `teams.members.ban` | L3 | destructive |
| `teams.members.unmute` | L3 | write |
| `crypto.exportMasterKey` | L4 | key-export |
| `storage.wipe`, `account.revokeAndDelete`, `teams.delete` | L4 | bulk-destructive |
| `teams.transfer` | L4 | sharing |

Posting a workspace card for a *personal* workspace to team chat also shares that workspace, so the SDKs check
`teams.share` (L3) in addition to `teams.chat.post` (L2).

The full list, including every L2 call, is in [OPERATIONS.md](OPERATIONS.md).
