# GenDragoon extension privacy

The clients communicate with a locally installed GenDragoon native companion. Account sign-in and encryption keys remain in that application. Passwords, account bearer tokens, integration API keys, Stripe credentials, and private encryption material are never bundled with or returned to the extensions.

The interface displays your account label, MachineNote names, file metadata, and developer team usernames, membership, invitations, presence, chat, and WebRTC signaling. Requests you explicitly make are sent by the native companion to your connected GenDragoon service. A browser upload uses the native app's picker. VS Code transmits explicitly selected local paths to the local app so it can validate and queue an owner upload; those paths are not exposed to teammates.

Team chat uses the service relay. Messages expire after seven days; bounded opportunistic cleanup removes expired server records during subsequent requests. Presence expires after 45 seconds and signaling after two minutes. Physical cleanup timing can follow expiry. Invitation tokens are shown once, stored on the service only as hashes, expire, and are single use by default. Do not share a token with someone you do not want to invite.

Direct peer chat uses the packaged WebRTC implementation when connectivity succeeds. It carries developer text/presence protocol messages only and does not carry stored files, file paths, credentials, keymaps, or remote commands. Peer membership is revalidated through the service. Connectivity and immediate offline-peer revocation cannot be guaranteed while the service is unreachable; clients close access when revalidation fails.

The extensions have no website host permissions or content scripts, and do not collect browsing history or website passwords. They contain no analytics endpoint or remote JavaScript. Connection errors are shown locally. No credentials or file content are logged by the extension transport.

Your GenDragoon service retains its account, billing, file, and team metadata according to its separate product terms. Installing or uninstalling an extension does not erase cloud data or cancel a subscription. Open the native app to manage those resources.
