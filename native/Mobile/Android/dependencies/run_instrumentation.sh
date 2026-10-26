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
# Bind results to the actual booted OS rather than just the requested AVD name.
# The old API 35 16 KiB image crashed system_server in accessibility services;
# retain that distinction from app/native failures on replacement fixtures.
for property in ro.build.fingerprint ro.build.version.sdk ro.build.version.release ro.product.cpu.abilist; do
    printf '%s=' "$property" >> "$report/device-properties.txt"
    adb shell getprop "$property" | tr -d '\r' >> "$report/device-properties.txt"
done
printf 'page_size=%s\n' "$pages" >> "$report/device-properties.txt"
emulator_binary="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}/emulator/emulator"
if test -x "$emulator_binary"; then
    "$emulator_binary" -version 2>&1 | head -n 3 > "$report/emulator-version.txt" || true
fi
adb shell cat /proc/meminfo > "$report/memory-before.txt"
timeout 10m gradle :app:connectedDebugAndroidTest --rerun-tasks --no-daemon --console=plain --stacktrace
