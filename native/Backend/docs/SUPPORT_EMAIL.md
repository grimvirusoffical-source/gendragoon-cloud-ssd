# Support email

GenDragoon sends password-reset links and account notices from `support@infected-nation.com`, the same mailbox Rotten Apple uses. The module is `support_email.js`; it is off unless `SUPPORT_EMAIL_ENABLED=true`.

## Relationship to Rotten Apple

Rotten Apple defines the sender contract in `racore/email.go`: an `EmailSender` delivers one plain-text message `{To, Subject, Body}` to one address, and every message names the support address. Its SMTP implementation is being built on the `audit-fill` branch and is not available yet. `support_email.js` implements the same contract for GenDragoon, against the same mailbox and with the same configuration names, so both services can switch to one shared sender (or one relay) without changing their message code.

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `SUPPORT_EMAIL_ENABLED` | `true` mounts the password-reset route and enables notices | off |
| `SUPPORT_SMTP_HOST` | SMTP server | required |
| `SUPPORT_SMTP_PORT` | port | `587`, or `465` with `tls` |
| `SUPPORT_SMTP_SECURE` | `starttls` or `tls` (implicit) | `starttls` |
| `SUPPORT_SMTP_USER` | login | `support@infected-nation.com` |
| `SUPPORT_EMAIL_PASSWORD` | mailbox password | required |
| `SUPPORT_EMAIL_FROM_NAME` | display name | `Infected Nation Support` |
| `PASSWORD_RESET_CONTINUE_URL` | where Firebase sends the user after the reset | none |

The password is read from `SUPPORT_EMAIL_PASSWORD` only. It stays in a closure inside the sender; it is not logged, not included in errors (server replies are scrubbed), not shown by `util.inspect` or `JSON.stringify` of the sender, and not stored anywhere. In production it belongs in Secret Manager, mounted as that environment variable.

The client authenticates only over TLS (STARTTLS or implicit TLS, certificate verified). A server that does not offer STARTTLS is refused before any credential is sent.

## Password reset

`POST /v1/auth/password-reset` with `{"email": "…"}`.

* Always `202` with the same body, whether or not an account uses the address, so the route cannot be used to discover accounts. Malformed addresses are `400`.
* Firebase Auth generates the one-time link (`generatePasswordResetLink`); this server only delivers it.
* Limits: 10 requests per IP per 10 minutes (`429` beyond that), 3 emails per address per hour (further requests are accepted but send nothing).
* Logs carry a 16-character hash of the address, never the address or the link.

## Notices

| Kind | Sent when |
|---|---|
| `provider.connected` | an app redeemed a connect grant or code for the account |
| `provider.revoked` | the account owner revoked an app (says whether its data was deleted) |

The address is looked up through Firebase Auth when the notice is sent. A failed send is logged (hashed address, error code) and never fails the request that caused it.

## Tests

`support_email.test.js` runs the SMTP client against an in-process fake server on `127.0.0.1` with a throwaway self-signed certificate (STARTTLS with AUTH PLAIN, implicit TLS with AUTH LOGIN, refusal without TLS, untrusted certificate), checks that the password never appears in errors, inspect output, JSON or console output, and tests the reset route and notices with a recording sender. No test sends real mail.

## Not done

* An account-deletion confirmation notice (the deletion job removes the Firebase user; the address must be captured before that step).
* Deployment: `support_email.js` is not in `deploy_free.py`'s allow-list, and the SMTP host and the secret are not provisioned.
