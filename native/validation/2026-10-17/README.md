# Observed validation evidence — October 17, 2026

These reports contain observed results from the staged candidate, not production
acceptance certification. They contain no credentials or secret configuration
values. The full scope and remaining release gates are in
[VALIDATION.md](../../VALIDATION.md).

- `backend-first-run.json`: the first Mac run, including its 16 timed-out
  responses. An HTTP 200 header did not override a failed request deadline.
- `backend-repeat.json`: the repeat with the same 256 requests, 16 workers,
  five-second request budget and 45-second load limit. Diagnostic fields were
  added, with no retries or weaker limits. All checks passed; the earlier
  timeout cause remains unresolved.
- `mac-archive-roundtrip.json`: real macOS `ditto` and native extended-attribute
  checks using a disposable file with a resource fork, custom attribute and
  empty attribute. Originals and modified content were preserved.
- `mac-node-provenance.json`: the exact official Node 24.22.0 arm64 archive and
  resulting signed runtime hashes. The upcoming Node security-release limit
  remains explicit.
- `mac-native-lifecycle-final.json`: the final signed candidate's unchanged
  production helpers passed all three real AppKit lifecycle cases in 50.753
  seconds, with independent per-case deadlines and detailed timings.
- `mac-native-initial-budget-failure.json`: the earlier shared 55-second harness
  timeout is retained as evidence. Its temporary fixture path is omitted.

The backend candidate receives zero production traffic, but retains the service's
existing data and secret configuration. These probes used public read-only routes
and anonymous rejection tests; they did not perform billing activation, a purchase,
authenticated customer transfers or writes/deletes.
