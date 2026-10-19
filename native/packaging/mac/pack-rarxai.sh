#!/usr/bin/env bash
# Build the Gendragoon Mac app and pack it as a Rotten Apple .rarxai package. Runs on the MAC.
#
#   scripts/mac/pack-rarxai.sh [--run] [--apple-sign] [--notarize] [--ca-dir DIR | --test-ca] [--production]
#                              [--team ID] [--app PATH [--allow-non-mac]] [--storage auto|on|off]
#
# Default is a DRY RUN: it prints every command and changes nothing. Add --run to execute.
# PRIMARY trust = Rotten Apple's own signing: ql pack signs the manifest + Merkle root with the developer key whose
# certificate chains to the Rotten Apple root (a throwaway TEST CA by default). No Apple Developer ID is needed.
# Apple signing is OPTIONAL: --apple-sign uses the Developer ID identity, --notarize also notarizes + staples
# (implies --apple-sign). Without them the app is AD-HOC signed (Apple silicon refuses unsigned arm64 code).
# Nothing is uploaded to Rotten Apple or any store (no `ql upload`). Notarization sends the build to Apple only.
#
# Gatekeeper, honestly:
#  * Installed by ra-launcher: the launcher downloads with its own HTTP client, so the app is not quarantined and
#    Gatekeeper's first-launch check does not run; the launcher verifies the .rarxai chain instead. Ad-hoc is enough.
#  * Copied out, AirDropped, or downloaded by a browser: the file gets com.apple.quarantine, and an ad-hoc app is
#    blocked ("can't be opened"); the person must allow it in System Settings > Privacy & Security > Open Anyway.
#    Only --notarize builds open normally in that case.
#  * Ad-hoc signatures change on every build, so macOS may ask again for Keychain access and for privacy
#    permissions (Files and Folders, Full Disk Access) after each update. A stable Developer ID avoids that.
#  * This depends on Apple keeping today's quarantine behaviour for non-browser downloaders (Rotten Apple SPEC 7.3).
#
# Env (names and paths only, never secrets):
#   GD_REPO      gendragoon-cloud-ssd checkout (native/build_macos.py; needs --identity/--distribution support)
#   GD_BASE_APP  pinned vendor base bundle (rclone, node); not in git
#   GD_OUT       output folder (default ~/gendragoon-build/rarxai); a fresh app/ subfolder is created
#   RA_REPO      rotten-apple checkout, to build ql and ra-ca (default ~/rotten-apple)
#   RA_TEAM      Rotten Apple team id in the developer certificate (default GDT1 with the TEST CA)
#   GD_STORAGE_PURPOSES  what Gendragoon offers as a provider (default "cloudsave media backups")
#   GD_DEVID_APP_IDENTITY, GD_NOTARY_PROFILE   only with --apple-sign / --notarize
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"

APPLE_SIGN=0; NOTARIZE=0; CA_DIR=""; TEST_CA=1; PRODUCTION=0; APP_IN=""; NON_MAC=0; STORAGE=auto; TEAM="${RA_TEAM:-}"
gd_parse_common "$@"
set -- "${GD_REST[@]+"${GD_REST[@]}"}"
while [ $# -gt 0 ]; do
  case "$1" in
    --apple-sign) APPLE_SIGN=1 ;;
    --notarize) NOTARIZE=1; APPLE_SIGN=1 ;;
    --ca-dir) CA_DIR="${2:?--ca-dir needs a directory}"; TEST_CA=0; shift ;;
    --test-ca) TEST_CA=1; CA_DIR="" ;;
    --production) PRODUCTION=1 ;;
    --team) TEAM="${2:?--team needs a value}"; shift ;;
    --app) APP_IN="${2:?--app needs a path}"; shift ;;
    --allow-non-mac) NON_MAC=1 ;;
    --storage) STORAGE="${2:?--storage needs auto|on|off}"; shift ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) gd_die "unknown argument: $1" ;;
  esac
  shift
done
case "$STORAGE" in auto|on|off) ;; *) gd_die "--storage must be auto, on or off" ;; esac
[ "$PRODUCTION" = 1 ] && [ "$TEST_CA" = 1 ] && gd_die "--production refuses the TEST CA; pass --ca-dir with the production developer key"
[ "$NON_MAC" = 1 ] && [ -z "$APP_IN" ] && gd_die "--allow-non-mac only packs an existing --app (building needs macOS)"
[ "$NON_MAC" = 1 ] && [ "$APPLE_SIGN" = 1 ] && gd_die "--apple-sign needs macOS"

: "${GD_REPO:=$( [ -f "$PWD/native/build_macos.py" ] && echo "$PWD" || echo "$HOME/gendragoon-cloud-ssd" )}"
: "${GD_BASE_APP:=$HOME/Applications/GenDragoon Cloud SSD.app}"
: "${GD_OUT:=$HOME/gendragoon-build/rarxai}"
: "${RA_REPO:=$HOME/rotten-apple}"
: "${GD_DEVID_APP_IDENTITY:=}"
: "${GD_NOTARY_PROFILE:=}"
: "${GD_STORAGE_PURPOSES:=cloudsave media backups}"
[ -n "$TEAM" ] || TEAM=GDT1
gd_no_secret_values GD_DEVID_APP_IDENTITY GD_NOTARY_PROFILE RA_TEAM

APP_NAME="GenDragoon Cloud SSD.app"
BIN="$GD_OUT/bin"; CA="${CA_DIR:-$GD_OUT/ra-ca-test}"
APP="${APP_IN:-$GD_OUT/app/$APP_NAME}"
VER="$(sed -nE 's/^VERSION="([^"]+)".*/\1/p' "$GD_REPO/native/build_macos.py" 2>/dev/null || true)"; VER="${VER:-unknown}"
PKG="$GD_OUT/gendragoon-$VER-macos-arm64$([ "$TEST_CA" = 1 ] && echo .test).rarxai"

gd_log "mode: $([ "$GD_RUN" = 1 ] && echo RUN || echo DRY-RUN)   apple-sign: $APPLE_SIGN   notarize: $NOTARIZE   CA: $([ "$TEST_CA" = 1 ] && echo "TEST ($CA)" || echo "$CA")"
gd_log "repo: $GD_REPO   rotten-apple: $RA_REPO   out: $GD_OUT   team: $TEAM"

# ---- preflight -----------------------------------------------------------------------------------
ON_MAC=0; [ "$(uname -s)" = Darwin ] && ON_MAC=1
if [ "$ON_MAC" = 0 ]; then
  if [ "$GD_RUN" = 1 ] && [ "$NON_MAC" = 0 ]; then gd_die "--run needs macOS (or --app PATH --allow-non-mac to pack an existing bundle)"; fi
  gd_warn "not macOS: codesign, notarytool and the app build are skipped or only printed"
fi
command -v go >/dev/null || { [ "$GD_RUN" = 1 ] && gd_die "Go is needed to build ql/ra-ca" || gd_warn "go not found"; }
[ -f "$RA_REPO/cmd/ql/main.go" ] || { [ "$GD_RUN" = 1 ] && gd_die "rotten-apple checkout not found: RA_REPO=$RA_REPO" || gd_warn "RA_REPO not found: $RA_REPO"; }
if [ "$APPLE_SIGN" = 1 ]; then
  gd_need GD_DEVID_APP_IDENTITY "Developer ID Application certificate NAME (only for --apple-sign)"
  [ "$ON_MAC" = 1 ] && [ -n "$GD_DEVID_APP_IDENTITY" ] && ! gd_have_identity "$GD_DEVID_APP_IDENTITY" && gd_die "identity not in keychain: $GD_DEVID_APP_IDENTITY"
fi
[ "$NOTARIZE" = 1 ] && gd_need GD_NOTARY_PROFILE "notarytool keychain profile name (only for --notarize)"

# ---- 1. tools ------------------------------------------------------------------------------------
gd_log "1. build ql and ra-ca from $RA_REPO"
gd_run mkdir -p "$BIN"
gd_run go -C "$RA_REPO" build -o "$BIN/" ./cmd/ql ./cmd/ra-ca

# ---- 2. Rotten Apple developer key ---------------------------------------------------------------
if [ "$TEST_CA" = 1 ]; then
  gd_log "2. TEST CA in $CA (throwaway; a production launcher refuses it)"
  if [ "$GD_RUN" = 0 ] || [ ! -f "$CA/root.key" ]; then gd_run "$BIN/ra-ca" init --out "$CA"; fi
  if [ "$GD_RUN" = 0 ] || [ ! -f "$CA/dev.key" ]; then gd_run "$BIN/ra-ca" issue --root-key "$CA/root.key" --team "$TEAM" --name "Gendragoon (test)" --out "$CA/dev"; fi
else
  gd_log "2. developer key from $CA (must contain dev.key, dev.cert.json, root.pub)"
  for f in dev.key dev.cert.json root.pub; do
    [ -f "$CA/$f" ] || { [ "$GD_RUN" = 1 ] && gd_die "missing $CA/$f" || gd_warn "missing $CA/$f"; }
  done
  [ -f "$CA/dev.key" ] && [ "$(stat -f %Lp "$CA/dev.key" 2>/dev/null || stat -c %a "$CA/dev.key")" != 600 ] && gd_warn "$CA/dev.key should be mode 600"
fi

# ---- 3. build and code-sign the app --------------------------------------------------------------
if [ -z "$APP_IN" ]; then
  IDENT="-"; [ "$APPLE_SIGN" = 1 ] && IDENT="$GD_DEVID_APP_IDENTITY"
  gd_log "3. build the app ($([ "$APPLE_SIGN" = 1 ] && echo "Developer ID" || echo "AD-HOC, no Apple account needed")), distribution marker rotten-apple"
  [ "$GD_RUN" = 1 ] && [ -e "$GD_OUT/app/$APP_NAME" ] && gd_die "$GD_OUT/app already holds a build; use a fresh GD_OUT"
  gd_run python3 "$GD_REPO/native/build_macos.py" --base-app "$GD_BASE_APP" --output "$GD_OUT/app" --identity "$IDENT" --distribution rotten-apple
else
  gd_log "3. packing an existing bundle: $APP (not rebuilt; it must already carry the rotten-apple marker and a signature)"
fi
if [ "$ON_MAC" = 1 ]; then
  gd_run /usr/bin/codesign --verify --deep --strict "$APP"
  gd_run /usr/bin/codesign -dv "$APP"
fi

# ---- 4. optional Apple notarization ----------------------------------------------------------------
if [ "$NOTARIZE" = 1 ]; then
  gd_log "4. notarize + staple (optional; sends the build to Apple's notary service only)"
  gd_run /usr/bin/ditto -c -k --keepParent "$APP" "$GD_OUT/notarize.zip"
  gd_run xcrun notarytool submit "$GD_OUT/notarize.zip" --keychain-profile "$GD_NOTARY_PROFILE" --wait
  gd_run xcrun stapler staple "$APP"
  gd_run spctl --assess --type execute -vv "$APP"
else
  gd_log "4. notarization skipped (default). Fine inside ra-launcher; outside it Gatekeeper blocks a quarantined copy."
fi

# ---- 5. ql inspect / pack / verify -----------------------------------------------------------------
gd_log "5. ql inspect"
gd_run "$BIN/ql" inspect "$APP"
PACK=("$BIN/ql" pack "$APP" --key "$CA/dev.key" --cert "$CA/dev.cert.json" --team "$TEAM" --out "$PKG"
  --service launcher.settings --service launcher.window --service store.listing --service crash
  --service updates
  --link com.redxai.redx:storage:provides)
# No com.redxai.redx:db:uses link: Rotten Apple requires data.database.kind redx for it, and Gendragoon keeps its own
# backend (joint design decision 10-a). RedX stays optional for Gendragoon; the provides link is what the store needs.
STORE=(--service data.storage --storage gendragoon); for p in $GD_STORAGE_PURPOSES; do STORE+=(--storage-purpose "$p"); done
# TODO(rotten-apple audit-fill): Grok Bot is relaxing `ql pack --storage` so a provider package does not need
# --data redx. Until that lands, `--storage gendragoon` without --data fails with "--storage needs --data redx";
# --storage auto tries it and falls back to links only (role provides) and drops --service data.storage, which
# that older ql also refuses without a data block. Drop the fallback once audit-fill is merged.
# (Rotten Apple main 9019e9c already accepts data.storage for a package with a storage:provides link.)
gd_log "   ql pack (storage: $STORAGE)"
if [ "$STORAGE" = off ]; then
  gd_run "${PACK[@]}"
elif [ "$GD_RUN" = 0 ]; then
  gd_run "${PACK[@]}" "${STORE[@]}"
  [ "$STORAGE" = auto ] && gd_log "   (auto: if this ql still needs --data redx for --storage, the same command runs again without --storage)"
else
  rm -f "$PKG"
  printf '  $'; printf ' %q' "${PACK[@]}" "${STORE[@]}"; printf '\n'
  if ! out="$("${PACK[@]}" "${STORE[@]}" 2>&1)"; then
    if [ "$STORAGE" = auto ] && grep -q -- "--storage needs --data redx" <<<"$out"; then
      gd_warn "this ql needs --data redx for --storage (pre audit-fill); packing with links only"
      gd_run "${PACK[@]}"
    else
      printf '%s\n' "$out" >&2; gd_die "ql pack failed"
    fi
  else
    printf '%s\n' "$out"
  fi
fi
ROOTFLAG="gendragoon-ca=\$(cat $CA/root.pub)$([ "$TEST_CA" = 1 ] && echo ,test)"
gd_log "   ql verify against $ROOTFLAG"
if [ "$GD_RUN" = 1 ]; then
  ROOT="gendragoon-ca=$(cat "$CA/root.pub")$([ "$TEST_CA" = 1 ] && echo ,test)"
  VERIFY=("$BIN/ql" verify "$PKG" --root "$ROOT"); [ "$PRODUCTION" = 1 ] && VERIFY+=(--production)
  gd_run "${VERIFY[@]}"
  gd_run shasum -a 256 "$PKG" 2>/dev/null || gd_run sha256sum "$PKG"
else
  gd_run "$BIN/ql" verify "$PKG" --root "$ROOTFLAG" $([ "$PRODUCTION" = 1 ] && echo --production)
fi
gd_log "package: $PKG$([ "$TEST_CA" = 1 ] && echo '  (TEST-signed: only a launcher pinning this TEST root installs it)')"
gd_summary
