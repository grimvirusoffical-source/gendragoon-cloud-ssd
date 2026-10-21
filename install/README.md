# GDSSD cross-platform installer: bootstrap (development)

This branch adds **bootstrap source only**, not published installable app releases.
Do not claim `GDSSD Install` works on a fresh computer yet: it requires a
preinstalled GDSSD launcher, which must be distributed and installed first.
The exact two-command UX can be enabled after signed releases and first-party
Red-XAI identity infrastructure exist.

## Bootstrap commands after obtaining the installer scripts from a trusted release

macOS Terminal and Linux shell:

```sh
bash gdssd-install.sh
```

Windows PowerShell (from directory containing the scripts):

```powershell
.\gdssd-install.ps1
```

Windows CMD:

```bat
gdssd-install.cmd
```

After bootstrap is installed and the launcher is on PATH:

```text
GDSSD Install
GDSSD Install-CloudCLI
```

**Presently the launcher marks CloudCLI as unavailable, deliberately.** It
cannot claim authentication, storage isolation, or Receiver creation without
live Red-XAI Accounts OIDC and the GenDragoon provisioning API.

## Expected release artifacts

At `GDSSD_RELEASE_BASE` (default: latest GitHub release), for each macOS and
Linux target `gdssd-<os>-<arch>.tar.gz` and adjacent
`gdssd-<os>-<arch>.sha256`; archive must contain `GenDragoon SSD.app`
(macOS) or executable `gdssd-app` (Linux).

Windows: `gdssd-windows-<arch>.exe` and
`gdssd-windows-<arch>.exe.sha256`, with valid Authenticode signing.

Note: publishing the checksum in the **same place** as the binary detects
transport/corruption, not a fully compromised release account. Production
bootstraps must pin a trusted signing identity or verify a signed release
manifest, and macOS installation must validate Developer ID signature and
notarization before distribution.

## CloudCLI implementation requirements

Use Red-XAI Accounts' public client `gendragoon` with auth code + PKCE.
Opening `https://red-xai.com` for registration is fine, but the *actual
issuer URL must be configured* and must host the OIDC endpoints. Never ask for
passwords in terminal or embed administrative client secrets. On successful
login, use OIDC `sub` to upsert one root Red-XAI-Reiceiver in an idempotent
backend transaction; issue user- and workspace-scoped permissions. Verify
ownership server-side for every file operation. Do not use email addresses as
authorization identifiers. Notify and mark ready only once storage has been
provisioned and tested.
