#!/usr/bin/env python3
"""Disposable real-macOS app lifecycle smoke test, with a 120-second wall limit.

Run with the installed Python 3.10+ runtime. Only local fixture apps are compiled,
ad hoc signed, opened, and removed. The production helpers are loaded unchanged;
their path constants point into this script's private temporary fixture home.
No cloud client, credential, network operation, or security-policy change is used.
A failed test retains its small fixture directory for inspection.
"""

# Bundled helpers are signed resources: imports must never create or update caches.
import os, sys
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
import argparse
import contextlib
import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import plistlib
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

MAX_SECONDS = 120
PREPARATION_SECONDS = 20
CASE_SECONDS = 30
FINAL_CHECK_SECONDS = 5
CLEANUP_SECONDS = 5
MAX_FIXTURE_BYTES = 5 * 1024 * 1024
PROJECT = "fixture-project"
BUCKET = "fixture-bucket"
REMOTE = "fixture"
MARKER = ".gendragoon-smoke-fixture.json"
SOURCE = r'''
#import <AppKit/AppKit.h>
#include <fcntl.h>
#include <signal.h>
#include <unistd.h>

@interface GDSmokeDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic) int resourceFD;
@end
@implementation GDSmokeDelegate
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    (void)notification;
    NSString *resource = [[NSBundle mainBundle] pathForResource:@"fixture" ofType:@"dat"];
    self.resourceFD = open([resource fileSystemRepresentation], O_RDONLY);
    if ([[[NSBundle mainBundle] objectForInfoDictionaryKey:@"GDSmokeMutatesCache"] boolValue]) {
        int writer = open([resource fileSystemRepresentation], O_WRONLY | O_TRUNC);
        if (writer >= 0) {
            const char changed[] = "fixture changed itself while running\n";
            (void)write(writer, changed, sizeof(changed) - 1);
            (void)fsync(writer);
            (void)close(writer);
        }
    }
    [NSTimer scheduledTimerWithTimeInterval:2.0 target:self selector:@selector(finish:)
                                  userInfo:nil repeats:NO];
}
- (void)finish:(NSTimer *)timer {
    (void)timer;
    if (self.resourceFD >= 0) (void)close(self.resourceFD);
    [NSApp terminate:nil];
}
@end
static GDSmokeDelegate *delegate;
static void ownDeadline(int ignored) { (void)ignored; _exit(0); }
int main(void) {
    @autoreleasepool {
        // This fixture exits itself even if its event loop cannot start.
        signal(SIGALRM, ownDeadline);
        alarm(4);
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
        delegate = [GDSmokeDelegate new];
        delegate.resourceFD = -1;
        app.delegate = delegate;
        [app run];
    }
    return 0;
}
'''


def require(condition, message):
    if not condition:
        raise AssertionError(message)


class SmokeDeadline(BaseException):
    """Do not let production helpers' ordinary Exception handlers swallow a harness deadline."""


class SmokeBudget:
    def __init__(self, timings, clock=None, timer=None):
        self.clock = clock or time.monotonic
        self.timer = timer or (lambda seconds: signal.setitimer(signal.ITIMER_REAL, seconds))
        self.started = self.clock()
        self.deadline = self.started + MAX_SECONDS
        self.timings = timings
        self.active_phase = "total"
        self.active_deadline = self.deadline

    def expire(self, _signum=None, _frame=None):
        phase = "total" if self.clock() >= self.deadline else self.active_phase
        raise SmokeDeadline("Disposable macOS smoke deadline reached: " + phase)

    @contextlib.contextmanager
    def phase(self, name, seconds):
        started = self.clock()
        deadline = min(started + seconds, self.deadline)
        if started >= deadline:
            self.expire()
        self.active_phase, self.active_deadline = name, deadline
        record = {"limitSeconds": seconds, "availableSeconds": round(deadline - started, 3),
                  "startedOffsetSeconds": round(started - self.started, 3), "completed": False}
        self.timings[name] = record
        self.timer(deadline - started)
        try:
            yield deadline
            if self.clock() >= deadline:
                self.expire()
            record["completed"] = True
        finally:
            record["seconds"] = round(self.clock() - started, 3)
            self.active_phase, self.active_deadline = "total", self.deadline
            self.timer(max(.001, self.deadline - self.clock()))


@contextlib.contextmanager
def measured_step(timings, name):
    started = time.monotonic()
    try:
        yield
    finally:
        timings[name] = round(time.monotonic() - started, 3)


def helper_modules(resources, fixture_home):
    resources = resources.resolve(strict=True)
    for name in ("gendragoon_library.py", "gendragoon_app_launch.py", "gendragoon_upload_workspace.py"):
        path = resources / name
        require(path.is_file() and not path.is_symlink(), "Missing or linked native helper: " + name)
    sys.path.insert(0, str(resources))
    library = importlib.import_module("gendragoon_library")
    # Do not change the process HOME or any user's app settings/configuration.
    library.HOME = fixture_home
    library.SUPPORT = fixture_home / "Library/Application Support/GenDragoon Cloud SSD"
    library.CONFIG = library.SUPPORT / "fixture-rclone.conf"
    library.CACHE = library.SUPPORT / "AppLibrary"
    library.INDEX = library.SUPPORT / "app-library.json"
    library.RCLONE = fixture_home / "NO_CLOUD_EXECUTABLE"
    launcher = importlib.import_module("gendragoon_app_launch")
    launcher.ROOT = library.SUPPORT / "LaunchSessions"
    launcher.RESOURCE = resources
    return library, launcher


def validate_fixture(path, token):
    require(path.is_absolute() and not path.is_symlink(), "Invalid fixture home")
    require(path.name.startswith("gd-macos-smoke-"), "Worker was not given a smoke fixture")
    require(path.resolve(strict=True) == path, "Fixture path must be canonical")
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077,
            "Fixture home must be private and owned by the current user")
    marker = path / MARKER
    require(marker.is_file() and not marker.is_symlink(), "Missing fixture marker")
    record = json.loads(marker.read_text())
    require(record == {"token": token, "uid": os.getuid()}, "Fixture ownership marker mismatch")


def worker(resources, fixture_home, token, session):
    validate_fixture(fixture_home, token)
    _, launcher = helper_modules(resources, fixture_home)
    launcher.watch(session)
    receipt = launcher.read(session)
    # Dirty content is an expected retained state; the parent checks its reason.
    return 0 if receipt["state"] in {"exited-cleaned", "exited-retained", "failed-retained"} else 1


def directory_bytes(root):
    return sum(path.stat().st_size for path in root.rglob("*") if path.is_file() and not path.is_symlink())


def checked_command(command, deadline, timeout=12):
    remaining = deadline - time.monotonic()
    require(remaining > 0, "Smoke test exceeded its time budget")
    result = subprocess.run([str(part) for part in command], stdin=subprocess.DEVNULL,
                            capture_output=True, text=True, timeout=min(timeout, remaining))
    if result.returncode:
        raise RuntimeError(Path(str(command[0])).name + " failed: " + (result.stderr or result.stdout)[-1600:])
    return result.stdout


def compile_fixture(home, deadline):
    source = home / "fixture.m"
    source.write_text(SOURCE)
    binary = home / "GenDragoonSmoke"
    checked_command(["/usr/bin/xcrun", "clang", "-x", "objective-c", "-fobjc-arc", "-Os",
                     "-framework", "AppKit", source, "-o", binary], deadline, timeout=15)
    require(binary.is_file(), "Compiler did not produce the fixture executable")
    require(binary.stat().st_size < 1024 * 1024, "Fixture executable unexpectedly exceeds 1 MiB")
    return binary


def stage_case(home, library, launcher, binary, token, case, deadline):
    name = "GenDragoon Smoke " + case + ".app"
    source = home / "FixtureSources" / name
    (source / "Contents/MacOS").mkdir(parents=True, mode=0o700)
    (source / "Contents/Resources").mkdir(mode=0o700)
    shutil.copy2(binary, source / "Contents/MacOS/GenDragoonSmoke")
    (source / "Contents/Resources/fixture.dat").write_bytes(b"unchanged fixture resource\n")
    with (source / "Contents/Info.plist").open("wb") as output:
        plistlib.dump({"CFBundleIdentifier": "app.gendragoon.smoke." + token + "." + case,
                      "CFBundleName": "GenDragoon Smoke " + case,
                      "CFBundleExecutable": "GenDragoonSmoke", "CFBundlePackageType": "APPL",
                      "CFBundleVersion": "1", "CFBundleShortVersionString": "1.0",
                      "CFBundleSupportedPlatforms": ["MacOSX"], "LSUIElement": True,
                      "GDSmokeMutatesCache": case == "dirty"}, output)
    checked_command(["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", source], deadline, timeout=6)
    checked_command(["/usr/bin/codesign", "--verify", "--deep", "--strict", source], deadline, timeout=6)
    manifest = library.snapshot(source)["manifest"]
    key = hashlib.sha256((token + ":" + case).encode()).hexdigest()[:18]
    target = library.CACHE / key / name
    target.parent.mkdir(parents=True, mode=0o700)
    shutil.copytree(source, target)
    library.cache_record(target.parent, manifest)
    entry = {"name": name, "kind": "app", "format": "raw", "remote": REMOTE, "project": PROJECT,
             "bucket": BUCKET, "folder": BUCKET + "/Fixtures", "cloudPath": BUCKET + "/Fixtures/" + name,
             "manifest": manifest, "verified": True}
    library.store(key, entry)
    # Exercise the real existing-cache restore/integrity path. No download and
    # no free-space guard override are needed for this pre-staged tiny bundle.
    with library.maintenance_lock(), contextlib.redirect_stdout(io.StringIO()):
        library.stage_item(key, False, PROJECT, BUCKET, REMOTE)
    launcher.compatible(target)
    identifier = uuid.uuid4().hex
    launcher_identity = launcher.process_identity(os.getpid())
    require(launcher_identity is not None, "Could not establish the smoke runner's ps/proc_pidpath identity")
    receipt = {"id": identifier, "key": key, "name": name, "project": PROJECT, "bucket": BUCKET,
               "remote": REMOTE, "state": "launching", "mode": "managed-local", "keepCache": case == "keep",
               "createdAt": time.time(), "cachePath": str(target), "launcherPid": os.getpid(),
               "launcherIdentity": launcher_identity}
    launcher.save(receipt)
    return {"case": case, "source": source, "target": target, "manifest": manifest,
            "key": key, "id": identifier, "entry": entry}


def observe_and_finish(case, launcher, process, deadline, diagnostics=None):
    diagnostics = diagnostics if diagnostics is not None else {}
    started = time.monotonic()
    observed = None
    while time.monotonic() < deadline:
        receipt = launcher.read(case["id"])
        diagnostics["state"] = receipt["state"]
        if receipt["state"] == "running":
            pid = receipt.get("pid")
            identity = launcher.process_identity(pid)
            if identity is not None and identity["executable"].startswith(str(case["target"]) + "/"):
                require(launcher.watcher_alive(receipt), "Application monitor identity did not match its running process")
                # These are the actual production kernel/ps/lsof functions.
                require(launcher.pid_path(pid) == identity["executable"], "proc_pidpath did not match the launched fixture")
                require(pid in launcher.resource_pids(case["target"]), "lsof did not observe the fixture's open bundle resources")
                observed = {"pidPathVerified": True, "startTimeVerified": bool(identity["started"]),
                            "openResourceVerified": True, "watcherIdentityVerified": True}
                diagnostics["observedAfterSeconds"] = round(time.monotonic() - started, 3)
                break
        if receipt["state"] in launcher.TERMINAL or process.poll() is not None:
            raise AssertionError("Fixture exited before real process/resource checks: " + str(receipt.get("message", receipt["state"])))
        time.sleep(.025)
    require(observed is not None, "Timed out observing the locally signed fixture")
    while time.monotonic() < deadline:
        receipt = launcher.read(case["id"])
        diagnostics["state"] = receipt["state"]
        if receipt["state"] in launcher.TERMINAL and process.poll() is not None:
            require(process.returncode == 0, "Fixture monitor worker failed")
            diagnostics["terminalAfterSeconds"] = round(time.monotonic() - started, 3)
            return receipt, observed
        if process.poll() is not None and receipt["state"] not in launcher.TERMINAL:
            raise AssertionError("Fixture monitor exited without completing its lifecycle")
        time.sleep(.1)
    raise TimeoutError("Fixture monitor did not complete before its independent case deadline")


def main(args):
    require(sys.platform == "darwin", "This smoke test must run on macOS")
    require(sys.version_info >= (3, 10), "Python 3.10 or newer is required")
    if args.worker:
        return worker(args.resources, args.fixture_home, args.token, args.session)
    processes = []
    output = {"ok": False, "cases": [], "timings": {}, "preparationStepSeconds": {},
              "limits": {"totalSeconds": MAX_SECONDS, "preparationSeconds": PREPARATION_SECONDS,
                         "caseSeconds": CASE_SECONDS, "caseCount": 3, "finalCheckSeconds": FINAL_CHECK_SECONDS,
                         "cleanupSeconds": CLEANUP_SECONDS, "fixtureBytes": MAX_FIXTURE_BYTES,
                         "fixtureSelfExitSeconds": 4, "productionQuietChecks": 5},
              "signing": "local ad hoc", "cloudOperations": 0, "securityPolicyChanges": False}
    budget = SmokeBudget(output["timings"])
    previous_alarm = signal.signal(signal.SIGALRM, budget.expire)
    signal.setitimer(signal.ITIMER_REAL, MAX_SECONDS)
    home = None
    success = False
    try:
        with budget.phase("preparation", PREPARATION_SECONDS) as preparation_deadline:
            home = Path(tempfile.mkdtemp(prefix="gd-macos-smoke-")).resolve(strict=True)
            home.chmod(0o700)
            token = uuid.uuid4().hex
            marker = home / MARKER
            marker.write_text(json.dumps({"token": token, "uid": os.getuid()}))
            marker.chmod(0o600)
            library, launcher = helper_modules(args.resources, home)
            library.prepare_cache()
            library.CONFIG.write_text("[fixture]\ntype = memory\n")
            library.CONFIG.chmod(0o600)
            with measured_step(output["preparationStepSeconds"], "compile"):
                binary = compile_fixture(home, preparation_deadline)
            staged = []
            for name in ("cleanup", "keep", "dirty"):
                with measured_step(output["preparationStepSeconds"], "stage_" + name):
                    staged.append(stage_case(home, library, launcher, binary, token, name, preparation_deadline))
            output["fixtureBytes"] = directory_bytes(home)
            require(output["fixtureBytes"] < MAX_FIXTURE_BYTES, "Fixture data exceeds the 5 MiB budget")
            initial_index = library.load()
        for case in staged:
            diagnostics = {"case": case["case"], "ok": False, "state": "launching"}
            output["cases"].append(diagnostics)
            with budget.phase("case_" + case["case"], CASE_SECONDS) as case_deadline:
                log = home / (case["case"] + "-worker.log")
                with log.open("wb") as errors:
                    log.chmod(0o600)
                    process = subprocess.Popen([sys.executable, "-B", str(Path(__file__).resolve()), "--worker",
                        "--resources", str(args.resources.resolve()), "--fixture-home", str(home), "--token", token,
                        "--session", case["id"]], stdin=subprocess.DEVNULL, stdout=errors, stderr=errors)
                processes.append(process)
                receipt, observed = observe_and_finish(case, launcher, process, case_deadline, diagnostics)
                expected = {"cleanup": "exited-cleaned", "keep": "exited-retained", "dirty": "failed-retained"}[case["case"]]
                require(receipt["state"] == expected, case["case"] + " ended in " + receipt["state"] + ": " + str(receipt.get("message", "")))
                require(case["target"].exists() == (case["case"] != "cleanup"), "Incorrect cache retention for " + case["case"])
                if case["case"] == "dirty":
                    require("Restored content" in receipt.get("message", ""), "Dirty cache was retained for an unexpected reason")
                    require((case["target"] / "Contents/Resources/fixture.dat").read_bytes() == b"fixture changed itself while running\n",
                            "Changed fixture content was not preserved")
                elif case["case"] == "keep":
                    library.verify_restored(case["target"], case["manifest"])
                library.verify_restored(case["source"], case["manifest"])
                require(library.load() == initial_index, "A launch or cleanup changed the cloud library index")
                require(not launcher.watcher_alive(receipt), "Finished fixture left its monitor process running")
                diagnostics.update(state=receipt["state"], cacheRetained=case["target"].exists(),
                                   sourcePreserved=True, **observed)
            diagnostics["ok"] = True
        with budget.phase("final_checks", FINAL_CHECK_SECONDS):
            require(not launcher.sessions()["busy"], "A fixture session is still active after its worker exited")
            require(directory_bytes(home) < MAX_FIXTURE_BYTES, "Fixture data grew beyond its 5 MiB budget")
        success = True
    except (Exception, SmokeDeadline) as error:
        output.update(error=str(error))
    finally:
        # Only terminate harness workers this test itself created. Fixture apps
        # exit themselves; no existing app or unrelated process is signaled.
        try:
            with budget.phase("harness_cleanup", CLEANUP_SECONDS):
                for process in processes:
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=.5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=.5)
                if success:
                    shutil.rmtree(home)
        except (Exception, SmokeDeadline) as error:
            success = False
            output["cleanupError"] = str(error)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous_alarm)
        output.update(ok=success, seconds=round(time.monotonic() - budget.started, 3))
        if not success and home is not None:
            output["fixtureRetained"] = str(home)
        print(json.dumps(output, sort_keys=True), flush=True)
    return 0 if success else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resources", type=Path, default=Path(__file__).resolve().parents[1] / "Resources")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--fixture-home", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--token", help=argparse.SUPPRESS)
    parser.add_argument("--session", help=argparse.SUPPRESS)
    try:
        sys.exit(main(parser.parse_args()))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}), flush=True)
        sys.exit(1)
