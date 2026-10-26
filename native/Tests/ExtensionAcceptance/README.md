# Real extension host acceptance

This separate Linux workflow tests actual application processes rather than
mocking the browser or VS Code APIs. It extracts the unchanged output of
`native/Extensions/package_extensions.py`. It needs no account, service secret,
private encryption checkout, store login, or user browser profile.

The driver refuses to run outside Linux GitHub Actions and requires a new
private directory inside `RUNNER_TEMP`. Browser profiles, the extension host,
the native-host registration, IPC locator/socket, consent fixture, and all
downloaded tools stay within disposable test locations. It never changes HOME,
registers a host in a user's browser, or launches a browser on the operator's
Mac. Tool dependencies and their transitive integrity hashes are locked;
`npm ci --ignore-scripts` installs them outside the source and package trees.

## What the jobs prove

- **VS Code:** the generated VSIX installs into a separate extensions directory.
  Microsoft's real Extension Development Host discovers and activates that exact
  packaged extension, registers its five contributed commands, and executes
  Check Local Companion through the actual compiled ELF native host and the
  production `CompanionServer` Unix socket transport. The test uses a trusted
  disposable workspace. It does not establish Restricted Mode, real picker
  consent, storage transfer, or every editor command's UI behavior.
- **Chromium:** Playwright's bundled Chromium loads the generated Chrome package
  in a separate persistent profile. The actual `chrome.runtime.id` must match
  the exact native-host origin. The dashboard communicates through Chromium's
  real native messaging API, the compiled ELF host, and production private IPC.
  Tests cover denied fixture consent, approved synthetic metadata, safe Unicode
  text rendering, read-only upload controls, a cancelled picker response,
  forbidden key/path operations, fixture consent removal on an existing
  connection, and denial of a new native connection after removing its exact
  origin from the allowlist. The packaged Teams page also loads. No file is
  uploaded and no native picker is opened.
- **Firefox:** Mozilla `web-ext` lints the generated Firefox package and uses a
  real isolated Firefox process to install and reload the temporary add-on.
  It does not test Firefox native messaging, signed distribution, or a store
  installation. Warnings remain in the lint report; lint errors fail the job.
- **Google Chrome and Microsoft Edge candidates:** separate jobs require the
  actual vendor browser already installed in the official Ubuntu 24.04 runner.
  They load each brand's generated package through experimental CDP
  `Extensions.loadUnpacked` and run the same native-messaging boundary checks.
  The explicit extension-debugging flag applies only to a new disposable,
  account-free CI profile. Reports record the vendor version and installation
  method. This test does not establish signed store installation, ordinary user
  consent, Opera support, or behavior on another operating system. A failure of
  that experimental install path remains a failed candidate, not a pass.
- **Opera candidate:** a separate job downloads the exact checksum-pinned stable
  Opera Debian package from its official repository, verifies the package fields,
  and extracts it into a new private CI directory without running an installer or
  changing system registrations. It retains the package's notices, removes any
  privileged permission bits, and records both package and actual ELF hashes.
  The real Opera process must load its packaged extension and pass the same
  native-messaging checks. The fixture stays on Linux and does not prove Opera
  store installation or native consent UI.

The companion fixture uses production transport, identity checks, frame bounds,
and route validation with an explicitly synthetic dispatch callback. It never
replaces a production HTTP endpoint. Its test-controlled consent file does not
prove that the native GUI approval dialog was used. Reports state these limits
and record actual editor/browser versions and package/native-host hashes.

Only reports and a dashboard screenshot containing disposable fixture labels
are uploaded. Profiles, native-host configuration, sockets, executable caches,
downloaded tools, and source/build trees are excluded from uploaded artifacts.
The CI token has read-only repository permission and checkout credentials are
not persisted. Tests stop only processes they spawned.

## Official APIs and platform limits

The runner uses Microsoft's
[VS Code extension testing API](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
and [`@vscode/test-electron`](https://github.com/microsoft/vscode-test), including
its real CLI installation and Extension Development Host. Actual tested editor
versions are recorded because the runner downloads the current stable editor.

The browser job follows Playwright's
[Chromium extension testing workflow](https://playwright.dev/docs/chrome-extensions).
Chrome and Edge removed the flags used for the Chromium side-loading path, so
that job uses Playwright's Chromium. The separate brand candidates use the
[official experimental Extensions protocol](https://chromedevtools.github.io/devtools-protocol/tot/Extensions/)
in disposable CI profiles. Browser availability is checked against the actual
[official Ubuntu runner image](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md),
and execution still has to pass before acceptance can be claimed.
The host registration follows Chromium's actual
user-data-directory lookup and Chrome's
[native messaging contract](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).

Firefox loading follows Mozilla's
[web-ext testing workflow](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/)
and the pinned version's
[Node API](https://github.com/mozilla/web-ext/blob/10.8.0/README.md#using-web-ext-in-nodejs-code).
That internal API has limited stability, so its version is pinned. Reload and
shutdown use the returned extension runner; no signing or publishing method is
called.

A passing job supplies Linux packaged-extension loading and the specific fixture
evidence above. Native user approval, live account isolation and transfer,
untrusted editor workspaces, physical browser variants, other operating systems,
publisher ownership, policy review, and store submission remain separate gates.
