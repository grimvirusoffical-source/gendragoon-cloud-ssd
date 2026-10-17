# Account reset integration

`AccountResetSection.swift` is a reviewable macOS 14+ SwiftUI component. This
checkout does not contain the native app's `AccountView`, Xcode project, signing
configuration, or the rest of its source. The component has **not** been inserted
into the compiled app, built for macOS, signed, published, or installed on the
user's Mac.

Add the source to the native app target and include the section in Account:

```swift
Form {
    // Existing account content.
    AccountResetSection(
        isBusy: operations.hasActiveWork,
        onRequestStateChange: { operations.isRestartPending = $0 }
    )
}
```

`operations` is an integration example, not a type supplied by this repository.
Wire `isBusy` to the application's actual mounts, transfers (including all
URLSession work), cache installs, launches, and update state. Use the callback to
block new operations while reset is pending. The callback is required; previews
can pass an explicit no-op, but a running app must provide the coordinator gate.
The component cannot infer the full app's idle state from the process table.

In the target's Copy Bundle Resources phase, include both
`Resources/gendragoon_app_control.py` and `Resources/gendragoon_auto_update.py`,
retaining their filenames in `GenDragoon Cloud SSD.app/Contents/Resources/`.
The helper requires Python 3.10+ on the runtime PATH. Ship or provision a trusted
Python runtime for a reproducible release; do not assume that every Mac has
Python installed. If a sandboxed app target is used, validate helper execution,
its file access, and relaunch permissions with the actual signed target before
releasing it. No entitlement bypass is supplied here.

The button is labeled **Reset App**, with text explaining that it restarts and
refreshes the app while preserving cloud files, credentials, and local data.
It does not log out, clear caches, or erase account data. Busy state and an
in-progress reset disable the button.

The component uses `Process` argument arrays (no shell) to call:

```text
/usr/bin/env python3 <bundled gendragoon_app_control.py> reset \
  --pid <current process identifier> --app <current app bundle> --ui-busy false
```

Execution and bounded output reading take place off the main actor. Private
temporary files capture stdout/stderr without pipe deadlocks. Only an exit status
of zero and valid JSON containing `"state": "scheduled"`, a 32-character
`request_id`, and valid bounded timeout fields cause `NSApp.terminate(nil)`.
The helper must acknowledge only after its detached worker
has obtained the updater lock and completed preflight. Missing helpers, missing
Python, invalid JSON, helper errors, and timeouts keep the app running and display
a bounded, redacted error. Helper readiness has a 120-second UI timeout to allow
signature/Gatekeeper checks and the worker's 90-second readiness timeout.
The worker waits for the exact app process to exit before relaunching; it cannot
force an app delegate or document to allow quitting. If termination returns
(including a cancelled quit), the pending-operation gate remains active while
the UI polls `status --request-id <id>`. A matching terminal failure releases the
gate and displays its error. A normal cancelled quit reaches the worker's
90-second exit timeout. The UI also bounds monitoring by the worker's advertised
deadline (at most 240 seconds); it cannot treat a stale request's status as the
current reset outcome.
For restart outcomes after the UI exits, inspect the helper's private status at
`~/Library/Application Support/GenDragoon Cloud SSD/AppControl/status.json`.

Before shipping, build and test the actual macOS 14+ SwiftUI/AppKit target on a
Mac using the project's pinned Xcode version. No Swift toolchain or AppKit SDK is
available in this Linux cloud environment, so this component has not been
compiled here. Validate successful reset/relaunch, active-work gating and the
pending-operation gate, cancelled app termination, missing Python/helper,
nonzero/invalid helper responses, timeout, and relaunch failure with the signed
app. Confirm that cloud files, saved credentials, and local data survive reset.
