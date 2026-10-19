#!/usr/bin/env bash
# Runs the tagged test against a local RedX checkout without editing go.mod: a throwaway go.work.
#   REDX_DIR=/path/to/redx contract/redxpack/run_redx.sh
set -euo pipefail
cd "$(dirname "$0")"
: "${REDX_DIR:?set REDX_DIR to a RedX checkout (module redx)}"
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
printf 'go 1.22\n\nuse (\n\t%s\n\t%s\n)\n' "$PWD" "$(cd "$REDX_DIR" && pwd)" > "$work/go.work"
GOWORK="$work/go.work" go test -tags redx -count=1 ./...
