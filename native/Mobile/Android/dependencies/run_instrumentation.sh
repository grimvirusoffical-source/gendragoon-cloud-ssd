#!/usr/bin/env bash
# Preserve actual emulator evidence even if Gradle or the process fails.
set -eu
pages="${1:?Expected 4096 or 16384}"
case "$pages" in 4096|16384) ;; *) exit 2 ;; esac
report="app/build/reports/instrumentation-$pages"
mkdir -p "$report"
finish() {
    result=$?
    trap - EXIT
    cp -R app/build/outputs/androidTest-results "$report/" 2>/dev/null || true
    cp -R app/build/reports/androidTests "$report/" 2>/dev/null || true
    adb logcat -d -v threadtime 2>/dev/null | tail -c 1048576 > "$report/logcat.txt" || true
    printf '%s\n' "$result" > "$report/exit-status.txt"
    exit "$result"
}
trap finish EXIT
test "$(adb shell getconf PAGE_SIZE | tr -d '\r')" = "$pages"
timeout 10m gradle :app:connectedDebugAndroidTest --rerun-tasks --no-daemon --console=plain --stacktrace
