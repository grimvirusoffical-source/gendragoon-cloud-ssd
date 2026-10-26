# GenDragoon Cloud SSD User Guide 0.22

This guide describes the source for **GenDragoon Cloud SSD 0.22.0 build 36**, reviewed on October 26, 2026. Build 36 remains a development release candidate. A fresh source `60f9128` package passed signing, notarization, stapling and a real compiled-codec roundtrip; later shared Teams moderation changes still need a matching final package. The installed, previously verified Mac release is **0.21.0 build 35** until a separately verified build 36 installation replaces it. A source change, successful unit test, packaged download, or this guide does not establish that a candidate has been installed, published, or accepted by a store.

Build 35 already has unified source selection, the native library tree, folder organization, verified uploads and restores, and live upload progress. Build 36 adds the new Teams and Integrations pages, portable storage vaults, separate read-only MachineNote Finder drives, transfer credential renewal, and tighter application cache checks. Follow instructions for a new control only in a compatible build that actually contains it.

The advisory space policy and in-transfer renewal also require the new client. Build 35 can still report its older fixed reserve or access-expiry limitations; reading this guide does not update that installed binary.

A **MachineNote** is a named storage container belonging to a Red-XAI account. It holds files, complete folder backups, and application backups. Each hosted MachineNote has its own storage allowance, performance allowance, usage, and library. The active MachineNotes service uses Red-XAI storage; it does not require a Google account, Firebase project, or Google Cloud bucket.

Start with a small backup, retain the original, and test a restore. A successful test establishes that the tested item works with the tested client, account, keys, and service state. It does not guarantee every application, network, payment method, device, or future restore.

## Platform availability

The word **implemented** below describes the current source. A **candidate** still needs the corresponding build, native runtime, installation, transfer, restore, and release checks. Do not treat a capability table as a store listing or a statement that all platforms are available for download.

| Platform or client | Current status | Intended use and current limits |
| --- | --- | --- |
| Installed Mac build 35 | Previously verified signed and notarized Apple Silicon release | macOS 14 or later; hosted MachineNotes, verified files and complete Mac application backups, library organization, and upload progress. New build 36 controls are not supplied by build 35. |
| Mac build 36 | Fresh signed and notarized candidate; final shared Teams changes pending | Apple Silicon and macOS 14 or later. Compiled-only codec, current-account deletion controls and exact source checks passed their tests. Installation, native UI acceptance and the final matching backend remain pending. No Intel Mac package is declared. |
| Windows desktop GUI | Packaged x86_64 candidate; drive acceptance blocked | Actual native codec, IPC, GUI and packaged PE-host checks passed. The real WinFsp test mounted and read content, but safe normal unmount failed; the drive was retained. A separate GenDragoon mount helper is under test. Do not treat Windows drive mounting as ready. No Mac managed app launcher. |
| Linux desktop GUI | Packaged x86_64 candidate with actual read-only FUSE checks passed | MachineNotes Files, vault, queue and relay chat; actual native codec, IPC, GUI, mounted read, busy refusal and normal unmount passed for the tested source. Final installation, live-account restore and publication remain gates. Source installs require matching Python 3.13. |
| Android | Normal application-ID candidate passed actual API 36 emulators | Android 9 or later; arm64-v8a and x86_64 packages. Both actual 4 KiB and 16 KiB x86_64 six-test suites passed, including visual codec and dependencies, and all 190 packaged ELF files passed alignment checks. Physical ARM, full live-account/background/document-provider acceptance, upload signing and store review remain gates. No purchase or MachineNote creation button. |
| Chrome, Edge, Firefox, and Opera extensions | Actual Linux loading checks; companion candidates | Chrome, Edge, Opera and Chromium passed real native-messaging/IPC boundary tests; Firefox passed actual temporary load, reload and lint only. Opera's system-wide host registration was tested only on a disposable CI VM; the customer current-user Linux installer still refuses it. Signed store installation, native approval UI and live transfers remain unverified. |
| Local desktop VS Code | VSIX installed and activated in actual editor test | Its five commands and companion status passed the isolated host test. It still requires a locally running approved native companion. Full picker UI, live-account transfers and Restricted Mode acceptance remain separate. Browser-based VS Code and remote/virtual paths are not upload targets. |
| iPhone and iPad | Deferred until all other requested targets are finished and submitted | No maintained or tested iOS release or App Store submission is declared. iOS does not execute Mac applications. |

For the new source, the principal differences are:

| Capability | Mac build 36 | Windows and Linux GUI candidates | Android candidate |
| --- | --- | --- | --- |
| Hosted MachineNote files | Implemented | Implemented | Implemented |
| Complete folder selection | Native folder picker and metadata-preserving archive | Portable directory archive; platform restrictions apply | Android document-tree permission and archive |
| Optional original offload | Explicit Mac toggle after complete verification | Current GUI retains originals | Always retains originals |
| Library move copy rename and reference deletion | Native tree | GUI tree | No equivalent complete organization or storage deletion flow is declared |
| Read-only MachineNote drives | Native Finder flow | Linux FUSE tested; Windows safe-unmount gate still blocked | Not provided |
| Managed Mac application launch | Compatible Mac bundles after verified restore | Not provided by the current GUI | Not provided |
| Portable hosted-storage vault | Import and export | Import and export | Import and export |
| Teams | Relay chat and conditional direct WebRTC text chat | Relay chat; no peer-call/live-media UI in the Tk view | Packaged Teams UI; direct support requires device and network verification |
| Integration key management and BYO Red-XAI-DB UI | Implemented | Not presented as a current GUI feature | Not presented as a current feature |

An application package for another operating system can be stored as a file. Storage does not convert an `.exe`, `.apk`, `.ipa`, AppImage, or Mac `.app` into software that runs on a different platform.

## Prepare the Mac

Use the complete signed installation for the intended architecture and macOS version. The current Mac helpers use **Python 3.13 arm64** and the matching bundled codec, NumPy, and Pillow components. An arbitrary newer Python interpreter is not a substitute. If the runtime is missing, use the supported installer or ask the operator to prepare it; do not replace files inside the signed app.

Have an internet connection, a Red-XAI account, an available MachineNote, and enough local space for the selected operation. **Keeping 10 GB free is a recommendation, not a fixed admission threshold in build 36.** Work can proceed below that amount when its measured staging and verification needs fit. A real space shortage can still stop it.

The sidebar separates **Files**, **Applications**, **MachineNotes**, **Storage**, **Performance**, **Teams**, **Integrations**, and **Account**. The new **Finder drives** panel is on Files. **Portable storage vault** is on Account. Older or candidate clients can have different layouts; use the platform matrix before assuming parity.

## Make a first verified backup

1. Choose **Continue with Red-XAI**, approve the request on the expected Red-XAI browser page, and return to GenDragoon. Check the connected account in **Account**.
2. Open **MachineNotes**. Choose an existing active note or create one using the billing steps below. Refresh verified access if a completed checkout is not reflected yet.
3. Prepare a small disposable folder containing a text file and a picture. Keep its original in place.
4. Open **Files** and choose **Select Apps, Files or Folders…**. Select the complete folder and confirm **Select**. Command-click or Shift-click can select several apps, files, and folders together. There is no additional Add-to-tree step.
5. Check the **MachineNote on your Red-XAI server** destination and the new-selection folder target. Leave **Move originals to Trash after a verified cloud backup and restore check** unchecked.
6. Choose **Upload**. Keep the app open, the Mac awake, and the network available until the job reports **Succeeded** after verification.
7. Refresh the library if needed. Right-click the new entry and choose **Download**, then **Open**. Inspect the restored text and picture and compare them with the original.
8. Once the first Mac has working storage keys, use the build 36 **Portable storage vault** export before relying on another device for recovery. Test importing and restoring on the second device while the original working Mac remains available.

If an account already contains encrypted data and this device lacks its original keys, import its existing vault before attempting storage operations. Do not initialize replacement keys to try to make old data readable.

## Connect and refresh account access

Use **Continue with Red-XAI** at the connection screen or **Connect Red-XAI** on Account. Approve the displayed request in the browser. Do not type the website password into a MachineNote name or file field. Allow the expected GenDragoon Keychain request and verify the intended account before choosing a note or paying.

The Mac saves its app approval in Keychain. The app session is separate from browser sign-in and lasts until logout, revocation, or its 30-day expiry. A password reset or new sign-in does not recreate client encryption keys.

Build 36 gives long-running helpers a private renewal channel. On an expired short-lived access credential, the helper can request a replacement for the same account and operation. Renewal is bounded and fails if the native app disconnects, the account changes, approval is revoked, or renewal cannot complete. It does not make transfers independent of the app or guarantee that every interruption can resume. **Installed build 35 does not have this in-transfer renewal flow.**

Use **Refresh MachineNotes**, **Refresh MachineNotes and upload state**, or **Refresh verified access** after account or plan changes. Before disconnecting or switching accounts, finish transfers and cache work, close managed applications, and unmount all workspace drives. If mount status is unknown, resolve that status first. Changing an account does not retarget a retained job or substitute another account's vault.

## Hosted MachineNotes and billing

### Create a MachineNote

Open **MachineNotes**, enter a meaningful name, and choose Storage, Performance, and Billing. A regular account chooses **Create MachineNote & Open Checkout**. A verified included owner account sees **Create MachineNote · Included**.

One MachineNote fee is waived indefinitely for each regular account. That note still needs a storage subscription and a performance choice. Free performance is a one-worker option; it does not make hosted storage free. Additional MachineNotes add **$5 monthly** each, separately from storage and optional paid performance.

The fee waiver transfers to the oldest remaining note if its current note is deleted. A standard account permits 10 MachineNotes. The limit rises to 20 when the same active note has at least 2 TB of storage and Turbo performance or higher. Splitting those requirements across different notes does not qualify.

### Reference prices

The following USD prices match the current Receiver catalog source reviewed for this guide. They preserve the existing pricing and are not a new live payment test. The app's refreshed catalog and Stripe's checkout total, tax, proration, and subscription details control the actual purchase.

| Storage per MachineNote | Monthly | Yearly |
| --- | ---: | ---: |
| 100 GB | $6.40 | $64.00 |
| 200 GB | $9.60 | $96.00 |
| 300 GB | $12.80 | $128.00 |
| 500 GB | $20.00 | $200.00 |
| 1 TB | $36.00 | $360.00 |
| 2 TB | $72.00 | $720.00 |
| 3 TB | $104.00 | $1,040.00 |
| 4 TB | $136.00 | $1,360.00 |
| 5 TB | $168.00 | $1,680.00 |
| 6 TB | $200.00 | $2,000.00 |

| Performance | Verified transfer workers | Monthly | Yearly |
| --- | ---: | ---: | ---: |
| Free | 1 | $0 | $0 |
| Lite | 2 | $3 | $30 |
| Boost | 4 | $6 | $60 |
| Turbo | 8 | $9 | $90 |
| Ultra | 12 | $14 | $140 |
| Max | 20 | $19 | $190 |

Storage uses decimal GB and TB. Some local cache and working-space limits use binary GiB. Server usage counts stored encoded objects, which can be much larger than the original file.

**Yearly · 2 months free** charges ten monthly plan prices for one year of storage and performance. An additional note's $5 fee remains monthly. Additional notes can therefore need two checkout stages: plans first, then the monthly MachineNote fee. Return to GenDragoon and use **Continue Checkout** when offered. Both required subscriptions must be valid before upload access becomes active.

For example, the waived note with 100 GB and Free performance is $6.40 monthly. An additional note with 100 GB and Lite is $14.40 monthly. With annual plans, that additional note's storage plus Lite is $94 yearly, and its note fee remains $5 monthly.

Use **Storage** or **Performance** to select the note and review **Apply Plan Change**, **Choose Plan & Continue Checkout**, or **Apply Included Plan**, as applicable. **Manage Billing** opens subscription and invoice management. **Remove Ads · $4.99** is a separate one-time account purchase and supplies neither storage nor paid workers.

The server verifies current entitlements; returning from a payment page alone does not prove activation. A lapsed note can retain read-only recovery access while new writes require an active plan. Automated checkout, webhook, reconciliation, and isolation tests do not establish a successful live charge for every card, country, tax treatment, cancellation, or payment method.

### Owner visibility

The specifically authenticated and verified owner account, **support@infected-nation.com**, has the existing included plans, ad-free access, a 20-note limit, and 6 TB/Max defaults for new included notes. Typing that address into a field does not grant owner benefits.

**My MachineNotes** shows the connected account. The verified owner can use **View all accounts**, **Reload all accounts**, and **Load more accounts** to inspect paginated account and library metadata. This can expose names, types, sizes, plans, identifiers, and limited item previews. It does not provide another user's client decryption keys or a cross-account file restore permission.

## Select and upload apps files and folders

Both Files and Applications use **Select Apps, Files or Folders…**. Select complete `.app` bundles as atomic selections; do not select individual files from their internal Contents directory. Mixed multi-selection is supported. Select a complete local folder to include its nested files and empty directories.

Finder drag and drop or copying local items and choosing **Paste** populates the source selection. It does not immediately upload. Review the list and choose **Upload**. **Remove** removes one selection; **Clear selection** clears that source list. Neither action deletes originals or cloud items. **Browse local folders** is optional and is not a required extra step.

Choose the cloud target before selecting sources. Selecting a library Folder makes it the target for new selections; selecting a file uses its containing folder. No tree selection uses MachineNote root. Dropping local items onto a library folder records that target. You can also right-click a folder and choose **Select Apps, Files or Folders to Upload…**.

Each selection retains its target folder. A queued job records its account, MachineNote, source identities, and originals policy. Changing the highlighted cloud folder later does not retarget that selection or job. To change an unqueued source's destination, remove it from the source list, choose the intended destination, and select it again.

Avoid modifying selected sources during preparation, transfer, or verification. Unsafe links, unsupported metadata, changed files, unavailable sources, or a context mismatch can be refused. Selecting a folder and one of its children for the same target keeps the complete folder selection rather than uploading the child twice.

### Keep originals or authorize offload

The toggle is **Move originals to Trash after a verified cloud backup and restore check**. Leave it off for ordinary backups and initial testing.

When explicitly enabled on the Mac, GenDragoon uploads the encrypted archive, downloads it again, verifies bytes and complete restored content, checks the source again, and only then requests Finder Trash for the unchanged original. Quit the selected application and its running copies before offload. Launching it or changing its files during verification can prevent the final move.

A failure does not authorize manual removal of the original. A multi-item job can contain both successful verified offloads and retained failed items; inspect each item result. If Finder cannot confirm a move, inspect the original and Trash before retrying. Trash is not emptied automatically and does not free all occupied space until deliberately emptied.

An application backup contains the selected bundle, not all external application data. Licenses, browser profiles, Application Support data, saved games, login items, privileged helpers, extensions, and unrelated documents may need separate backup and migration steps.

## Organize the library tree

The native outline supports disclosure triangles, keyboard navigation, search, and Command/Shift multi-selection. **Find apps, files or folders…** filters the view while retaining parent context. Changing the search clears the selection. Refresh after another device changes the tree or an operation reports a revision conflict.

| Kind | Meaning |
| --- | --- |
| Folder | A virtual library folder created with **New Folder**. It organizes other library entries. |
| Folder backup | A complete local directory stored as one immutable archive item. Its archived interior is not rearranged by library move or rename. |
| Application | A complete Mac `.app` archive. Internal bundle files are not separate organization entries. |
| File | A selected file backed by an encrypted archive. |

Use **New Folder** or **New Folder…**, enter a unique name within the destination folder, and choose **Save**. Drag entries onto a virtual Folder to move them; hold Option to copy. Drop at the root to use MachineNote root. A folder cannot be moved inside itself or a descendant, and a Folder backup or Application cannot contain new library entries.

**Cut**, **Copy**, and **Paste**, or Command-X/C/V while the tree has focus, operate inside the same MachineNote. Cut prepares a move; it does not remove entries before Paste succeeds. Cross-MachineNote paste is refused. One organization action accepts up to 100 selected entries. A selected virtual parent includes its descendants for that operation.

Use **Rename…** or Return on one entry, then **Save**. Rename changes the library/restored label, not the original source or encrypted archive identity. Keep the `.app` suffix for applications. A copy can share the existing encrypted archive with its original. It is an additional reference, not necessarily another physically stored archive.

Library mutations require active write access. A read-only note still permits its supported existing downloads. Refresh and inspect the new tree before retrying a conflicting organization action; an automatic replay of an arbitrary move or deletion is not promised.

### Delete references and delete a MachineNote

For library deletion, select entries and choose **Delete…**. Check the confirmation's names, additional item count, and descendant warning before **Delete Cloud Items**. Removing a virtual Folder removes its nested library references.

**Library deletion retains encrypted archive objects for shared-copy safety and does not reclaim their quota.** It does not remove local originals. Retained payloads are not an ordinary undo feature, and the UI does not promise reconstruction of a deleted reference. Download an independent copy first.

To delete an entire MachineNote, preserve needed content, select its **Delete** action in MachineNotes, type its exact name, and confirm **Delete MachineNote**. This separate irreversible operation removes that note's encrypted server data and cancels linked subscriptions, including its separate fee subscription when present. Existing invoices and billing history are separate. Disconnecting, clearing cache, or removing a source selection is not MachineNote deletion and does not cancel billing.

## Restore open and launch on the Mac

Right-click a library item and choose **Download** to create its verified managed local copy. **Open** opens that copy; a compatible Mac application uses the managed launch flow. Multiple selected items can be downloaded as a batch. Existing changed or in-use caches are retained rather than silently overwritten or deleted.

Downloading a Folder backup restores its complete archived tree. Downloading a virtual Folder composes its current nested entries into one verified local folder. That composition is a snapshot, not a synchronizing Finder folder. Later local edits are not automatically uploaded. If the cloud composition changes, refresh and deliberately clear only an eligible unchanged old cache before rebuilding the snapshot.

The current hosted PNG archive path needs the complete backup downloaded and decoded before it can provide a verified application restore. It does not promise sparse app paging, instantaneous launch of a large app, or unlimited execution without local disk. The application still needs compatible macOS/CPU support, signatures, licensing, and any external dependencies.

Only one managed cloud application session is active at a time across MachineNotes. Close it and allow its helpers and cleanup monitor to finish before launching another. **Remove managed application cache after the app exits** requests eligible cleanup; it does not guarantee removal of changed or in-use files.

**Clear Managed Local Cache** removes eligible managed local content, not the cloud backup or original. Close a managed application before restoring a renamed/copied version, changing its cache name, or clearing cache. Preserve edits separately before cleanup; changed cache content is not automatically synchronized to the archive.

### Application cache budgets

Build 36 checks the complete-bundle launch fallback against its verified performance profile before downloading another app. Existing managed cache bytes count toward that budget, and the app does not silently delete other caches to make room.

| Performance | Current managed application cache budget |
| --- | ---: |
| Free | 2 GiB |
| Lite | 2 GiB |
| Boost | 3 GiB |
| Turbo | 4 GiB |
| Ultra | 6 GiB |
| Max | 8 GiB |

A sufficiently large app, or smaller app plus retained cache, can be refused even when the disk has more free space. Close applications, inspect retained data, and explicitly clear an eligible unused cache if appropriate. Do not infer that a cache-budget error means cloud data was lost or that this PNG-backed app can switch automatically to streaming.

## Mount several read-only Finder drives

Build 36's **Files → Finder drives** panel can mount separate owned MachineNotes at the same time. These are local read-only NFS views backed by authenticated GenDragoon helpers. They are not writable synchronization drives.

1. Connect the intended account, import its original vault if this is another Mac, and refresh MachineNotes.
2. Finish conflicting transfers or maintenance. In Finder drives, choose **Mount read-only** beside the intended note.
3. Wait for **Mounted**, then choose **Open**. Repeat for another owned note if needed.
4. Use GenDragoon's library controls for upload, move, rename, or deletion. Finder writes are refused. Restore applications in GenDragoon before launching them.
5. Close files and applications using a drive, then choose **Unmount**. Unmount retains verified local cache.
6. Unmount every workspace drive before disconnecting or changing accounts. If the state is uncertain, use **Refresh drive status** and resolve retained/orphaned status; do not force-unmount or kill guessed processes.

Directory metadata can be loaded lazily, but opening one file inside an archive can restore and verify that whole archive. It still needs local space and may be slow. The mounted directory tree is a snapshot; after another device changes it, refresh the native library and unmount/remount the view when necessary. A changed or removed archive can be refused instead of serving an unverified replacement.

Each Mac needs its own session and the matching original storage keys. Importing a vault does not share a login. Several Macs can restore the same account's data, while concurrent organization changes remain subject to revision checks. macOS can retain filesystem data in its kernel cache, which is why account switching is blocked while drives or uncertain mount state remain. This guide does not promise remote revocation erases bytes already read or copied locally.

## Read progress and handle interruptions

Jobs show **Queued**, **Running**, **Succeeded**, or **Failed** with completed item counts. The animated overall bar includes a counter such as **42 / 100** and a percentage. It reaches **100 / 100** only after verified completion. Uploaded chunks or a completed network send alone are not a successful backup.

Phase labels describe actual work: preparing/checking files, creating the archive, encoding barcodes, uploading, saving the archive index, downloading and decoding the verification copy, restoring it, verifying, optionally moving originals to Trash, and Complete. Phase bytes can reset between stages; the overall percentage does not move backward within the job. Sent/Received carrier bytes can greatly exceed original bytes.

**Estimating ETA…** is shown until enough work is observed. The UI can then show **Est. total remaining** or **About … left in this phase**. Encoding, network, disk, and verification rates vary. These are measured estimates, not deadlines.

**Estimated network time saved with N workers** compares overlapping observed requests with their estimated serial network time. It excludes the rest of the preparation and verification work and is not a guaranteed speedup over a separate Free-tier run. Worker counts are verified by the server; choosing a local number cannot grant a paid allowance. Encoding concurrency remains bounded.

Choose **Upload in background** or **Hide progress** to hide detail, and **Show progress** to reopen it. Browsing another page does not cancel or retarget the job. **Keep GenDragoon open and the device awake and connected.** Mac background upload means work inside the running app, not a guaranteed independent daemon after Quit, force quit, or sleep.

Use **Start queued uploads** when waiting work is ready. **Cancel queued upload** can cancel a job before it starts. The current Mac flow does not expose an ordinary cancel-running button. Do not use guessed process termination as normal cancellation.

The transport has bounded retries for eligible network failures, busy allowances, and immutable chunk transfers. It can reuse matching verified chunks and renew eligible credentials. It does not retry forever, replay every metadata mutation, bypass certificate errors, fix changed sources, or guarantee automatic restart after a process interruption.

After failure, retain originals, read each item result, refresh account/note state, confirm disk and cloud capacity, and retry deliberately with offload disabled while diagnosing. A retained selection or queue record is not proof that the cloud backup completed. Incomplete uploads can leave chargeable encoded objects without a published library item. Repeated new copies can add more retained bytes; the UI provides no general orphan-object garbage collector.

## Plan local space and encoded usage

**10 GB free is advisory in the new flow.** Mac upload/restore checks measure required working copies and add a bounded filesystem margin; they permit operations that fit below the recommendation and refuse actual shortages. Upload preparation can need roughly three times the source's file bytes plus archive/metadata overhead for staging and full restore verification. Available space changes while other applications run, so the preflight is not a reservation of physical disk.

Offload must prove the remote restore before removing the original, so the original and verification copies can coexist. Removing a source after selection, enabling offload, or hiding progress does not eliminate staging needs. Cache budget, source/archive size, server quota, and disk capacity are different limits.

The current archive format uses 64 KiB plaintext chunks and genuine visual red-X PNG carriers around encrypted bytes. A measured 64 KiB example produced about 5.8 MB of PNG data. The observed expansion is roughly 89 times that chunk, not a universal ratio or a capacity promise. Compression, metadata, and manifests affect totals. A 100 GB encoded-object quota is not room for 100 GB of arbitrary original files.

Logical subscription quotas also do not provision physical disks. The service operator must maintain enough actual storage and backups. No historical server free-space snapshot is a customer capacity guarantee.

## Export and import a portable storage vault

The portable vault carries the hosted MachineNotes storage secret and encrypted private keymap for the same account. It contains no account access/refresh credential, integration API key, or BYO database credential. Possessing an integration key or signing in is insufficient to decrypt old backups.

### Export from the working device

1. Use a build with **Account → Portable storage vault** and connect the intended account.
2. Finish transfers, close managed apps, and unmount drives. The working device must already have the keys and keymap that encrypted its existing data.
3. Enter a strong **Vault passphrase · at least 12 characters**, then repeat it for export. The implementation counts Unicode code points and permits at most 1024 UTF-8 bytes.
4. Choose **Export encrypted vault…** and save the `.gdvault` file somewhere you control. Only the encrypted envelope is written.
5. Keep its passphrase separately. Test the second device while preserving this working installation and an independent readable backup.

### Import on another device

1. Install a compatible client and connect the **same** Red-XAI account. Signing into a different account cannot retarget this vault.
2. On Mac, open Portable storage vault, enter the passphrase, and choose **Import encrypted vault…**. Candidate desktop/mobile clients provide their corresponding vault controls.
3. Select the exported file and wait for decryption, account binding, and read-only native keymap validation. A different existing local key or keymap is refused instead of overwritten.
4. Restore a small known backup and compare it with the original before depending on that device for recovery.

The shared v1 envelope uses AES-256-GCM and PBKDF2-HMAC-SHA256 with 600,000 iterations and fresh random salt/nonce. That describes the wrapper, not an independent security audit. Hardware-bound KXAI v4 keymaps and unsupported keymap costs/formats are refused; this is not a tool for removing device binding. Do not delete existing keys to bypass a conflict.

On a genuinely empty account, a compatible client can initialize its first keys only after server verification of emptiness. This does not recover an existing encrypted account. If the vault, its passphrase, and the working device are lost, account support, owner metadata access, or a paid plan cannot reconstruct the missing decryption material.

## Use workspace Teams

Teams is collaboration metadata. A teammate can participate in the team but gains **no permission to browse, upload, download, delete, decrypt, administer, bill, or create keys for another person's stored files**. A team invitation is different from an integration storage key and from a portable vault.

### Set a username and create or join a team

1. Choose the intended MachineNote in the native Files destination controls, then open **Teams**.
2. Read and explicitly accept the displayed **Community rules**. Then under **Your chat identity**, choose a Username and **Save username**. Use 3–32 characters, beginning with a letter, followed by letters, digits, underscore, dot, or hyphen. Names are checked case-insensitively for availability.
3. To start that note's team, choose **Create team for selected workspace**. Teams are separate for different MachineNotes.
4. To join someone else's team, save your own username first, paste their token into **Join with an invitation**, and choose **Join**. Joining does not provision hosted storage or import file keys.
5. Open the team from **Your teams**. Use **Load more teams** or **Load more teammates** when the view offers another page.

### Invite revoke remove and leave

The owner or an authorized team administrator can choose **Create single-use invitation**. The UI shows the token once; share it privately with the intended person, then use **Hide invitation**. The default invitation lasts 72 hours and permits one account to join.

Use **Review invitations**, **Load more invitations**, and the displayed revoke action to revoke an unused or unwanted invitation. Revoking a link does not remove someone who already joined; use **Remove teammate** and confirm the intended username. A removed member cannot continue using team routes, and old queued signaling is not reused after a new membership generation.

The owner cannot leave their own team through **Leave team**. Other members can choose **Leave team** and confirm. Administrator permissions are narrower than ownership; an administrator cannot remove the owner or another administrator. Interface controls can vary by client, so do not assume that every backend role-management endpoint is exposed as a button.

### Group relay and direct peer chat

Choose **Team group chat** to send text through the Red-XAI server relay. Messages are limited to 2000 characters and expire after seven days; physical cleanup is opportunistic during later service requests. This relay is not described as end-to-end encrypted file storage. Team participants and the service can handle the relayed message data.

Presence expires after 45 seconds without renewal. Signaling packets expire after two minutes. Presence or a successful signaling response does not prove a direct connection is established.

On a client with WebRTC support, choose **Connect directly** beside a teammate, wait for an actual connected state, then select that Direct conversation. The shared UI permits up to eight simultaneous direct connections. This limit is separate from membership and paginated group chat, which have no configured total member cap. Service request rates and page sizes still apply.

Direct chat is text in the current view. It is not a durable message archive, file transfer, remote command channel, screen sharing, camera call, or microphone call. Closing the view or app can end it. **No TURN relay is configured.** NAT, firewall, browser, WebView, device, and network conditions can prevent direct connections; group relay remains a separate feature. Test an actual cross-client connection before claiming direct chat works on that device/network.

### Community rules, reporting and blocking

Before setting a username, creating or joining a Team, sending text or starting a direct connection, read the displayed **Community rules**, select **I have read and agree to these community rules**, and choose **Accept current rules**. Acceptance records that account's current policy version and time. A later policy version requires fresh acceptance. Until then the participation controls stay disabled.

To stop interacting with someone in the selected Team, choose **Block user** beside that teammate and confirm the intended username. This immediately closes your existing direct connection and removes their displayed text. The service restricts relay messages, presence, signaling and fresh peer leases in both directions for that Team. Supported clients revalidate before direct sends and incoming text, plus periodic checks; an offline client cannot learn a block instantly. **Unblock user** explicitly removes your block, after which a new direct connection can be requested. It does not restore the severed connection or erase independent copies.

Choose **Report user** beside a teammate or **Report message** on a displayed message. The report panel shows the target and any chosen message. Select a reason, add optional context without secrets, and review the content before **Submit report**. Relay reports send a reference which the server checks against the actual Team message and author. For a direct conversation, the server does not already hold that text: the separate **Include this displayed direct text as my unverified report evidence** checkbox is off by default. Leave it off to send a user report without the excerpt. Submitted direct text is labeled reporter-provided and unverified. The optional service-owner review checkbox requests escalation; a report about a Team owner is escalated automatically. Keep the returned receipt identifier.

A Team owner uses **Review team reports**, selects **Review**, reads the evidence and preserved history, then records a decision. **Take moderation action** requires a matching action such as removing the reported teammate or hiding the reported relay message, followed by confirmation. Ordinary Team administrators and peers cannot browse the report inventory. The verified service owner separately uses **Review service reports** and can disable an abusive Team. A Team-owner decision cannot erase the report or the service owner's independent review. These controls grant no file, key or billing permission.

Reports and review records become eligible for physical cleanup 30 days after submission. Cleanup is bounded and happens during later report access; this is not an exact erasure deadline. Covered account deletion also removes the associated report and block records while preserving unrelated accounts. Recipients can retain their own independent copies.

The isolated browser test delivered **400/400** ordered messages with zero duplicates and verified existing-connection block closure, explicit unblock reconnection and membership revocation. It establishes a same-device direct path; it does not establish internet NAT/TURN reachability.

## Create scoped integration keys

The Mac build 36 **Integrations** page separates keys for paid hosted MachineNotes from connections to your own Red-XAI-DB host.

1. Under **Integration API keys for one MachineNote**, enter a Key name, choose a supported Service and one owned MachineNote.
2. Leave **Allow uploads and file changes** off for read access, or enable it deliberately for read/write storage operations.
3. Choose **Create API Key**. Copy the one-time secret into the intended native application's secure credential store, then choose **Done**. The server stores its hash and cannot show it again later.
4. Review the key's service, scopes, MachineNote, and expiry. Use **Revoke** and confirm when access is no longer needed. Create a replacement rather than searching logs for a lost secret.

Keys expire after 90 days and are limited to one approved service and one MachineNote. Up to 20 active keys are supported. They cannot grant billing, owner/admin, Teams, key-management, or another note's file rights. Current trusted entitlement proof is required for use, and write access still requires active storage. A storage key supplies access to encrypted carriers, not the encryption secret/keymap.

The service label does not attest which program is presenting a copied key. Treat the secret as a bearer credential: anyone who obtains it can attempt its permitted operations until revocation or expiry.

**Create Connection Grant** produces a five-minute, single-use grant for a compatible requesting application. S256 connections use a one-time code bound to the approved scope and state. A link claiming an application name is not proof of that program's identity. Review **RottenApple connection request**, the selected note, and **Approve Selected Storage** before approving; **Decline** grants nothing.

The storage delegation is separate from an administrator login. Immediate account-ban/deletion or changed owner-email propagation requires the service's configured status/event integration; without that integration, explicit key revocation, expiry, or ledger synchronization is the enforcement boundary. Do not assume an unrelated browser logout revokes every delegated storage key.

### What other programs actually support

Other programs were not modified by this work. The service catalog distinguishes an available GenDragoon API from a complete external application feature.

| Service | Verified contract boundary |
| --- | --- |
| Red-XAI-DB | Actual database-scoped pack APIs and GenDragoon's BYO adapter are implemented. The reviewed external RedX program does not implement general external-provider grant redemption. |
| RottenApple Store and Shop | The unchanged client can pair through the supported S256 exchange/revoke contract. Its launcher currently rejects `data.storageBind` locally as unavailable. Pairing therefore does not supply working Store/Shop file binding. |
| Quick Launcher | The existing grant redemption and health contract is supported. The reviewed client has no demonstrated Receiver file-transfer consumer. A successful health check is not an integrated cloud file workflow. |
| Red-XAI Host | No verified storage integration contract is declared ready. |
| RottenCore | An installer contract is known; cloud storage integration is not declared ready. |
| PoisonApple | Required storage contracts are not verified. |

Legacy provider blob/manifests and manifest CAS are not advertised as implemented by the compatibility endpoint. An API key, catalog badge, or completed pairing cannot bypass a missing feature in an unchanged external program.

## Connect your own Red-XAI-DB storage

**Your own Red-XAI-DB workspace** has a **$0 GenDragoon hosting fee**. Bytes stay on the host you choose in its actual `.red-xai-pack` storage. Its operator's storage, traffic, quota, and hosting charges still apply. This separate connection is not a free entitlement to paid Red-XAI hosted MachineNotes.

1. Obtain an HTTPS origin, database name, pack name, and database-scoped read or write key from your RedX operator. Use the exact database and pack intended for GenDragoon. Host administrator keys are refused.
2. In Integrations, expand **Connect a scoped RedX database key**. Enter Connection name, HTTPS host origin, Database, and Pack. The origin is the host, without a user/password, arbitrary path, query, or fragment.
3. Where the host supports it, choose **Start RedX S256 Connection…**, approve in its console, and use the returned code with **Exchange Code**. Alternatively supply an existing database-scoped key in the secure field.
4. Choose **Verify and Connect**. GenDragoon probes the actual host and scope before saving the connection. Redirects and unsupported host encryption-policy packs are refused rather than weakening validation.
5. Choose the **BYO workspace**, then **Upload Apps, Files or Folders…**. The native UI retains originals and verifies remote readback and the full restored content before publishing a successful encrypted backup.
6. Under **Encrypted GenDragoon backups**, choose **Restore…** and select a parent destination. An existing conflicting target is retained; it is not overwritten.
7. Use **Raw database pack files**, **Root**, **Up**, **Open**, and **Download…** only when you intend to browse existing host files in their current format. Raw PNG carrier downloads are not the original documents or application.

GenDragoon's encrypted archive objects use their own namespace in that pack. Discovery records contain metadata; contents and snapshot manifests use the pinned existing encryption and visual carrier APIs. The UI does not silently convert other programs' existing raw files into encrypted GenDragoon archives or decode unrelated formats.

The external API key and an independent encryption secret remain in this Mac's Keychain; the paired keymap stays private to this connection/account. **The hosted MachineNotes portable vault does not currently export BYO connection keys or BYO encryption material.** Before erasing or moving this Mac, arrange and verify separate BYO recovery while the working installation remains available. The external API key alone cannot decrypt its archives.

**Disconnect…** removes saved connection metadata while retaining external data and recovery credentials. It does not delete the host's pack, reclaim its physical chunks, or necessarily revoke the external key; use the host's explicit key controls when revocation is needed. The native BYO browser does not promise general recursive move/rename/delete or cloud garbage collection. Failed uploads may retain incomplete objects. Mutable pack writes use separate upload namespaces; they are not a host-wide manifest-CAS or arbitrary concurrent file synchronization system.

## Use browser and VS Code companions

An extension is useful only with a compatible **installed and running native GenDragoon companion**, the intended account connected, the exact client enabled, and local owner approval. An extension ZIP or VSIX does not install or start the account/storage service by itself.

The browser clients can show connection status, list owned MachineNotes and completed file metadata, open Teams, and ask the native app to select a file or folder for upload. They cannot supply arbitrary local paths. VS Code can send only paths you explicitly choose in its local picker; the native app validates and confirms them again. Offload stays off. **Queued** is not **Succeeded**; inspect the native verified job before removing an original.

Restore, app launch, offload, library organization, storage deletion, billing, integration key management, and encryption-key operations remain in native GenDragoon. Large library responses can exceed the bounded companion frame; use native Files rather than assuming an incomplete extension listing is complete.

### Browser setup for a candidate

1. Obtain the correct reviewed browser package and a matching native build. Open GenDragoon and connect your account.
2. For development testing, extract the package to a stable location and use that browser's developer extension manager to load its manifest. Firefox temporary add-ons end when Firefox restarts; normal signed distribution is a separate step.
3. Copy the actual installed Chromium extension ID, which is 32 letters from `a` through `p`. Development/store IDs can differ, and moving an unpacked directory can change its ID.
4. Use the reviewed native-host installer or the candidate desktop client's **Storage keys → Configure browser/editor access** to enable exactly those installed IDs. Enable Firefox or VS Code explicitly when wanted. Supply the complete intended client set when replacing the allowlist; do not use wildcards.
5. Open the extension, approve that client in GenDragoon for the current account, and choose **Refresh connection**. If access is denied, fix the exact client registration or approve it locally; the extension does not bypass denial.

Current browser packages request native messaging only, with no page injection, content scripts, website host access, or remote JavaScript. Exact IDs identify configured clients; they do not attest against every process already running as the same local OS user. Native local-user checks and account-scoped approval remain necessary.

The current-user Linux installer refuses Opera because its documented native-host location is system-wide. The actual Opera CI test created and removed only its exact host manifest on a disposable VM; this does not provide or authorize a customer system installer. Windows needs the real packaged PE native host. Account changes require fresh approval for the intended account.

### Local VS Code setup

Install the reviewed VSIX using **Extensions: Install from VSIX…**, enable VS Code in the native-host configuration, and keep the native app open. The command palette provides:

- **GenDragoon: Check Local Companion**
- **GenDragoon: Browse My MachineNotes**
- **GenDragoon: Select Files to Upload**
- **GenDragoon: Select Folder to Upload**
- **GenDragoon: Open Developer Teams**

Uploads require a trusted local workspace and explicit selection. Remote/virtual URIs and browser-based editor execution are not supported. No teammate message or direct WebRTC packet is an upload or shell command. Uninstall through the browser/editor manager; remove only the GenDragoon native-host registrations you enabled when no clients need them. Do not delete account, keymap, upload, or cache data as extension cleanup.

## Candidate desktop and Android usage

The Windows/Linux **current GUI** is the MachineNotes Files and Teams client, not the retained legacy v3 command-line prototype. Do not use old cloud commands or raw provider-bucket instructions to infer support for today's encrypted MachineNotes.

Source desktop installations require matching Python 3.13 with Tkinter and the trusted runtime/dependencies. Actual Windows and Linux standalone codec, private IPC, GUI and packaged-host tests passed; final installation, live-account transfer and publication remain separate gates. The installers use current-user locations and do not elevate or relax PowerShell policy. GUI credentials stay in process memory and are discarded when the app closes. Explicit editor jobs are durable but can resume only with the same account and original vault available.

The GUI retains originals, verifies complete restores, and uses new destinations. Mac extended attributes, symbolic links, and application bundles require their compatible original-platform restore client; portable restores do not manufacture equivalent Mac metadata. Current Tk Teams provides relay chat, not peer calls or live media. Its retained older CLI's portable-app lifecycle is not a declaration that the new GUI implements the Mac managed launcher.

On Android, connect Red-XAI through browser approval, refresh existing MachineNotes, import the matching portable vault, and select documents or a complete folder through Android's document picker. WorkManager stages the selection and verifies a full cloud readback before success. Originals always remain. Restore first verifies in private storage, then lets you explicitly export verified bytes. Folder and Mac application backups can be exported as intact archives; Android does not execute Mac applications or recreate a Mac installation.

The Android candidate has no Stripe checkout, purchase link, MachineNote creation, automatic original removal, ordinary cancel-running UI, individual server-item deletion, or garbage collector. Its current-account deletion control has strict receipt/identity and preservation tests; a live account has not been deleted for testing, and the matching backend is not yet active. Disconnect is separate from account deletion. The normal app-ID candidate passed build, lint, JVM tests, both actual API 36 4 KiB/16 KiB six-test instrumentation suites and all 190 native ELF alignment checks, including the numerical, font, JPEG and encrypted visual-codec dependencies. Physical ARM execution, process death, background/foreground work, real credential renewal, document-provider behavior, low-space recovery and store signing remain acceptance gates.

## Cleanup updates and troubleshooting

**Cleanup Drive** organizes a deliberately chosen local folder. Choose **Choose Folder…**, **Preview**, review every move, then **Organize N Items…** and **Organize Reviewed Items** only when correct. **Undo Last Cleanup** uses its receipt for eligible unchanged moves; later edits can prevent safe reversal. This is not server garbage collection or quota cleanup.

**Disconnect GenDragoon from Red-XAI** ends that app session while retaining cloud data and private storage keys. It does not cancel subscriptions. **Reset App** refreshes/restarts the app while preserving its data and credentials; it is not a factory reset or key recovery. Let protected operations finish and unmount drives before updates, restart, or logout. Install a complete verified release rather than editing helper files inside the signed app.

| Symptom | Next steps |
| --- | --- |
| Missing note or Read only | Check account, refresh notes/access, finish every required checkout, and inspect current plan status. Do not create duplicates just because a view is stale. |
| Vault import needed | Use the original working device's vault for the same account. Do not generate different keys, delete a keymap, or assume a new sign-in decrypts old files. |
| Immediate offload refusal | Quit the selected app and its running copies, or turn off the Trash toggle for a retained-original backup. Inspect item results before another attempt. |
| Long-running job | Show progress and inspect phase, bytes, objects, ETA, disk, and network. Encoding/readback may dominate. Avoid launching repeated copies of the same uncertain job. |
| Credential or network error | Keep originals, check approval/network, refresh deliberately, and retry only after reviewing the retained job. Build 36 renewal is bounded; build 35 has the old in-transfer expiry limit. |
| Cache budget or changed-cache error | Close apps and inspect existing caches. Preserve edits and explicitly clear only eligible unused content. Free disk alone does not bypass a profile's managed-launch budget. |
| Finder unmount or account switch blocked | Close users of all drives, refresh drive status, and unmount normally. Retained/unknown state needs inspection; do not force removal or terminate unrelated processes. |
| Direct chat fails | Check an actual connected state and try group relay. There is no configured TURN relay to solve every NAT/firewall restriction. |
| Extension companion unavailable | Verify matching native build, app running, correct account, exact installed IDs, native-host registration, and local approval. A shim alone is not the storage app. |
| BYO pairing succeeds but files do not bind in another app | Consult the actual service limits. RottenApple's storageBind feature and other missing external consumers cannot be supplied by an API key or health response. |

For help, record the app version/build, platform, MachineNote or connection label, job state, phase, and displayed safe error. Do not share account tokens, API keys, invitation secrets, portable vault passphrases, keymaps, screenshots containing credentials, or private support directories. The existing operator contact is **support@infected-nation.com**. Owner access and support do not replace an independent readable backup or lost decryption keys.

## Read-only drives on desktop candidates

On a compatible Mac build, select the MachineNote in Files, choose **Mount drive**, and wait for a verified mounted state before opening Finder. Each mounted note has its own identity and verified private cache. More than one note can remain mounted; select the appropriate mounted note explicitly.

The Linux candidate uses a real read-only FUSE drive through a separately installed trusted rclone and FUSE runtime. Connect the intended account and vault, select its MachineNote and use the candidate's mount control. A verified cache directory alone is not a mounted drive. This flow passed actual Linux mounted reads, busy refusal and normal unmount for the tested candidate.

Before switching accounts, changing keys, disconnecting, quitting or updating, close every application and terminal using the mounted drives, select each drive and choose **Unmount**. If it is busy, close its users and retry normally. Never force, lazy-unmount or terminate the drive process to bypass a refusal. A retained or unknown mount needs inspection.

The Windows candidate's actual WinFsp test mounted and read data but failed normal safe unmount. Its guard retained the drive. A separate GenDragoon mount helper is being tested; Windows drive mounting must remain unavailable until that helper passes the real open-file, duplicated-handle, mapped-file, directory and concurrent-open tests. A passing general Windows GUI test does not settle this drive gate.

## Permanently delete a GenDragoon account

This is optional and irreversible once the server accepts the request. It applies only to a compatible current client and backend; it is not a troubleshooting step for a failed upload.

1. Export and independently verify anything you need to keep, including the correct portable vault if required. Check the connected account carefully.
2. Let all uploads and restores finish. Close managed applications and normally unmount every workspace drive. The client and server refuse active or unknown protected work; deletion does not stop it for you.
3. On Mac, open **Account → Delete GenDragoon account…**. On Android, choose **Delete GenDragoon account…** in the connected account view.
4. Read the scope. Type **DELETE GENDRAGOON** exactly, then choose the displayed request action only if permanent deletion is intended. Associated GenDragoon subscriptions are canceled as part of the verified workflow.
5. Keep the saved request. **Queued**, **Running** and **Failed** retain local keys and do not mean deletion completed. Use **Check deletion receipt** or **Retry same deletion request**; do not create another request to bypass a conflict.
6. You may close the app and resume later. If approval expires, use **Approve same Red-XAI account** on Mac or the corresponding same-account approval on Android. Recovery deliberately avoids creating a new Receiver.
7. Only a matching **Completed** receipt authorizes the client's exact account cleanup. Mac removes that account's keymap, storage/auth Keychain entries and matching profile. Android removes its matching vault/session and attributable prepared job copies. Other accounts and original files remain.
8. Mac shared managed caches and saved selections/jobs without reliable account attribution are retained for explicit review. Other devices, recipient copies, exported files, independent backups and BYO database bytes are outside this cleanup.

The workflow removes active GenDragoon encrypted server payloads and covered account, integration and Team metadata. It does not delete the external Red-XAI identity or erase independent Stripe transaction history. A minimal pseudonymous tombstone and receipt remain to prevent old credentials silently recreating the account. If billing or local cleanup needs review, retain the receipt and contact support without sending secrets.

A request can also be made through the public [account-deletion instructions](https://api.red-xai.com/gendragoon/account-deletion) after that compatible backend is activated. A support email request is separate from immediate verified completion.

## Store and release checklist for the operator

This section is a release checklist, not a statement that anything has been submitted or approved. Recheck platform policies at submission; policies, regional billing rules, account requirements, and review decisions change. The official links below were checked for this guide on October 26, 2026.

### Evidence for every distribution

- Record the exact source revision, app version/build, artifact hashes, platform/architecture, test results, and known limits. Verify the installed artifact separately from source and CI output.
- Test fresh install, account approval and revocation, same-account vault migration, real upload/readback/restore, wrong-account denial, interrupted work, expiry/renewal, read-only entitlement, disk pressure, and preservation of originals/changed cache. Keep live payment tests distinct from fixture tests.
- Test uninstallation and data retention explicitly. Provide reviewed privacy, support, terms, retention, account-deletion, and billing explanations matching what the client actually does. Do not label disconnect or Reset App as account deletion.
- Include required license/notice files, including statically linked compiler runtime notices. Public build inputs may contain approved compiled runtime bytecode/binaries; exclude the private encryption repository source, other private program source, credentials, signing material, vaults, and build directories from public artifacts.
- Publish accurate screenshots and feature claims for each platform. State that browser/editor packages require the native app. Do not advertise unsupported app execution, unlimited cloud capacity, guaranteed speed, automatic recovery, or completed external-program storage binding.

### Mac distribution

Verify the exact Developer ID signature, hardened runtime/entitlements, notarization receipt, stapling, Gatekeeper assessment, version, and checksum of the delivered app/package. Test the Python/dependency setup on a clean supported Mac, plus Finder mount/unmount, account switching, managed app lifecycle, and native companion approval. A direct notarized release is separate from Mac App Store acceptance. Any App Store submission needs a reviewed sandbox/runtime/entitlement design and applicable payment/privacy choices under the [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/).

### Android and Google Play

Keep the candidate unpublished until debug/release builds, lint/unit checks, actual embedded codec and graph instrumentation, both supported ABIs, real transfer/restore, and relevant background execution tests pass. Audit the entire APK/AAB native dependency set and test a real 16 KiB environment according to [Android's page-size guidance](https://developer.android.com/guide/practices/page-sizes). Resolve the dependency compatibility gate; aligned `librsx.so` files alone are insufficient.

Prepare the owned signing identity/upload key, current Play target-API and release requirements, Data safety answers, privacy/support URLs, account-deletion process, permission explanations, content rating, and required testing-track access. The current client intentionally omits purchasing and external Stripe links. Any later purchase flow needs a separate current Play policy decision; do not insert the Mac checkout experience into Android by assumption.

### Browser stores

For each browser, test the real packaged extension with the matching native host on supported operating systems, the final installed/store ID, denied approval, logout, stale companion, large inventories, and direct-chat limitations. Replace development IDs with the exact approved distribution IDs without adding wildcard origins.

Confirm publisher ownership, final version, single-purpose description, companion dependency, screenshots, privacy/data-use declarations, permission justification, license/source requirements, and reviewer installation instructions. Chrome's [Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies), [Edge's publishing process](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension), and [Mozilla's Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/) are separate review paths. Firefox development loading is not signed distribution. Review Opera's current developer submission process and preserve the documented Linux native-host limitation rather than claiming cross-platform parity.

### VS Code and other desktop distribution

Verify the actual local VSIX commands, native host executable, current-user permissions, trusted-workspace handling, explicit selections, account changes, and queue completion. Confirm control of the `redxai` publisher and the package identity; a manifest string does not establish Marketplace ownership. Follow the current [VS Code publishing instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension), provide the companion setup steps, and keep publishing credentials out of artifacts and logs.

Windows/Linux executable candidates need their own native runtime/IPC/GUI tests, notices, checksum delivery, and platform-specific signing/update/install decisions. Do not present Mac notarization or host-side cross-compilation as Windows execution evidence. iOS remains deferred until an actual client and its architecture, vault/restore flow, signing, privacy, and store decisions are implemented and tested.

## Further reference

The source distribution's [integration contract notes](RedXCloud/INTEGRATIONS.md), [desktop candidate notes](Desktop/README.md), [Android candidate notes](Mobile/Android/README.md), and [companion setup reference](Extensions/README.md) contain technical details. Their legacy examples and candidate sections should be read in context; this guide's platform matrix identifies the current supported flow and outstanding gates.
