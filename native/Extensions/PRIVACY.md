# GenDragoon extension privacy

This policy describes the GenDragoon browser and local VS Code clients. They connect to a locally installed, running GenDragoon native companion to show your MachineNotes and file metadata, request uploads you choose, and provide developer Teams.

## Connection, account information and uploads

The native companion requires the exact installed client ID and approval for the connected account before providing account metadata or accepting an upload request. Account sign-in stays in GenDragoon. The clients do not receive the native app's account passwords, account bearer tokens, integration API keys, Stripe credentials or private encryption keys.

The clients handle connection status, MachineNote names and identifiers, storage availability, file names and other file metadata returned by the companion. A browser upload opens GenDragoon's native file or folder picker. The browser client does not submit arbitrary local file paths. The local VS Code client sends only paths you explicitly select in its trusted local workspace picker to the native app for validation and upload queuing. These selected paths are not sent to teammates. Stored file contents, restoration, account settings and billing are handled in the native app, outside the extension's metadata interface.

## Teams information and its destinations

Teams uses the GenDragoon service connected through the native app. The clients send Teams requests through the local companion to that service. The service stores developer usernames, account and team identifiers, memberships and roles, invitations, community-rule acceptance and its timestamp, blocks, group messages, presence, connection signaling, reports and moderation records as needed for these features.

Authorized teammates can receive usernames, team membership and roles, permitted group messages, presence and peer-connection signaling. Team owners and administrators can manage invitations and membership within their roles. Team membership does not grant access to another member's stored files, upload paths, account credentials, encryption keys or billing.

The Teams page polls for messages and signaling while it is open. After the current community rules are accepted, it periodically refreshes presence for the open team. Presence records contain the peer identifier and timestamps. These are Teams availability features; the clients do not contain a general click, keystroke or browsing-activity analytics system.

## Invitation tokens

When an authorized team owner or administrator creates an invitation, the service returns a single-use invitation token and the client displays it for the user to share with the intended invitee. A joining user enters the token in the client, which sends it through the native companion to the service. These tokens authorize joining a team; they are distinct from account sign-in tokens.

The service stores a hash of the invitation token with its invitation identifier, expiry, revocation and use metadata, rather than storing the plaintext token. The current client creates invitations with a default validity of 72 hours. Using, revoking or expiring an invitation prevents later unauthorized use; it does not imply immediate deletion of the invitation's metadata. The client offers a control to hide the displayed token and clears the entered token after a successful join. Do not share an invitation token with someone you do not want to invite.

## Group messages and direct peer connections

Group-chat text is sent through the local companion to the service relay and made available to authorized team members. Group-chat text is service-readable. It is separate from encrypted stored-file contents and is not described as end-to-end encrypted chat.

Direct peer chat uses the packaged WebRTC implementation when the browser and network can establish a connection. The client exchanges connection descriptions and ICE candidates through the service with the intended authorized peer. These connection messages can contain network-address information and connection or session identifiers supplied by the browser. A direct connection also exposes the network addressing needed to communicate with the peer. The client does not request GPS or browser-geolocation access. No public TURN relay is configured by these clients.

Ordinary direct-chat text travels over the peer data channel rather than the group-message service relay. The current client keeps displayed direct text in its current view; it does not implement a service archive for ordinary direct chat. The peer channel provides text-chat protocol messages. It has no file-transfer, credential-sharing, keymap or remote-command interface; users should avoid pasting secrets into chat. Membership is checked through the service before signaling, sending and receiving, and periodically while the team is open. Clients close a peer connection when revalidation fails. Connectivity and immediate revocation while the service is unreachable cannot be guaranteed.

## Reports and moderation

A user can report a teammate or a displayed message. A report contains the reporter and reported peer/account references, team identifiers, a reason, optional context, submission and expiry timestamps, and any included evidence. A relay-message report identifies the existing service message; the service verifies that reference and copies its text into the report evidence.

For a direct-message report, the client shows a separate checkbox to include the displayed direct text. The client sends that text to the service only when the reporter selects that checkbox and submits the report. The service labels it as unverified, reporter-provided direct text, rather than a service-authenticated transcript. A report can be submitted without direct text. Do not include passwords, keys or other secrets in report context.

The team owner and verified GenDragoon service owner can read report details and evidence and record moderation decisions. Ordinary teammates do not receive the report-review interface. A reporter who is not one of those reviewers can retrieve a limited submission receipt. The interface allows a reporter to request service-owner review; reports about a team owner are automatically marked for escalation. Service-owner report access is not limited to reports marked for escalation.

Review records contain the reviewer's role, decision, action, optional note and review timestamp. Supported actions can hide a relay message, remove a reported teammate or, for the service owner, disable a team. Reports and review history are kept separately from the normal chat view. Hiding a relay message or dismissing a report does not erase the independently retained report evidence or other review records.

## Expiry, retained records and deletion

The service applies these logical expiry periods:

| Information | Logical expiry |
| --- | --- |
| Group messages and their lookup references | Seven days after creation |
| Presence | 45 seconds after its latest refresh |
| Peer-connection signaling | Two minutes after creation |
| Invitations created by the current clients | Normally 72 hours; also restricted to a single use and subject to revocation |
| Reports and their associated review history | 30 days after the report's original submission |

Expired messages, presence and signaling are excluded from normal active listings. Physical removal occurs in bounded batches on later relevant requests, so expiry is not a guarantee of immediate deletion. Invitation expiry controls joining; the current cleanup routine does not apply an automatic deletion deadline to invitation metadata.

Report evidence is a separate copy and can remain after the original seven-day group message has expired or been hidden. Reports become unavailable through the report interface after their 30-day expiry. Their evidence, indexes and review records are physically removed through bounded cleanup when report endpoints are accessed. A cleanup request can leave additional expired records for later requests; physical deletion can occur after logical expiry.

Profiles, community-rule acceptance, team and membership records, blocks and invitation metadata do not have the short automatic expiry periods used for chat, presence and signaling. Leaving or disabling a team changes access or status and does not by itself erase those records. Applicable linked collaboration records are also handled by the native account-deletion workflow. Use the native app to manage account deletion and other cloud resources. Removing an extension does not delete cloud data or cancel a subscription.

## Browser access and contact

The browser clients request native messaging only. They have no website host permissions, content scripts or page injection, and do not read visited-page contents, browsing history or website passwords. Their scripts and styles are packaged locally. The extension transport contains no analytics endpoint and does not write account credentials or stored file contents to logs. Connection errors are displayed locally.

For extension privacy questions or support, contact **support@infected-nation.com**. Do not send account passwords, bearer tokens, invitation tokens or private encryption keys in a support message.
