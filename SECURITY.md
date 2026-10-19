# Security policy

## Reporting a vulnerability

Email security@example.com (placeholder) with a description, affected version and steps to reproduce. Please do not open a public issue for security problems. We aim to acknowledge reports within a few days.

## Scope

- The macOS, iOS, Android, Windows and Linux clients
- The backend service in `native/Backend`
- The release and update tooling

## Handling secrets

Credentials, signing keys, Stripe secrets and storage keys must never be committed. The backend reads secrets from its configured secret store. If you find a secret in this repository, report it as above so it can be rotated.
