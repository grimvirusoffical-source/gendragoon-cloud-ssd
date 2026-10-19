# Teams API (`feature/teams`)

All routes need a signed-in account (same auth as `/v2/projects`). Errors use `{error: CODE, message?}`. A non-member gets **404 `TEAM_NOT_FOUND`** for every team route, so a team's existence never leaks. Membership (and, on owner routes, ownership: `403 TEAM_OWNER_ONLY`) is checked before the request body is validated, so a bad body never turns that 404 into a 400. Team data is server-only: `firestore.rules` denies all client access.

## Tiers (approved 2026-10-19)

| Tier | Members | Monthly | Yearly (10x) | Stripe catalog keys |
| --- | --- | --- | --- | --- |
| Team | 5 | $9.99 | $99.90 | `team|team|month`, `team|team|year` |
| Team Plus | 15 | $24.99 | $249.90 | `team|team_plus|month`, `team|team_plus|year` |
| Business | 50 | $69.99 | $699.90 | `team|business|month`, `team|business|year` |
| Enterprise | custom | contact us | | none (`400 ENTERPRISE_CONTACT`) |

Per-workspace plans come **on top**: every team workspace needs a storage plan + a performance plan, or for custom storage a performance plan only. Teams get no free workspace and there is no workspace fee. Until the team prices exist in Stripe, team checkout returns `503 TEAM_PRICE_UNCONFIGURED` (see `scripts/stripe_prices_to_create.js`).

## Routes

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| GET | `/v2/teams/catalog` | any | tiers, Enterprise, color palette |
| GET | `/v2/teams` | any | my teams |
| POST | `/v2/teams` | any | `{name, intentId, tier, interval?, ownerShade?, displayName?, deviceName?}`; creates the team and opens the team subscription checkout (`url`, `totalCents`) |
| GET | `/v2/teams/:id` | member | team, members (`memberId`, `displayName`, `color`, `colorHex`, `role`, `muted`), color choices with `taken` |
| POST | `/v2/teams/:id/checkout` | owner | `{tier?, interval?}`; resumes or replaces the open session |
| POST | `/v2/teams/:id/invites` | owner | `{expiresInHours?=72, maxUses?}`; needs an active subscription; returns `code` (`XXXX-XXXX-XXXX`), `link` (`/teams/join#CODE`), `inviteId`. Only a hash of the code is stored |
| POST | `/v2/teams/:id/invites/:inviteId/revoke` | owner | |
| POST | `/v2/teams/join/preview` | any | `{code}`; team name, member count and limit, colors with `taken`, so the join screen can grey them out. Shares the join rate limit |
| POST | `/v2/teams/join` | any | `{code (or the link), color, displayName?, deviceName?}`; 10 attempts/min; `INVITE_INVALID`, `TEAM_FULL`, `TEAM_BANNED`, `COLOR_TAKEN`, `COLOR_RESERVED` |
| PATCH | `/v2/teams/:id/me` | member | `{displayName?, color?}` at any time |
| POST | `/v2/teams/:id/leave` | member | the owner can't leave; the member's shares are removed |
| GET | `/v2/teams/:id/workspaces` | member | `teamWorkspaces` (with `projectStatus`: `pending_payment`, `team_subscription_required`, `active`) and `sharedWorkspaces` |
| POST | `/v2/teams/:id/workspaces` | owner | `{name, intentId, storage?: "managed"|"custom", plans}`; same plan rules and codes as `/v2/projects` (`PLANS_REQUIRED`, `PERFORMANCE_PLAN_REQUIRED`, `INVALID_SELECTION`); needs the team subscription (`402 TEAM_SUBSCRIPTION_REQUIRED`); opens one plans checkout |
| POST | `/v2/teams/:id/workspaces/:wid/checkout` | owner | resume plans checkout |
| POST | `/v2/teams/:id/shares` | member | `{workspaceId}` of **your own** personal workspace |
| DELETE | `/v2/teams/:id/shares/:wid` | sharer or owner | |
| GET | `/v2/teams/:id/chat?after=SEQ&limit=50` | member | polling; `pollAfterMs: 3000` |
| GET | `/v2/teams/:id/chat/stream?after=SEQ` | member | Server-Sent Events (`event: message`, `event: removed`); ends after 5 min, client reconnects |
| POST | `/v2/teams/:id/chat` | member | `{text}` (≤ 2000 chars, plain text) or `{card: {scope: "team"|"personal", workspaceId, share?}}` |
| POST | `/v2/teams/:id/chat/:seq/report` | member | `{category: spam|abuse|harassment|illegal|other, note?}`; goes to the platform owner queue (`abuse_reports`) |
| POST | `/v2/teams/:id/chat/:seq/delete` | owner | `{reason}` |
| POST | `/v2/teams/:id/members/:memberId/{mute,unmute,kick,ban}` | owner | `{reason, until?: epoch ms | null (forever)}` |
| GET | `/v2/teams/:id/audit` | owner | hash-chained log |
| POST | `/v2/teams/:id/members/:memberId/role` | owner | `{role: "member"|"viewer"}`; audited as `member.role` |
| POST | `/v2/teams/:id/transfer` | owner | `{memberId, color, ownerShade?}`: `color` is the old owner's new member color, `ownerShade` the new owner's purple (default `purple-500`) |
| POST | `/v2/teams/:id/delete` | owner | `{confirmName}` (the exact team name). Cancels the team subscription and team workspace plans, deletes chat, invites, team workspaces and their files. `503 TEAM_DELETE_UNAVAILABLE` if storage isn't wired |

## Visibility (ACL)

- Personal workspaces live under the account and are **never** listed for a team. A personal workspace shows up only after its owner shares it (`POST /shares`, or a chat card with `share: true`). Nobody else, including the team owner, can share it.
- A share shows the name and who shared it (`permission: "view"`). It grants no access through `/v2/projects` and no file keys.
- Every read re-checks the share and the workspace. Unsharing, leaving, a kick or a ban removes it; old chat cards then show `unavailable: true` with no name.
- Members see `memberId` (a per-team hash), never account hashes.

## Colors and names

- Members pick from 52 colors (13 hues x 4 shades; no purple, violet, fuchsia or indigo). Each color is unique within a team; uniqueness is enforced with a per-color lock document in the same transaction as the join or change.
- Purple is the owner's: the owner picks one of 6 purple shades. Members get `COLOR_RESERVED` for any purple.
- The display name defaults to the device name the client sends (`deviceName`), otherwise "Member". It can be changed at any time (1 to 40 characters; control and bidi characters are stripped).

## Moderation (OWNER_MODERATION.md, applied to a team)

- Owner actions: delete a message, mute or unmute, kick, ban (blocks rejoining). A **reason is required** and shown to the member (in the muted error, the ban error and the removed-message placeholder). Durations: forever (`null`) or until a future time.
- Automatic: more than 8 messages in 10 s gives a **5-minute** mute with a plain-words reason. Automatic actions are never permanent.
- Every action (owner, member or automatic) goes to `gd_teams/{id}/audit` as a hash chain (`prev`, `hash`); an edit breaks verification.
- Platform hook: `account_state/{accountHash}` (OWNER_PAGE_PLAN 15.4). `suspended`, `terminated` and `pending_deletion` block team routes; `restricted` can read but not post or create. Message reports go to `abuse_reports` with hash ids only.

## Billing webhooks

Subscriptions carry `metadata.kind` `team_subscription` (`teamId`, `tier`, `interval`) or `team_workspace_plans` (`teamId`, `workspaceId`). They are applied only when the account is the team's payer (or the current owner taking over lapsed billing), its Stripe customer matches, and the items match exactly; anything else is `mismatch` or ignored.

## Team workspace files

Team workspaces use **the same routes as personal workspaces**, with the team workspace id:

- `/v3/cloud/:id/...` (config, files, uploads, chunks, finalize, download with `Range`, delete): desktop, mobile and browser transfers, backup and preload.
- `/v2/workspaces/:id/cloud/...` (the core client's `uploadFile`, `listFiles`, `downloadFile`).
- `POST /v2/workspaces/:id/storage-urls` (signed URLs for the encrypted object store).

`GET /v2/teams/:id/workspaces` returns `storageRoutes`, `usedBytes` and `access` (`write` or `read`) for each team workspace.

How an id is resolved: the caller's personal workspace first; if there is none, `gd_team_workspace_index/{id}` names the team. Ids are unique across both (team workspace creation and `/v2/projects` refuse an id the other uses, `409 INTENT_CONFLICT`). Objects live under `customer/teams/<teamId>/<workspaceId>/`, never under any member's prefix.

| Who | Read (list, download, signed GET) | Write (upload, signed PUT) | Delete |
| --- | --- | --- | --- |
| owner | yes | yes | yes |
| member | yes | yes | yes |
| viewer | yes | `403 TEAM_ROLE_READ_ONLY` | `403 TEAM_ROLE_READ_ONLY` |
| not an active member (never joined, left, kicked, banned) | `404` | `404` | `404` |
| API key (`gdsk_`) | refused: keys belong to one personal workspace | | |

- Quota is the storage plan of the team workspace (`requiredPlans.storageTier`), counted in `usedBytes`/`reservedBytes` on the team workspace record. Uploads past it are `413`.
- Transfer workers and the preload budget (`/config` → `transfer.workers`, `defaultPrefetchBytes`, `nativeApplication`) come from the paid performance plan.
- Plans never paid: `403`. Plans or team subscription lapsed after being paid: files stay readable and deletable, writes are `423 {error:"workspace_lock", reason:"lapsed"}`. Custom storage team workspaces: `409 byo_external` (files live in the team's own bucket).
- Platform `account_state` suspensions block team storage like other team routes.
- Shared **personal** workspaces stay view-only cards: a share does not open the owner's files to the team.

## Ownership transfer and billing

The payer (`payerHash`) is whoever's Stripe customer pays. A transfer changes the owner, not the payer: the old owner's subscription keeps reconciling. Once the team subscription (or a team workspace's plans) is no longer active, the current owner can check out on their own customer and the webhook moves `payerHash` to them; stray events for the old subscription are then ignored.

## Account deletion

Rule: **an owner must transfer the team or delete it first** when other active members remain. `DELETE /v2/account` answers `409 {error:"team_owner_must_transfer", teams:[{teamId,name,otherMembers}], message}` before anything is deleted. The deletion job also runs a `teams` step first, before Stripe and object deletion, and re-checks (a member who joined in between fails the job retryably with `failureReason: "team_owner_must_transfer"`; nothing else has been deleted).

The `teams` step (`teams_account.js`):

- A team whose only active member is the owner is deleted with the account, including team workspace files.
- How teams are found: every team the account ever touched, not only its current ones. Sources: `gd_accounts/<hash>/teams` (active memberships), `gd_accounts/<hash>/team_history` (written on create/join and **kept** by leave, kick and ban), teams it pays for, and collection-group queries on `members.accountHash`, `messages.authorHash` and `shares.ownerHash` (they also cover records older than `team_history`). These need the collection-group single-field indexes in the repo-root `firestore.indexes.json`; deploy them before release. A failed query fails the step so the job retries; nothing is skipped silently.
- Every other team, whether the user is still active, left, was kicked or was banned: the member record (any status) is deleted, the color lock freed, `memberCount` lowered (only if still active; leave/kick/ban already lowered it), the user's personal-workspace shares removed, and **each chat message they wrote is emptied** (`text`, `card`, author hash and member id removed; shown as "Deleted member", `kind: "removed"`, `removed.by: "account"`). Message `seq` numbers stay so polling doesn't skip.
- A ban still in force leaves only a pseudonymous tombstone at `gd_teams/<id>/bans/<memberId>`: `{memberId, reason, untilMs, accountDeleted: true, atMs}`. `memberId` is the per-team hash, so it can't be linked back to the account. The account hash, display name, color and message text are gone. (A deleted account can't rejoin; a new account has a new hash.) The tombstone goes when the team is deleted.
- After the step, no `gd_teams/…` or `gd_team_…` row contains the account hash, and the account's `teams` and `team_history` index docs are deleted. The step is idempotent.
- The audit log is kept (it holds per-team pseudonymous member ids only, including earlier kick/ban entries with their reasons) and gets `member.account_deleted`; the hash chain still verifies.
- A team or team workspace the user still pays for after a transfer is marked `canceled` with `payerHash: null` (the Stripe step of the same job cancels the subscription). Its files stay readable for the team (`plansEverPaid`) until the new owner checks out.
- Abuse reports the user filed or that name them stay in the platform queue (owner page retention rules apply).
