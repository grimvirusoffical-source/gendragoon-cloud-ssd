#!/usr/bin/env python3
"""Refresh a stopped, explicitly supplied staging bundle; never install an app.

Node's exact archive digest is from the signed SHASUMS section of its official
24.22.0 release page. This update does not resolve the announced Oct 21, 2026
Node security release. See VENDOR_REFRESH.md for the release sequence.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import ssl
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

VERSION = "24.22.0"
ARCHIVE = f"node-v{VERSION}-darwin-arm64.tar.gz"
ARCHIVE_URL = f"https://nodejs.org/dist/v{VERSION}/{ARCHIVE}"
ARCHIVE_SHA256 = "6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5"
CHECKSUM_SOURCE = f"https://nodejs.org/en/blog/release/v{VERSION}#shasums"
SECURITY_NOTICE = "https://nodejs.org/en/blog/vulnerability/october-2026-security-releases"
NAME = "GenDragoon Cloud SSD.app"
BUNDLE_ID = "app.gendragoon.cloudssd"
TEAM = "NZPU8H843J"
IDENTITY = f"Developer ID Application: Joshua Franklin ({TEAM})"
REQUIREMENT = f'anchor apple generic and certificate leaf[subject.OU] = "{TEAM}"'
NODE_ENTITLEMENTS = {"com.apple.security.cs.allow-jit": True,
                     "com.apple.security.cs.allow-unsigned-executable-memory": True}
MAX_DOWNLOAD = 80 * 1024**2
MAX_UNPACKED = 512 * 1024**2
MAX_NODE = 200 * 1024**2
RESERVE = 1024**3


def run(command, timeout=60, accepted=(0,)):
    result = subprocess.run([str(x) for x in command], capture_output=True,
                            timeout=timeout, env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C"})
    if result.returncode not in accepted:
        detail = (result.stdout + result.stderr).decode("utf-8", "replace")[-3000:]
        raise RuntimeError(f"{Path(command[0]).name} failed ({result.returncode}): {detail}")
    return result


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024**2), b""):
            value.update(block)
    return value.hexdigest()


def staged_path(app):
    """Reject aliases, install locations, shared files and untrusted bundle trees."""
    app = Path(app)
    if not app.is_absolute() or ".." in app.parts or app.name != NAME:
        raise ValueError("Supply the absolute path of a staged GenDragoon Cloud SSD.app")
    if any(p.casefold() in {"applications", "system", "library", "bin", "sbin", "usr", "opt", "volumes"} for p in app.parts[:-1]):
        raise ValueError("Installed/system application locations are not staging folders")
    for item in (app, *app.parents):
        if item.is_symlink() or (item != app and item.suffix.casefold() == ".app"):
            raise ValueError("Staged bundle paths must not traverse symlinks or another app")
    if not app.is_dir() or app.stat().st_uid != os.getuid() or app.parent.stat().st_uid != os.getuid():
        raise ValueError("Use a staging folder and bundle owned by the current user")
    if app.stat().st_mode & 0o022 or app.parent.stat().st_mode & 0o022:
        raise ValueError("Staging folder and bundle must not be writable by other users")
    count = 0
    for parent, directories, files in os.walk(app, followlinks=False):
        for name in directories + files:
            info = (Path(parent)/name).lstat()
            count += 1
            if count > 100000 or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                raise ValueError("Unsafe or excessively large staged bundle tree")
            if stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
                raise ValueError("Staged bundle contains a shared hard-linked file")
    info = plistlib.loads((app/"Contents/Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != BUNDLE_ID or info.get("CFBundleExecutable") != "GenDragoon Cloud SSD":
        raise ValueError("Staged GenDragoon bundle identity mismatch")
    for relative in ("Contents/Resources/gendragoon_node", "Contents/MacOS/GenDragoon Cloud SSD", "Contents/_CodeSignature/CodeResources"):
        if not (app/relative).is_file():
            raise ValueError("The staging bundle must already be built and signed")
    return app.stat().st_dev, app.stat().st_ino


def stopped(app):
    # lsof checks open files and mapped executable paths, including Node helpers.
    result = run(["/usr/sbin/lsof", "-nP", "-Fpn", "+D", app], timeout=30, accepted=(0, 1))
    if result.stderr.strip():
        raise RuntimeError("Could not fully inspect bundle use; staged files were retained")
    if result.returncode == 0 or result.stdout.strip():
        raise RuntimeError("The staged bundle is running or in use. Quit that candidate before refreshing it.")


def signature(path, deep=False):
    # codesign requires '=' to distinguish inline requirement source from a path.
    run(["/usr/bin/codesign", "--verify", "--strict", *( ["--deep"] if deep else []), "-R", "=" + REQUIREMENT, path])
    result = run(["/usr/bin/codesign", "-dv", "--verbose=4", path])
    values = (result.stdout + result.stderr).decode("utf-8", "strict")
    fields = dict(re.findall(r"^(Identifier|TeamIdentifier|CDHash)=(.+)$", values, re.M))
    if fields.get("TeamIdentifier") != TEAM or f"Authority={IDENTITY}\n" not in values or not re.fullmatch(r"[a-zA-Z0-9._-]+", fields.get("Identifier", "")):
        raise ValueError("The staged bundle must use its existing trusted Developer ID")
    if not re.fullmatch(r"[a-f0-9]{40,64}", fields.get("CDHash", "")):
        raise ValueError("Missing signed code identity")
    return fields


def entitlements(path):
    result = run(["/usr/bin/codesign", "-d", "--entitlements", ":-", path])
    return plistlib.loads(result.stdout) if result.stdout.strip() else {}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("Official vendor downloads must not redirect")


def download(destination):
    context = ssl.create_default_context(cafile="/etc/ssl/cert.pem")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                urllib.request.HTTPSHandler(context=context), NoRedirect())
    deadline = time.monotonic() + 180
    request = urllib.request.Request(ARCHIVE_URL, headers={"User-Agent": "GenDragoon-Vendor-Refresh/1"})
    with opener.open(request, timeout=20) as response, destination.open("xb") as output:
        if response.status != 200 or response.geturl() != ARCHIVE_URL:
            raise ValueError("Unexpected vendor download response")
        expected_size = response.headers.get("Content-Length")
        if expected_size and (not expected_size.isdigit() or not 0 < int(expected_size) <= MAX_DOWNLOAD):
            raise ValueError("Vendor archive exceeds download limit")
        total = 0
        while True:
            if time.monotonic() > deadline:
                raise TimeoutError("Vendor download exceeded its time limit")
            block = response.read(1024**2)
            if not block:
                break
            total += len(block)
            if total > MAX_DOWNLOAD:
                raise ValueError("Vendor archive exceeds download limit")
            output.write(block)
        output.flush(); os.fsync(output.fileno())
    if (expected_size and total != int(expected_size)) or digest(destination) != ARCHIVE_SHA256:
        raise ValueError("Official Node archive failed its pinned SHA-256/size verification")


class LimitedReader:
    def __init__(self, source):
        self.source, self.total = source, 0

    def read(self, size):
        value = self.source.read(min(size, MAX_UNPACKED - self.total + 1))
        self.total += len(value)
        if self.total > MAX_UNPACKED:
            raise ValueError("Vendor archive exceeds expanded-size limit")
        return value


def extract_selected(archive, destination):
    prefix = f"node-v{VERSION}-darwin-arm64/"
    wanted = {prefix+"bin/node": ("node", MAX_NODE), prefix+"LICENSE": ("LICENSE", 2*1024**2)}
    seen = set()
    with gzip.open(archive, "rb") as compressed, tarfile.open(fileobj=LimitedReader(compressed), mode="r|") as package:
        for count, member in enumerate(package, 1):
            if count > 50000 or member.size < 0 or member.size > MAX_UNPACKED:
                raise ValueError("Vendor archive exceeds entry/size limits")
            if member.name not in wanted:
                continue
            name, limit = wanted[member.name]
            if member.name in seen or not member.isreg() or member.issparse() or not 0 < member.size <= limit:
                raise ValueError("Invalid or duplicate Node/LICENSE archive entry")
            seen.add(member.name)
            with package.extractfile(member) as source, (destination/name).open("xb") as output:
                size = 0
                for block in iter(lambda: source.read(1024**2), b""):
                    size += len(block)
                    if size > member.size:
                        raise ValueError("Invalid vendor entry size")
                    output.write(block)
                if size != member.size:
                    raise ValueError("Truncated vendor entry")
    if seen != set(wanted):
        raise ValueError("The exact official Node and LICENSE entries were not found")
    node = destination/"node"
    macho_arm64(node)
    node.chmod(0o755)
    return node, destination/"LICENSE"


def macho_arm64(node):
    with node.open("rb") as source:
        header = source.read(32)
    if len(header) != 32:
        raise ValueError("Truncated Mach-O executable")
    magic, cpu, subtype, kind, commands, command_bytes, flags, reserved = struct.unpack("<8I", header)
    if magic != 0xfeedfacf or cpu != 0x0100000c or kind != 2 or not 0 < commands <= 10000 or not commands*8 <= command_bytes <= node.stat().st_size-32:
        raise ValueError("Vendor binary is not a native arm64 Mach-O executable")


def sign(path, identifier, rights, work):
    command = ["/usr/bin/codesign", "--force", "--options", "runtime", "--timestamp", "--sign", IDENTITY, "--identifier", identifier]
    if rights:
        entitlement_file = work/("node-entitlements.plist" if identifier != BUNDLE_ID else "app-entitlements.plist")
        entitlement_file.write_bytes(plistlib.dumps(rights))
        command += ["--entitlements", entitlement_file]
    run([*command, path], timeout=120)


def replace_staged(app, candidate, work, identity):
    """Keep the old candidate if a swap or final strict verification fails."""
    if staged_path(app) != identity[0] or signature(app, deep=True) != identity[1]:
        raise ValueError("The original staging bundle changed during refresh")
    stopped(app)
    backup = work/"previous.app"
    (work/"recovery.json").write_text(json.dumps({"staged_app": str(app), "backup": str(backup)}), encoding="utf-8")
    app.rename(backup)
    try:
        candidate.rename(app)
        signature(app, deep=True)
    except BaseException:
        if app.exists():
            app.rename(work/"failed.app")
        backup.rename(app)
        raise


def refresh(app):
    if sys.platform != "darwin":
        raise RuntimeError("Run the staged vendor refresh on macOS")
    filesystem_identity = staged_path(app)
    stopped(app)
    original_signature = signature(app, deep=True)
    if original_signature["Identifier"] != BUNDLE_ID:
        raise ValueError("Unexpected GenDragoon signing identifier")
    old_node = app/"Contents/Resources/gendragoon_node"
    node_signature = signature(old_node)
    node_rights, app_rights = entitlements(old_node), entitlements(app)
    if node_rights != NODE_ENTITLEMENTS:
        raise ValueError("Existing Node JIT entitlements differ from the reviewed build configuration")
    if shutil.disk_usage(app.parent).free < RESERVE + MAX_DOWNLOAD + MAX_UNPACKED:
        raise ValueError("Insufficient free space for the bounded vendor refresh")
    work = Path(tempfile.mkdtemp(prefix=".gendragoon-vendor-refresh-", dir=app.parent))
    succeeded = False
    try:
        print("Downloading and verifying official Node " + VERSION, flush=True)
        archive = work/ARCHIVE
        download(archive)
        node, license_file = extract_selected(archive, work)
        source_hash = digest(node)
        sign(node, node_signature["Identifier"], node_rights, work)
        signature(node)
        if entitlements(node) != node_rights or run([node, "--version"], timeout=15).stdout.strip() != ("v"+VERSION).encode():
            raise ValueError("The signed Node runtime failed version/entitlement verification")
        print("Signing and verifying a private copy of the staging bundle", flush=True)
        candidate = work/NAME
        run(["/bin/cp", "-cR", app, candidate], timeout=120)
        resources = candidate/"Contents/Resources"
        node.replace(resources/"gendragoon_node")
        license_file.replace(resources/"gendragoon_node.LICENSE")
        provenance = {"schema": 1, "vendor": "Node.js", "version": VERSION, "platform": "darwin", "architecture": "arm64",
            "archive_url": ARCHIVE_URL, "archive_sha256": ARCHIVE_SHA256, "checksum_source": CHECKSUM_SOURCE,
            "source_binary_sha256": source_hash, "signed_binary_sha256": digest(resources/"gendragoon_node"),
            "license": "gendragoon_node.LICENSE", "developer_id": IDENTITY, "team": TEAM,
            "refreshed_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "security_notice": SECURITY_NOTICE,
            "security_limit": "As of 2026-10-17, HIGH-severity fixes for Node 24.x are announced for on/after 2026-10-21; this refresh does not claim those unreleased fixes."}
        (resources/"node-vendor-provenance.json").write_text(json.dumps(provenance, indent=2)+"\n", encoding="utf-8")
        sign(candidate, BUNDLE_ID, app_rights, work)
        signature(candidate, deep=True)
        if entitlements(candidate) != app_rights:
            raise ValueError("Parent application entitlements changed")
        replace_staged(app, candidate, work, (filesystem_identity, original_signature))
        succeeded = True
        print("Verified staged bundle: " + str(app), flush=True)
        print("Node " + VERSION + "; provenance: Contents/Resources/node-vendor-provenance.json", flush=True)
        print("Notarization, stapling and Gatekeeper acceptance remain required. The announced Oct 21 security release remains pending.", flush=True)
    finally:
        # A failed rollback must never cause the only previous bundle to be deleted.
        if succeeded or not (work/"previous.app").exists():
            shutil.rmtree(work)
        else:
            print("Recovery copy retained at " + str(work), file=sys.stderr, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staged-app", required=True, type=Path, help="Absolute path to a stopped build/staging bundle; installed locations are rejected")
    arguments = parser.parse_args()
    try:
        refresh(arguments.staged_app)
    except (Exception, KeyboardInterrupt) as error:
        print("Vendor refresh failed: " + str(error), file=sys.stderr)
        sys.exit(1)
