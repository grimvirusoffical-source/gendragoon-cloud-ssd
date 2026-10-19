#!/usr/bin/env bash
# Cross-language interop check. Starts the local provider backend (PROVIDER_V1_ENABLED=true), connects one
# binding, and runs every SDK's interop participant twice against the same encrypted drive. Each participant
# must decrypt the files the others wrote. The first participant creates the master key.
#
#   sdk/contract/run.sh [lang ...]        languages: go js python csharp swift godot unreal (default: all available)
#
# Environment:
#   GD_DEV_SERVER   path to provider_dev_server.js (required unless GD_SDK_BASE is set)
#   GD_SDK_BASE     use an already running backend instead
#   DOTNET, SWIFT, GODOT, PYTHON   tool overrides
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
sdk="$(dirname "$here")"
langs=("$@")
[ ${#langs[@]} -gt 0 ] || langs=(go js python csharp swift godot unreal)
DOTNET="${DOTNET:-$(command -v dotnet || echo "$HOME/.dotnet/dotnet")}"
SWIFT="${SWIFT:-$(command -v swift || true)}"
GODOT="${GODOT:-$(command -v godot || true)}"
PYTHON="${PYTHON:-$([ -x "$sdk/python/.venv/bin/python" ] && echo "$sdk/python/.venv/bin/python" || command -v python3)}"

server_pid=""
cleanup() { [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true; }
trap cleanup EXIT

if [ -z "${GD_SDK_BASE:-}" ]; then
  : "${GD_DEV_SERVER:?set GD_DEV_SERVER to provider_dev_server.js or GD_SDK_BASE to a running backend}"
  fifo="$(mktemp -u)"; mkfifo "$fifo"
  # The server exits when its stdin closes; keep a writer open for the life of this script.
  exec 9<> <(:)
  PROVIDER_V1_ENABLED=true node "$GD_DEV_SERVER" --exit-with-stdin <&9 >"$fifo" &
  server_pid=$!
  read -r line <"$fifo"; rm -f "$fifo"
  GD_SDK_BASE="$(node -e 'console.log(JSON.parse(process.argv[1]).base)' "$line")"
fi
export GD_SDK_BASE

# Connect one binding with a dev-user token (the dev server accepts "Bearer dev-user:<uid>").
GD_SDK_KEY="$(node --input-type=module -e '
  const base = process.env.GD_SDK_BASE, auth = { Authorization: "Bearer dev-user:interop-" + Date.now(), "Content-Type": "application/json" };
  const g = await (await fetch(base + "/connect/grants", { method: "POST", headers: auth, body: JSON.stringify({ workspaceId: "ws", scopes: ["blobs:rw"], requester: { name: "Interop" } }) })).json();
  const c = await (await fetch(base + "/connect/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant: g.grant, client: { name: "Interop" } }) })).json();
  if (!c.apiKey) { console.error("connect failed", c); process.exit(1); }
  console.log(c.apiKey);')"
export GD_SDK_KEY GD_SDK_PASSPHRASE="interop passphrase"

participant() { # lang, extra flag
  case "$1" in
    go)     (cd "$sdk/go" && go run ./cmd/gd-interop ${2:+-init}) ;;
    js)     (cd "$sdk/js" && node dist/test/interop.js ${2:+--init}) ;;
    python) (cd "$sdk/python" && "$PYTHON" tests/interop.py ${2:+--init}) ;;
    csharp) (cd "$sdk/csharp" && "$DOTNET" run -c Release --project tests/Gendragoon.Sdk.Tests -- --interop ${2:+--init}) ;;
    swift)  (cd "$sdk/swift" && .build/release/gd-interop ${2:+--init}) ;;
    unreal) "$sdk/engines/unreal/test/build/cabi_test" --interop ${2:+--init} ;;
    godot)  (cd "$sdk/engines/godot" && "$GODOT" --headless --path . --script res://tests/interop.gd -- ${2:+--init} | grep '^{') ;;
  esac
}

available() {
  case "$1" in
    go) command -v go >/dev/null ;;
    js) (cd "$sdk/js" && npm run --silent build >/dev/null) ;;
    python) [ -n "$PYTHON" ] ;;
    csharp) [ -x "$DOTNET" ] && "$DOTNET" build -c Release "$sdk/csharp/tests/Gendragoon.Sdk.Tests" >/dev/null ;;
    swift) [ -n "$SWIFT" ] && (cd "$sdk/swift" && "$SWIFT" build -c release --product gd-interop >/dev/null 2>&1) ;;
    # The first editor run registers the addon's class names (.godot/ is not committed).
    godot) [ -n "$GODOT" ] && (cd "$sdk/engines/godot" && "$GODOT" --headless --editor --quit --path . >/dev/null 2>&1) ;;
    unreal) command -v go >/dev/null && command -v cc >/dev/null && "$sdk/engines/unreal/test/build.sh" >/dev/null ;;
    *) return 1 ;;
  esac
}

run=()
for l in "${langs[@]}"; do
  if available "$l"; then run+=("$l"); else echo "skip $l (toolchain not found)" >&2; fi
done
[ ${#run[@]} -gt 0 ] || { echo "no SDK toolchains found" >&2; exit 1; }

first=1
for round in 1 2; do
  for l in "${run[@]}"; do
    out="$(GD_SDK_LANG="$l" participant "$l" ${first:+init})"
    first=""
    echo "round $round: $out"
    if [ "$round" = 2 ]; then
      for want in "${run[@]}"; do
        node -e 'const o=JSON.parse(process.argv[1]); if(!o.verified.includes(process.argv[2])){console.error(o.lang+" did not verify "+process.argv[2]);process.exit(1)}' "$out" "$want"
      done
    fi
  done
done
echo "interop ok: ${run[*]}"

# C15 for the C ABI (the Unreal plugin's first session at L2) on a fresh binding.
if printf '%s\n' "${run[@]}" | grep -qx unreal; then
  GD_FIRST_RUN_GRANT="$(node --input-type=module -e '
    const r = await fetch(process.env.GD_SDK_BASE + "/connect/grants", { method: "POST", headers: { Authorization: "Bearer dev-user:firstrun-" + Date.now(), "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: "ws", scopes: ["blobs:rw"], requester: { name: "Unreal first run" } }) });
    console.log((await r.json()).grant);')" "$sdk/engines/unreal/test/build/cabi_test" --first-run >/dev/null \
    || { echo "unreal first run (C15) failed" >&2; exit 1; }
  echo "unreal first run (C15) ok"
fi
