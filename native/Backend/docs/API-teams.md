# Teams API (`feature/teams`)

All routes need a signed-in account (same auth as `/v2/projects`). Errors use `{error: CODE, message?}`. A non-member gets **404 `TEAM_NOT_FOUND`** for every team route, so a team's existence never leaks. Team data is server-only: `firestore.rules` denies all client access.

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

Subscriptions carry `metadata.kind` `team_subscription` (`teamId`, `tier`, `interval`) or `team_workspace_plans` (`teamId`, `workspaceId`). They are applied only when the customer matches the team owner's Stripe customer and the items match exactly; anything else is `mismatch` or ignored.

## Not built yet

- Team workspace file storage and transfers: team workspaces have records, plans, billing and ACL; the upload, download and quota routes still serve personal workspaces only.
- Account deletion doesn't yet remove team memberships or chat messages.
