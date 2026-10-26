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
    # Keep native/app crashes independently of noisy Google-services boot logs.
    adb logcat -b crash -d -v threadtime 2>/dev/null | tail -c 1048576 > "$report/crash-logcat.txt" || true
    adb logcat -d -v threadtime -s TestRunner:I GenDragoonMemory:I AndroidRuntime:E libc:F DEBUG:F lowmemorykiller:I lmkd:I ActivityManager:E system_server:E '*:S' 2>/dev/null | tail -c 1048576 > "$report/runtime-logcat.txt" || true
    adb logcat -d -v raw -s GenDragoonMemory:I '*:S' 2>/dev/null | tail -c 65536 > "$report/codec-memory.jsonl" || true
    adb shell dumpsys meminfo 2>/dev/null | head -c 131072 > "$report/memory-summary.txt" || true
    printf '%s\n' "$result" > "$report/exit-status.txt"
    exit "$result"
}
trap finish EXIT
test "$(adb shell getconf PAGE_SIZE | tr -d '\r')" = "$pages"
adb shell cat /proc/meminfo > "$report/memory-before.txt"
timeout 10m gradle :app:connectedDebugAndroidTest --rerun-tasks --no-daemon --console=plain --stacktrace
