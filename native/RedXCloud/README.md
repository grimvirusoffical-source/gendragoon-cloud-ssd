# Red-XAI-Reiceivers private integration

This implementation is **a local development preview**, not a production
replacement for GenDragoon's existing storage. It uses the actual existing
RedX database engine, Red-XAI Accounts issuer, and Red-SecretsXAI C++ core.
No customer bucket migration, Stripe billing, or VPS deployment is performed.

## Flow

1. REDXAI `INSTALL-GSSD-CLI` opens the shared Red-XAI registration page
   **before authorization** when the user does not have an account.
2. With a reviewed `--preview-config`, OAuth 2.0 Authorization Code + PKCE
   validates the existing account; it does not capture passwords.
3. The backend verifies the signed access token, audience, email verification,
   active account (userinfo), minimum age, optional ToS version, then creates
   an idempotent account Receiver tracked inside a **dedicated RedX metadata
   database**, not inside the master accounts database.
4. A user-created workspace has a server-controlled quota.
5. The **client** encrypts a file using the actual Red-SecretsXAI
   `librsx` core, RSX3 authenticated chunks, and a mandatory red-X PNG
   carrier. An authenticated Receiver upload verifies the carrier decoding
   but has **no password and never decrypts private files**.
6. Download returns the stored PNG, and the client decodes and decrypts it
   using the original keymap/password, verifying the associated account,
   Receiver, workspace and object context. Only completed outputs are published.

## Development tests

Prepare separate local builds of `redxd`, `redxai-accounts`, and
`librsx`, and a Python venv with Red-SecretsXAI + Pillow. The
`test/stack.cjs` harness expects them under `REDX_INTEGRATION_ROOT/tools`.

```sh
REDX_INTEGRATION_ROOT=/absolute/path/to/integration \
 node --test native/RedXCloud/test/roundtrip.test.cjs
```

All fixtures run on IPv4 loopback with temporary data, scoped service
credentials, and temporary test accounts. Do not use a paid or production
database for these tests. An explicit environment flag is required to start
the independent private preview server.

## Constraints before public deployment

- File preview is limited to **64 KiB plaintext** and **8 MiB PNG**.
  General file/folder/drive storage, streaming, splitting, retries and
  resumable transfers are not implemented here.
- Red-X PNG validation on the server does **not** authenticate ciphertext
  without a decryption key. The client authenticates on decryption.
- This project needs rate-limit/load tests, network TLS/reverse proxy,
  backups, monitoring, quota/entitlement enforcement, isolated process
  permissions and an external security review before hosting paying users.
- The new GenDragoon app release must consume the CLI's connection profile,
  provide keymap recovery UX and implement login after installation.
- The Red-SecretsXAI C++ crypto core is pre-audit; cross-platform test
  vectors and fuzzing remain important.
- Deployment must reference stable domain names; do not hardcode the temporary
  VPS IP. Protect keys separately from both database and encoded PNG backups.
