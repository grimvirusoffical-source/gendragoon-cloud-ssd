# Mac setup sequence

Home and Account remain available for account authentication, vault recovery,
updates, unmounting and workspace creation. All other sidebar pages and their
deep-link entry points require **both** a confirmed mount and a current
server-confirmed device signature for the selected account/workspace.

1. Mount the selected SSD. Preparing, orphaned, unknown, foreign-account and
   other-workspace mounts do not satisfy this step.
2. Sign this Mac. The action and its model method refuse an unmounted workspace.
   A successful live capabilities/list request must report encrypted signing
   available before the app generates the encrypted receipt.
3. Use the workspace. A stored Keychain credential alone never unlocks it.
   The corresponding server row must be signed and verified recently.

Unmounting, unsigning, switching account/workspace or losing server verification
relocks the protected pages. Unmount and account recovery remain available.
Revocation is never blocked merely because the mount is unavailable.

## Deployment limitation

This client does not invent a successful signature or silently switch databases.
The live Receiver must publish the device routes and must have a supported,
least-privilege adapter for GDGSigned/GDGWS in the existing account database.
At verification on 2026-10-28 the production Receiver still lacked those routes;
the protected native account database did not support the prepared extension
grant. No code outside GenDragoon was changed to weaken that protection.
The client intentionally remains at Step 2 when the service is unavailable.

The UI order is not a replacement for server authentication or a claim that
filesystem mounts establish cryptographic device identity.

## Tests

`WorkspaceSetupPolicyTests.swift` exercises ordering, missing/foreign/selected
workspace state, revocation, unmount, account validity, and every page gate.
The Mac CI job compiles and executes it after compiling the native sources.
