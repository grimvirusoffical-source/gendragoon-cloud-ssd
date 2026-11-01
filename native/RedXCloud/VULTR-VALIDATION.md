# Vultr Linux validation — 2026-10-22

## Verified against the actual server

The existing user-owned Vultr VPS `Red-XAI` (Ubuntu 26.10, linux/amd64)
hosted this validation. No new server or cloud service was purchased.

- The existing Dolphin services were active before and after the test.
- A separately staged copy of RedX and Red-XAI Accounts built using Go
  1.27.1 on the VPS. RedX and Accounts development endpoints returned
  healthy responses while bound to `127.0.0.1`.
- Red-SecretsXAI's **existing C++ crypto core** built successfully on
  the VPS as `librsx.so`, together with the image codec library.
- The real Python `redxai` and `redsecretsxai` modules, and Pillow,
  imported correctly in a dedicated Python virtual environment.
- The entire **12-test actual integration roundtrip** passed on
  Linux under the separate unprivileged `redxai-preview` account.
  This was not mocked encryption or a fake PNG.

## Behavior confirmed by tests

- Two properly signed and verified Red-XAI identities received distinct
  account-owned Receiver IDs; repeat setup preserved the same Receiver.
- Missing/forged access tokens and ID tokens were rejected.
- Workspace creation respected the server-defined quota and idempotency.
- Actual C++ encryption plus Red-X PNG encoding generated a valid carrier.
- The Receiver accepted only the decoded, validated PNG format and
  tracked the encoded size once.
- The second identity could neither read nor overwrite the first
  identity's workspace.
- Download, decoding and decryption exactly restored the original bytes.
- Wrong password and wrong object context failed without writing plaintext.
- Fake PNG and bad hashes were rejected; quota remained unchanged.
- Data persisted across the private Receiver process restart during the test.
- Corrupted stored PNG failed closed.

## Test environment

The test uses the existing `native/RedXCloud/test/stack.cjs` harness to
create temporary, isolated RedX, Accounts and Receiver resources with synthetic
accounts. All endpoints bind to IPv4 loopback, and the harness removes its
temporary storage and test accounts afterwards. Its authentication uses
development fixtures, **not real production customer accounts**.

### Reproduction

Build `redxd`, `redxai-accounts` and `librsx.so` from the corresponding
source revisions, then install Red-SecretsXAI and Pillow in a Python venv.
Make the binaries/venv available under the `REDX_INTEGRATION_ROOT/tools`
layout described in `test/stack.cjs`. Then run as a non-root user:

```sh
REDX_INTEGRATION_ROOT=/path/to/reviewed-integration \
  node native/RedXCloud/test/roundtrip.test.cjs
```

The direct Node invocation is intentional: the tested unprivileged environment
reported an EACCES when Node's `--test` runner re-executed a worker, while
direct `node testfile.cjs` passed all 12 tests. The test itself uses
`node:test` and reports a regular TAP summary.

## Not production-ready

This is evidence of working **Vultr Linux private integration**, not proof
that GenDragoon is ready for public customer storage. The current Receiver
implementation accepts only 64 KiB plaintext files and up to 8 MiB PNG
carriers. It does not yet cover file/folder streaming, resumable transfers,
commercial quota/billing integration, backup/restore, or a full security audit.

The persistent VPS RedX instance is live only on localhost, but production
Red-XAI Accounts remains blocked on secure **scoped** RedX service key
provisioning and real production email/2FA, TLS, stable DNS and monitoring.
The separate running development Accounts instance uses memory, which is
lost on restart. Never promote its users or data to production.

The native GenDragoon Mac beta is still its older release and does not yet
consume this new Receiver or CloudCLI profile. No production customer files,
billing configuration, public firewall ports or Dolphin services were changed.
