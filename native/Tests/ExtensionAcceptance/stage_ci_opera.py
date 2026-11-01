#!/usr/bin/env python3
"""Stage a pinned official Opera data archive in disposable Linux CI only.

No package installer, maintainer script, registration, privilege change or system
directory is used. All browser data and notices remain inside the private fixture.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import time
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

VERSION = "139.0.6053.15"
PACKAGE_BYTES = 141108256
PACKAGE_SHA256 = "6f62faf4feb7f28f3673c55ad8bfe6d5f4e1c7a5eb0c772daf188de237537b6b"
PACKAGE_URL = "https://deb.opera.com/opera-stable/pool/non-free/o/opera-stable/opera-stable_139.0.6053.15_amd64.deb"
MAX_UNPACKED = 1024 * 1024 * 1024
MAX_MEMBERS = 20000


class OfficialRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        parsed = urlsplit(new_url)
        if (parsed.scheme != "https" or parsed.hostname != "deb.opera.com" or parsed.port not in (None,443)
                or parsed.username or parsed.password):
            raise RuntimeError("The Opera fixture left the official HTTPS package host.")
        return super().redirect_request(request, response, code, message, headers, new_url)


def fresh_destination(destination):
    if (os.environ.get("GITHUB_ACTIONS") != "true" or not sys.platform.startswith("linux")
            or platform.machine().lower() not in ("amd64", "x86_64")):
        raise RuntimeError("This browser fixture runs only on disposable Linux x86_64 GitHub Actions runners.")
    temporary = Path(os.environ["RUNNER_TEMP"]).resolve(strict=True)
    destination = Path(destination).absolute()
    if (destination == temporary or not destination.is_relative_to(temporary)
            or destination.exists() or destination.is_symlink() or destination.parent.resolve() != destination.parent):
        raise RuntimeError("Choose a fresh directory beneath the real RUNNER_TEMP directory.")
    if not destination.parent.is_dir():
        raise RuntimeError("The fixture parent directory must already exist.")
    destination.mkdir(mode=0o700)
    if destination.stat().st_uid != os.getuid() or destination.stat().st_mode & 0o077:
        raise RuntimeError("The new Opera fixture is not private to the runner user.")
    return destination


def download_package(destination):
    if shutil.disk_usage(destination).free < PACKAGE_BYTES + 64 * 1024 * 1024:
        raise RuntimeError("Insufficient space for the bounded Opera package download.")
    target = destination / "opera-stable.deb"
    request = Request(PACKAGE_URL, headers={"Accept-Encoding": "identity", "User-Agent": "GenDragoon-CI-browser-fixture/1"})
    checksum = hashlib.sha256(); total = 0; deadline = time.monotonic() + 300
    with build_opener(OfficialRedirects()).open(request, timeout=60) as response, target.open("xb") as output:
        target.chmod(0o600)
        parsed = urlsplit(response.geturl())
        if parsed.scheme != "https" or parsed.hostname != "deb.opera.com" or parsed.port not in (None,443):
            raise RuntimeError("The Opera fixture left the official package host.")
        length = response.headers.get("Content-Length")
        if length is not None and length != str(PACKAGE_BYTES):
            raise RuntimeError("The pinned Opera package has an unexpected advertised size.")
        while block := response.read(1024 * 1024):
            total += len(block)
            if total > PACKAGE_BYTES or time.monotonic() > deadline:
                raise RuntimeError("The Opera package exceeded its size or download-time bound.")
            checksum.update(block); output.write(block)
    if total != PACKAGE_BYTES or checksum.hexdigest() != PACKAGE_SHA256:
        raise RuntimeError("The pinned official Opera package failed its size or SHA256 check.")
    return target


def package_fields(package, executable):
    result = subprocess.run([executable, "--field", str(package)], stdin=subprocess.DEVNULL,
                            capture_output=True, check=True, timeout=30)
    if len(result.stdout) > 1024 * 1024:
        raise RuntimeError("The Opera package control record exceeds its bound.")
    wanted = {"Package", "Version", "Architecture", "Installed-Size"}; fields = {}
    for line in result.stdout.decode("utf-8", errors="strict").splitlines():
        if line[:1].isspace() or ":" not in line:
            continue
        key, value = line.split(":", 1)
        if key in wanted:
            if key in fields:
                raise RuntimeError("Duplicate Opera package identity fields.")
            fields[key] = value.strip()
    if any(fields.get(key) != value for key, value in
           (("Package", "opera-stable"), ("Version", VERSION), ("Architecture", "amd64"))):
        raise RuntimeError("The pinned package is not the required Opera version and architecture.")
    size = fields.get("Installed-Size", "")
    if not re.fullmatch(r"[1-9][0-9]{0,8}", size) or int(size) * 1024 > MAX_UNPACKED:
        raise RuntimeError("Invalid bounded Opera installed-size metadata.")
    return int(size) * 1024


def member_path(name):
    value = PurePosixPath(name)
    if value.is_absolute() or ".." in value.parts or "\x00" in name or "\\" in name:
        raise RuntimeError("Unsafe Opera package data member.")
    return value


def relative_link(path, value):
    target = PurePosixPath(value)
    if target.is_absolute() or "\x00" in value or "\\" in value:
        raise RuntimeError("Unsafe Opera package link.")
    parts = list(path.parent.parts)
    for component in target.parts:
        if component == "..":
            if not parts:
                raise RuntimeError("An Opera package link escapes the fixture.")
            parts.pop()
        elif component != ".":
            parts.append(component)
    return PurePosixPath(*parts)


def extract_data(package, destination, executable):
    root = destination / "data"; root.mkdir(mode=0o700)
    process = subprocess.Popen([executable, "--fsys-tarfile", str(package)], stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    seen = set(); links = []; binaries = []; expanded = 0; removed_setid = 0
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|") as archive:
            for entry in archive:
                name = member_path(entry.name)
                if name == PurePosixPath(".") and entry.isdir():
                    continue
                if name in seen or len(seen) >= MAX_MEMBERS:
                    raise RuntimeError("The Opera package contains duplicate or excessive data members.")
                seen.add(name); target = root.joinpath(*name.parts)
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                if entry.isdir():
                    target.mkdir(mode=0o700, exist_ok=True)
                elif entry.isfile():
                    expanded += entry.size
                    if entry.size < 0 or expanded > MAX_UNPACKED:
                        raise RuntimeError("The Opera data archive exceeds its extraction bound.")
                    source = archive.extractfile(entry)
                    if source is None:
                        raise RuntimeError("Missing Opera data member bytes.")
                    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                    with os.fdopen(descriptor, "wb") as output:
                        remaining = entry.size
                        while remaining:
                            block = source.read(min(1024 * 1024, remaining))
                            if not block:
                                raise RuntimeError("The Opera data member is truncated.")
                            output.write(block); remaining -= len(block)
                    mode = entry.mode & 0o700
                    target.chmod(mode)
                    removed_setid += bool(entry.mode & 0o6000)
                    if name.name == "opera" and mode & 0o100:
                        with target.open("rb") as data:
                            header = data.read(20)
                        if (len(header) == 20 and header[:6] == b"\x7fELF\x02\x01"
                                and int.from_bytes(header[18:20], "little") == 62):
                            binaries.append((target, name.as_posix()))
                elif entry.issym() or entry.islnk():
                    link = relative_link(name, entry.linkname) if entry.issym() else member_path(entry.linkname)
                    links.append((target, entry, root.joinpath(*link.parts)))
                else:
                    raise RuntimeError("The Opera package contains an unsupported device or special data member.")
        process.stdout.close()
        if process.wait(timeout=30) != 0:
            raise RuntimeError("The verified Opera data archive could not be decoded.")
        for target, entry, linked in links:
            if target.exists() or target.is_symlink() or not linked.resolve().is_relative_to(root):
                raise RuntimeError("Unsafe or duplicate Opera link destination.")
            if entry.issym():
                target.symlink_to(entry.linkname)
                if not target.resolve().is_relative_to(root):
                    raise RuntimeError("An Opera symbolic link escapes the fixture.")
            else:
                if not linked.is_file() or linked.is_symlink():
                    raise RuntimeError("Invalid Opera hard-link target.")
                os.link(linked, target)
        if len(binaries) != 1:
            raise RuntimeError("The package must contain exactly one executable Opera ELF64/x86_64 binary.")
        return binaries[0], {"dataMembers": len(seen), "unpackedBytes": expanded, "setidBitsRemoved": removed_setid}
    finally:
        if process.stdout and not process.stdout.closed:
            process.stdout.close()
        if process.poll() is None:
            # This is only our dpkg data-decoder child, never a browser or user job.
            process.terminate()
            process.wait(timeout=10)


def stage(destination):
    destination = fresh_destination(destination)
    executable = shutil.which("dpkg-deb")
    if not executable:
        raise RuntimeError("The disposable Linux runner requires its existing dpkg-deb data reader.")
    package = download_package(destination)
    installed = package_fields(package, executable)
    if shutil.disk_usage(destination).free < installed + 64 * 1024 * 1024:
        raise RuntimeError("Insufficient actual disk space for the bounded Opera fixture extraction.")
    (binary, member), extraction = extract_data(package, destination, executable)
    profile = destination / "version-profile"; profile.mkdir(mode=0o700)
    environment = {key: value for key, value in os.environ.items() if key in ("PATH", "LANG", "LC_ALL", "TZ")}
    environment.update(HOME=str(profile), XDG_CONFIG_HOME=str(profile), XDG_CACHE_HOME=str(profile))
    result = subprocess.run([str(binary), "--version"], cwd=binary.parent, env=environment,
                            stdin=subprocess.DEVNULL, capture_output=True, check=True, timeout=30)
    output = result.stdout.decode("utf-8", errors="strict").strip()
    if len(output) > 65536 or not re.search(r"(?<![0-9.])" + re.escape(VERSION) + r"(?![0-9.])", output):
        raise RuntimeError("The actual Opera ELF executable did not report the pinned vendor version.")
    with binary.open("rb") as source:
        checksum = hashlib.file_digest(source, "sha256").hexdigest()
    provenance = {"schema": 1, "fixture": "opera-stable", "version": VERSION, "vendorVersion": output,
                  "packageUrl": PACKAGE_URL, "packageBytes": PACKAGE_BYTES, "packageSha256": PACKAGE_SHA256,
                  "binaryMember": member, "binarySha256": checksum, "binaryBytes": binary.stat().st_size,
                  "installerExecuted": False, "systemRegistrationChanged": False, **extraction}
    path = destination / "opera-fixture-provenance.json"
    path.write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8"); path.chmod(0o600)
    return binary, path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    binary, provenance = stage(args.destination)
    if any(character in str(path) for path in (binary, provenance) for character in ("\n", "\r")):
        raise RuntimeError("Invalid browser fixture output path.")
    with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as output:
        output.write("GD_EXTENSION_OPERA_BINARY=" + str(binary) + "\n")
        output.write("GD_EXTENSION_OPERA_PROVENANCE=" + str(provenance) + "\n")
    print(json.dumps({"fixture": "opera-stable", "version": VERSION, "packageSha256": PACKAGE_SHA256,
                      "installerExecuted": False, "systemRegistrationChanged": False}))


if __name__ == "__main__":
    main()
