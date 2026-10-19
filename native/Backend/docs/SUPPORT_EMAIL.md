# Support email

GenDragoon sends password-reset links and account notices from `support@infected-nation.com`, the mailbox Rotten Apple uses. The module is `support_email.js`; it is off unless `SUPPORT_EMAIL_ENABLED=true`.

## Relationship to Rotten Apple

Rotten Apple's shared sender is the Go package `rottenapple/mailer` (`docs/EMAIL.md`, branch `audit-fill`). This backend is Node, so it cannot import the package; `support_email.js` is a direct port with the same interface and rules:

| Go (`mailer`) | Node (`support_email.js`) |
|---|---|
| `Config{Host, Port, Security, Username, From, FromName, PasswordEnv, HelloName, Timeout, PerRecipientPerHour, PerMinute}` (no password field) | `createMailer({host, port, security, username, from, fromName, passwordEnv, helloName, timeoutMs, perRecipientPerHour, perMinute})`; a `password` key is rejected |
| `DefaultInfectedNation()` | `defaultInfectedNation()`: `smtp.gmail.com:587`, STARTTLS, `support@infected-nation.com` |
| `Message{To, Subject, Body, Template}`, `Sender.Send` | `{to, subject, body, template}`, `sender.send(message)` |
| `ErrRateLimited`, `ErrNoPassword`, `ErrBadMessage`, `ErrNoTLS`, `*Bounce` | errors with `code` set to the same names; `Bounce` with `smtpCode` |
| `EventLog`, `MemLog`, `FileLog` (0600), `Event{atMs, to, toHash, template, status, code, error}` | `memLog()`, `fileLog(path)`, identical event fields, masking and 16-hex-character address hash |
| `Templates`, `DefaultTemplates()`, `Add`, `Render` | `templates()`, `add`, `render`, the same built-ins and the same "missing field is an error" rule |
| `LogSender` | `logSender(logf)`: writes the message to a log and sends nothing |

The rules are the same: TLS always (STARTTLS on 587 refuses a server that does not offer it, implicit TLS on 465, certificates verified, TLS 1.2 minimum, no plaintext mode); AUTH PLAIN only after TLS; one plain recipient, CR/LF and display-name forms refused; RFC 2047 subjects, quoted-printable bodies, `Auto-Submitted: auto-generated`; 5 messages per recipient per hour and 60 per minute overall. A change to the Go package should be mirrored here; the tests below pin the shared behaviour.

Two details differ from the Go package on purpose:

* Encoded-words are split exactly as Go's `mime.QEncoding.Encode("utf-8", …)` splits them (each word at most 75 characters, a multi-byte character never split), and the display name is written as Go's `mail.Address.String()` writes it. The Node port also folds a header line longer than 78 characters at the spaces between encoded-words, so a long non-ASCII subject stays within the 998-character line limit; the Go package writes the same words on one line. `test_helpers/rfc2047_go_vectors.json`, generated from the Go encoders by `test_helpers/rfc2047_vectors`, pins the bytes.
* The per-recipient limit counts on a normalised address (`recipientKey`): lower case, a `+tag` removed, and for `gmail.com` and `googlemail.com` dots removed and the domain mapped to `gmail.com`. `v.ictim@gmail.com`, `victim+1@gmail.com` and `VICTIM@googlemail.com` therefore share one budget. The Go package still keys on the lower-cased address.

GenDragoon replaces the `password_reset` template (Firebase issues a one-time link rather than a code) and adds `provider_connected` and `provider_revoked`, as `docs/EMAIL.md` allows (`Templates.Add`).

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `SUPPORT_EMAIL_ENABLED` | `true` mounts the password-reset route and enables notices | off |
| `SUPPORT_SMTP_HOST` | submission server | `smtp.gmail.com` |
| `SUPPORT_SMTP_PORT` | port | `587` (`465` with `tls`) |
| `SUPPORT_SMTP_SECURITY` | `starttls` or `tls` | `starttls` |
| `SUPPORT_SMTP_USER` | login | `support@infected-nation.com` |
| `SUPPORT_EMAIL_PASSWORD` | Google app password for the mailbox | required |
| `SUPPORT_EMAIL_PASSWORD_ENV` | read the password from a different variable | `SUPPORT_EMAIL_PASSWORD` |
| `SUPPORT_EMAIL_FROM_NAME` | display name | `Infected Nation Support` |
| `SUPPORT_EMAIL_LOG` | JSON-lines event log file (mode 0600) | events go to the server log |
| `PASSWORD_RESET_CONTINUE_URL` | where Firebase sends the user after the reset | none |

As with `ra-core serve --smtp-host`, enabling email without the password variable refuses to start. The password is read from the environment at send time; it is never stored in the config, logged, or included in errors (server replies are scrubbed of it and of its AUTH PLAIN encoding). In production it belongs in Secret Manager, mounted as that variable.

## Password reset

`POST /v1/auth/password-reset` with `{"email": "…"}`.

* Always `202` with the same body, whether or not an account uses the address, so the route cannot be used to discover accounts. Malformed addresses are `400`.
* Firebase Auth generates the one-time link (`generatePasswordResetLink`); this server only delivers it.
* Limits, checked before Firebase is asked for a link:
  * 10 requests per client IP per 10 minutes, then `429` with `Retry-After: 600`. The client IP is `req.ip`, which is only the real address when Express trusts exactly the proxies in front of it: `free_server.js` sets `trust proxy` to `TRUST_PROXY_HOPS`, default `1` (Cloud Run's front end appends the address it received the request from to `X-Forwarded-For`; anything the client put there itself is ignored). Set `TRUST_PROXY_HOPS=0` when the server is reached directly. An invalid value refuses to start.
  * 5 requests per address per hour, counted on the normalised address (see above) across all IPs. Over the limit the answer is the same `202`, so the limit reveals nothing about the address; no link is generated and nothing is sent (logged as `password_reset.limited` with the hash).
  * The mailer's limit of 5 messages per address per hour applies to the send as well.
* Logs carry the address hash, never the address or the link.

## Notices

| Kind | Template | Sent when |
|---|---|---|
| `provider.connected` | `provider_connected` | an app redeemed a connect grant or code for the account |
| `provider.revoked` | `provider_revoked` | the account owner revoked an app (says whether its data was deleted) |

The address is looked up through Firebase Auth when the notice is sent. A failed send is logged (hashed address, error code) and never fails the request that caused it.

## Tests

`support_email.test.js` runs the mailer against an in-process fake SMTP server on `127.0.0.1` with a throwaway self-signed certificate: STARTTLS and implicit TLS, the message format, refusal of a server without STARTTLS and of an untrusted certificate before any credential is sent, a 550 recorded as `bounced`, the password requirement and the absence of the password in errors, inspect output, the event log and console output, header-injection refusal, rate limits (including address variants), RFC 2047 bytes against the Go vectors and folding of long subjects, templates, the reset route with its per-IP limit behind one proxy hop and its per-address limit, and notices. `free_server.test.js` checks the `trust proxy` setting and that a forged `X-Forwarded-For` does not change `req.ip`. No test sends real mail.

## Not done

* An account-deletion confirmation notice (the deletion job removes the Firebase user; the address must be captured before that step).
* Deployment: `support_email.js` is not in `deploy_free.py`'s allow-list, and the secret is not provisioned. Per `docs/EMAIL.md`, DKIM and DMARC for infected-nation.com are not set up yet, so mail may land in spam until they are.
