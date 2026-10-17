# GenDragoon 0.18 — source review notes

**Status:** source candidate. Build 24 signing, installation, and installed automatic-update acceptance are still pending. These notes describe implemented code and completed component checks; they do not certify a finished deployment or purchase flow.

## Files and Applications

Files and Applications now have separate sidebar pages. Files provides project selection, file/folder upload and drop targets, search, category filters for Files, Folders, Videos, Audio and Pictures, grid/list views, downloads, and verified replacement uploads. The shared customer model lives above page navigation so changing pages does not discard an active transfer.

Complete folders are scanned and packaged automatically. The package contains a bounded manifest and a metadata-preserving archive, including nested and empty folders, zero-byte files, executable bits, relative links and recorded macOS extended attributes. Local absolute source paths and mutation guards stay in private preparation receipts. Cloud upload is followed by a separate download and a full restore check. The optional originals checkbox permits moving the exact unchanged source to Finder Trash only after those checks pass. Existing restore destinations are protected against replacement; an explicit cloud-item update retains the previous cloud copy until the new copy is verified.

The connected Google Cloud library remains distinct from each product project's private file index. Existing connected files and folders appear in Files; managed Mac applications appear in Applications. “Scan Selected Bucket” reads that connected destination and does not import arbitrary bucket objects into a product project. Compatible managed applications retain the existing launch, preload, restore and cache lifecycle. Modified or in-use application caches remain protected.

Primary sources: `Sources/GenDragoonCommercialUI.swift`, `Sources/GenDragoonCustomerCloud.swift`, `Sources/GDNativeWorkspace.swift`, `Sources/ProjectUploadSection.swift`, and `Resources/gendragoon_project_files.py`.

## Projects, plans and saved settings

Files, Storage and Performance share the selected product project. Choices and view/transfer preferences are scoped to the authenticated account and project. Storage and performance activation target existing projects; intended selections and entitlement state are retained through the billing APIs. An unavailable or inactive saved project is shown explicitly instead of silently switching its destination.

The server enforces one lifetime free project and a one-time $5 fee for each additional new project, with the authorized owner fee waiver handled by server policy. The default cap is 10 projects. It rises to 20 when the account has a qualifying active, provisioned project with at least 2 TB storage and Turbo performance (8 workers), including a qualifying bundle. Pending payment/capacity states remain visible.

Project removal is **Archive Project**: it retains files and underlying cloud resources. Existing subscriptions continue until cancelled in billing; the archive flow requires acknowledgement when billing continues. Restoring a project is cap-checked and does not create a new-project fee.

Primary sources: `Sources/GDProjectPreferences.swift`, `Sources/GenDragoonStripePurchases.swift`, `Backend/projects.js`, and `Backend/transfer_v3.js`.

## Transfer performance and automatic updates

Transfers use the server-authorized worker allowance. Chunked large-file transfers and bounded batches of small files share an aggregate worker budget; batching does not multiply that allowance. Data saver reduces concurrency. Downloads retain the 10 GiB local free-space reserve, including reservations for concurrent downloads. Resume checkpoints are tied to file/version and chunk metadata, with checksum verification before promotion.

Native performance tuning receives a short-lived account token and selected project through private stdin, not command-line arguments or saved credentials. The helper validates the server allowance and uses verified TLS; unavailable performance configuration falls back to the basic allowance.

The updater checks at startup and every 20 minutes. Stable is the default channel; preview releases require opt-in. Verified updates are prepared and handed to an independent restart worker, with installation deferred while protected operations are active. The UI shows progress and status without a manual restart button. The operation gate distinguishes ordinary work from exclusive maintenance so an idle persistent mount does not falsely disable uploads.

Primary sources: `Sources/GDTransferClient.swift`, `Sources/GDTransferBudget.swift`, `Sources/GDNativePerformance.swift`, `Resources/gendragoon_performance.py`, and `Sources/GenDragoonAutoUpdate.swift`.

## Completed validation

- Project-package regressions: **16 passed**. Coverage includes complete-folder roundtrip, empty files, source mutation, corrupt readback, offload authorization, destination protection, manifest/header validation, private-path exclusion and changed-cache retention.
- Metadata regressions: **21 passed**, including opening every ZIP member to validate its local header before native extraction.
- Actual macOS project-envelope gate: **4 cases passed in 0.381 seconds** — folder, empty file, metadata-bearing file and application bundle. Production preparation, separate readback, verification and restoration preserved attributes, executable bits and relative links; source mutation blocked offload.
- Actual Swift transfer-budget checks: **6 passed in 1.669 seconds**. The initial 40-file Swift source snapshot compiled successfully; the final signed build still needs its release gate.
- Real GCS fixture measurement: **168 SHA-256-verified roundtrips** across 7 worker settings. All generated cloud objects were removed. Observed throughput varied by setting; it did not increase monotonically.

## Remaining acceptance and limits

Higher concurrency can improve throughput, but it does not guarantee a fixed speed or multiplier. Connection conditions, object size, source disk speed, preparation and restore verification can dominate a transfer.

The new project-envelope gate proves the local production archive pipeline; it does not replace an authenticated full-app upload/download acceptance test against the deployed candidate. Project application backups restore complete bundles. Managed application launch/streaming uses the connected native Google library and has not been proven for every application or platform. A large commercial application's streamed launch and full lifecycle acceptance remain incomplete.

Paid Stripe sandbox purchase acceptance remains incomplete. Neither billing implementation nor component tests should be presented as a completed paid checkout. Build 24 installation and the signed build-to-build automatic update/restart acceptance also remain pending.
