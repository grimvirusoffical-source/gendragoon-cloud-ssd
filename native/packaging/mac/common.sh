#!/usr/bin/env bash
# Shared helpers for the Gendragoon Mac-side build scripts. Sourced, not run.
# RULES: no secrets in this file or in any script (identities are NAMES, passwords live in the keychain);
# dry-run is the DEFAULT; nothing here uploads to any store.

GD_RUN=0            # 0 = dry-run (print only). 1 = really execute.
GD_FAILURES=0

gd_log()  { printf '\033[1;35m[gendragoon]\033[0m %s\n' "$*"; }
gd_warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
gd_die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# Print the command (quoted); execute only with --run.
gd_run() {
  printf '  $'; printf ' %q' "$@"; printf '\n'
  if [ "$GD_RUN" = 1 ]; then "$@"; fi
}

# Require an env var. In dry-run a missing value is only a warning so you can read the full plan.
gd_need() {
  local name="$1" hint="$2"
  if [ -z "${!name:-}" ]; then
    if [ "$GD_RUN" = 1 ]; then gd_die "Missing env var $name ($hint)"; else gd_warn "dry-run: $name is not set ($hint)"; GD_FAILURES=$((GD_FAILURES+1)); fi
  fi
}

# Refuse if a value looks like a secret was pasted where only a NAME belongs.
gd_no_secret_values() {
  for v in "$@"; do
    case "${!v:-}" in
      *-----BEGIN*|*ghp_*|*github_pat_*|*app-specific*) gd_die "$v looks like a secret. Scripts take identity NAMES / keychain profile names only." ;;
    esac
  done
}

gd_require_macos() {
  if [ "$(uname -s)" != "Darwin" ]; then
    if [ "$GD_RUN" = 1 ]; then gd_die "--run needs macOS (this is $(uname -s))"; else gd_warn "dry-run on $(uname -s): checks that need macOS tools are skipped"; return 1; fi
  fi
  return 0
}

gd_have_identity() {  # $1 = exact identity name; searches code-signing identities in the keychain
  security find-identity -v -p codesigning 2>/dev/null | grep -F "\"$1\"" >/dev/null
}
gd_have_installer_identity() {  # installer certs are not "codesigning" identities
  security find-identity -v 2>/dev/null | grep -F "\"$1\"" >/dev/null
}

gd_parse_common() {  # sets GD_RUN from --run / --dry-run; echoes remaining args via GD_REST
  GD_REST=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --run) GD_RUN=1 ;;
      --dry-run) GD_RUN=0 ;;
      *) GD_REST+=("$1") ;;
    esac
    shift
  done
}

gd_summary() {
  if [ "$GD_RUN" = 0 ]; then
    gd_log "DRY RUN finished. Nothing was executed. Re-run with --run on the Mac when the README prerequisites are met."
    [ "$GD_FAILURES" -gt 0 ] && gd_warn "$GD_FAILURES prerequisite(s) not set; --run would stop at the first one."
  fi
  return 0
}
