#!/usr/bin/env python3
"""Account/project scoped, verified file and complete-folder transfers.

Cloud objects contain a fixed two-member envelope, never local absolute paths.
The private preparation receipt binds a source snapshot to the package bytes.
Only a downloaded, verified copy can authorize moving an unchanged original
to Finder Trash. All extraction uses the existing macOS metadata-preserving
library validator and the normal 10 GiB reserve.
"""
import os
import sys
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
from pathlib import Path
import re
import shutil
import stat
import tempfile
import time
import zipfile

import gendragoon_library as library

FORMAT = "gendragoon-package-v1"
ROOT = library.SUPPORT / "ProjectFiles"
MAX_MANIFEST = 64 * 1024 * 1024
MAX_ENTRIES = 500000
HEX = re.compile(r"^[0-9a-f]{64}$")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def checked_name(name):
    library.check_name(name)
    if len(name.encode("utf-8")) > 1024 or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise ValueError("The selected item has an unsupported control character or name length")
    return name


def private_directory(path):
    path = library.safe_path(path, directory=True)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    library.safe_path(path, directory=True)
    return path


def scope_root(scope):
    if not HEX.fullmatch(scope):
        raise ValueError("Invalid account/project scope")
    private_directory(ROOT)
    return private_directory(ROOT / scope)


def private_json(path, value):
    library.safe_path(path)
    raw = canonical(value)
    if len(raw) > MAX_MANIFEST:
        raise ValueError("This folder has too much metadata to prepare safely")
    fd, temporary = tempfile.mkstemp(prefix=".receipt-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path):
    library.safe_path(path)
    with path.open("rb") as stream:
        raw = stream.read(MAX_MANIFEST + 1)
    if len(raw) > MAX_MANIFEST:
        raise ValueError("Project file metadata exceeds its safety limit")
    return json.loads(raw)


@contextmanager
def lock(scope):
    root = scope_root(scope)
    path = library.safe_path(root / "operation.lock")
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid():
            raise ValueError("Unsafe project transfer lock")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another project file operation is still running") from None
        yield root
    finally:
        os.close(fd)


def source_path(value):
    original = Path(value).expanduser().absolute()
    if original.is_symlink():
        raise ValueError("Select an actual file or complete folder, not a shortcut")
    source = original.resolve(strict=True)
    library.ensure_not_cloud(source)
    if not (source.is_file() or source.is_dir()):
        raise ValueError("Select a regular file or complete folder")
    checked_name(source.name)
    return source


def logical_size(manifest):
    return sum(item.get("size", 0) for item in manifest if item.get("type") == "file")


def metadata_size(manifest):
    return sum(attribute.get("size", 0) for item in manifest
               for attribute in item.get("xattrs", {}).values())


def source_unchanged(source, baseline):
    # JSON receipts represent tuples as lists; compare a canonical snapshot.
    if canonical(library.snapshot(source)) != canonical(baseline):
        raise RuntimeError("The source changed during transfer; its original was retained")


def receipt_at(root, key):
    if not HEX.fullmatch(key):
        raise ValueError("Invalid prepared transfer identifier")
    folder = library.safe_path(root / key, directory=True)
    if not folder.is_dir():
        raise ValueError("Prepared transfer is unavailable; select the source again")
    receipt = read_json(folder / "receipt.json")
    if not isinstance(receipt, dict) or receipt.get("key") != key or receipt.get("format") != FORMAT:
        raise ValueError("Invalid prepared transfer receipt")
    package = library.safe_path(folder / "content.gdpackage")
    return folder, receipt, package


def describe(receipt, package):
    return {"key": receipt["key"], "path": str(package), "name": receipt["name"],
            "kind": receipt["kind"], "logicalBytes": receipt["logicalBytes"],
            "sizeBytes": package.stat().st_size, "archiveFormat": FORMAT,
            "manifestSHA256": receipt["manifestSHA256"],
            "packageSHA256": receipt["packageSHA256"],
            "entryCount": len(receipt["baseline"]["manifest"])}


def validate_manifest(value):
    if not isinstance(value, dict) or value.get("format") != FORMAT:
        raise ValueError("This is not a supported GenDragoon folder package")
    checked_name(value.get("name", ""))
    if value.get("kind") not in ("file", "folder", "app") or not HEX.fullmatch(value.get("payloadSHA256", "")):
        raise ValueError("Invalid package metadata")
    entries = value.get("manifest")
    if not isinstance(entries, list) or not 1 <= len(entries) <= MAX_ENTRIES:
        raise ValueError("Invalid package manifest entry count")
    names = set()
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("type") not in ("file", "directory", "symlink"):
            raise ValueError("Invalid package manifest entry")
        relative = entry.get("path")
        if (not isinstance(relative, str) or relative in names or "\\" in relative
                or (relative != "." and any(part in ("", ".", "..") for part in relative.split("/")))):
            raise ValueError("Unsafe package manifest path")
        names.add(relative)
        if entry["type"] == "file":
            size = entry.get("size")
            if type(size) is not int or size < 0 or not HEX.fullmatch(entry.get("sha256", "")):
                raise ValueError("Invalid manifest file checksum or size")
    if "." not in names or value.get("logicalBytes") != logical_size(entries):
        raise ValueError("Package size does not match its manifest")
    return value


def envelope(package, destination, expected_manifest=None):
    """Read bounded fixed members without ZipFile.extract or untrusted paths."""
    info = package.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("Choose a downloaded regular package file")
    with zipfile.ZipFile(package) as outer:
        entries = outer.infolist()
        if len(entries) != 2 or {item.filename for item in entries} != {"manifest.json", "payload.zip"}:
            raise ValueError("The folder package has unexpected or duplicate contents")
        for item in entries:
            if item.flag_bits & 1 or item.compress_type != zipfile.ZIP_STORED or item.is_dir():
                raise ValueError("Unsupported folder package encoding")
            mode = item.external_attr >> 16
            if mode and not stat.S_ISREG(mode):
                raise ValueError("Folder package contains a linked or special member")
        manifest_entry = outer.getinfo("manifest.json")
        if manifest_entry.file_size > MAX_MANIFEST:
            raise ValueError("Folder manifest exceeds its safety limit")
        raw = outer.read(manifest_entry)
        digest = hashlib.sha256(raw).hexdigest()
        if expected_manifest and digest != expected_manifest:
            raise RuntimeError("Downloaded folder metadata checksum did not match the cloud record")
        metadata = validate_manifest(json.loads(raw))
        payload = outer.getinfo("payload.zip")
        library.require_space(payload.file_size + logical_size(metadata["manifest"])
                              + metadata_size(metadata["manifest"]) + 64 * 1024**2, destination)
        target = destination / "payload.zip"
        with outer.open(payload) as source, target.open("xb") as output:
            shutil.copyfileobj(source, output, 1024 * 1024)
        target.chmod(0o600)
    if library.sha(target) != metadata["payloadSHA256"]:
        raise RuntimeError("Downloaded folder payload checksum did not match; destination untouched")
    library.validate_archive(target, metadata["name"])
    return metadata, target


def extract_verified(package, temporary, expected_manifest=None):
    metadata, payload = envelope(package, temporary, expected_manifest)
    output = temporary / "restore"
    output.mkdir(mode=0o700)
    library.run(["/usr/bin/ditto", "-x", "-k", payload, output], timeout=1800)
    restored = output / metadata["name"]
    library.verify_restored(restored, metadata["manifest"])
    # ditto consumes __MACOSX metadata. No extra sibling may be promoted.
    if {child.name for child in output.iterdir()} != {metadata["name"]}:
        raise ValueError("Restored package contains unexpected sibling data")
    return metadata, restored


def prepare(source, scope):
    source = source_path(source)
    with lock(scope) as root:
        baseline = library.snapshot(source)
        manifest = baseline["manifest"]
        if len(manifest) > MAX_ENTRIES:
            raise ValueError("This folder contains too many entries to prepare safely")
        kind = library.kindof(source)
        key = hashlib.sha256(canonical({"source": str(source), "baseline": baseline})).hexdigest()
        folder = root / key
        if folder.exists():
            _, receipt, prepared = receipt_at(root, key)
            if library.sha(prepared) == receipt["packageSHA256"]:
                source_unchanged(source, receipt["baseline"])
                return describe(receipt, prepared)
            raise RuntimeError("The prepared transfer cache was modified. The original and changed cache were retained for review")
        logical = logical_size(manifest)
        library.require_space((logical + metadata_size(manifest)) * 3 + 128 * 1024**2, root)
        with tempfile.TemporaryDirectory(prefix=".prepare-", dir=root) as temporary:
            temporary = Path(temporary)
            payload = temporary / "payload.zip"
            library.package(source, payload)
            metadata = {"format": FORMAT, "name": source.name, "kind": kind,
                        "logicalBytes": logical, "payloadSHA256": library.sha(payload), "manifest": manifest}
            raw = canonical(metadata)
            if len(raw) > MAX_MANIFEST:
                raise ValueError("Folder metadata exceeds the supported manifest limit")
            prepared = temporary / "content.gdpackage"
            with zipfile.ZipFile(prepared, "x", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
                member = zipfile.ZipInfo("manifest.json")
                member.external_attr = (stat.S_IFREG | 0o600) << 16
                archive.writestr(member, raw)
                archive.write(payload, "payload.zip", compress_type=zipfile.ZIP_STORED)
            prepared.chmod(0o600)
            payload.unlink()
            manifest_hash = hashlib.sha256(raw).hexdigest()
            with tempfile.TemporaryDirectory(prefix="verify-", dir=temporary) as check:
                extract_verified(prepared, Path(check), manifest_hash)
            source_unchanged(source, baseline)
            receipt = {"format": FORMAT, "key": key, "source": str(source), "baseline": baseline,
                       "name": source.name, "kind": kind, "logicalBytes": logical,
                       "manifestSHA256": manifest_hash, "packageSHA256": library.sha(prepared),
                       "createdAt": time.time()}
            private_json(temporary / "receipt.json", receipt)
            # Rename only our newly prepared private directory. No source is moved.
            os.rename(temporary, folder)
            return describe(receipt, folder / "content.gdpackage")


def verify_remote(package, scope, key, offload=False):
    package = Path(package).absolute()
    with lock(scope) as root:
        folder, receipt, prepared = receipt_at(root, key)
        if package.resolve() == prepared.resolve():
            raise ValueError("Verification requires the separately downloaded cloud copy")
        if library.sha(package) != receipt["packageSHA256"]:
            raise RuntimeError("Cloud download differs from the prepared source; original retained")
        with tempfile.TemporaryDirectory(prefix=".remote-check-", dir=root) as temporary:
            metadata, _ = extract_verified(package, Path(temporary), receipt["manifestSHA256"])
        source = source_path(receipt["source"])
        source_unchanged(source, receipt["baseline"])
        moved = False
        move_uncertain = False
        if offload:
            if library.is_running(source):
                raise RuntimeError("Quit the original application before offloading it. Its cloud copy is verified")
            # This request is the user's explicit checkbox choice and operates on
            # the exact unchanged receipt source. Finder Trash remains reversible.
            source_unchanged(source, receipt["baseline"])
            try:
                library.trash(source)
                moved = not source.exists()
                move_uncertain = not moved
            except Exception:
                # Finder can report failure after starting a move. The cloud
                # roundtrip is proven, but never assert a local move completed.
                move_uncertain = True
        # Release only this verified preparation, never a recursive cache tree.
        # Unexpected user-created siblings keep the receipt/cache for review.
        if {child.name for child in folder.iterdir()} == {"content.gdpackage", "receipt.json"}:
            if library.sha(prepared) == receipt["packageSHA256"]:
                prepared.unlink()
                (folder / "receipt.json").unlink()
                try: folder.rmdir()
                except OSError: pass
        return {"verified": True, "offloaded": moved, "name": metadata["name"],
                "entryCount": len(metadata["manifest"]),
                "message": "Cloud upload and complete restore verified." +
                (" Finder did not confirm moving the original; inspect its location and Trash before retrying."
                 if move_uncertain else " Original moved to Trash." if moved else " Original retained on this Mac.")}


def restore(package, destination, manifest_hash):
    if not HEX.fullmatch(manifest_hash):
        raise ValueError("Missing cloud manifest checksum; refresh the project first")
    package = Path(package).absolute()
    destination = Path(destination).expanduser().absolute()
    checked_name(destination.name)
    parent = destination.parent
    if not parent.is_dir() or any(part.is_symlink() for part in (parent, *parent.parents)):
        raise ValueError("Select a real destination folder")
    if destination.exists() or destination.is_symlink():
        raise ValueError("The destination already exists. Choose a new name or another folder")
    with tempfile.TemporaryDirectory(prefix=".gendragoon-restore-", dir=parent) as temporary:
        metadata, restored = extract_verified(package, Path(temporary), manifest_hash)
        # Darwin renamex_np(RENAME_EXCL) gives a final no-replace promotion.
        if sys.platform != "darwin":
            raise RuntimeError("This metadata-preserving restore requires macOS")
        import ctypes
        native = ctypes.CDLL(None, use_errno=True)
        rename = native.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        if rename(os.fsencode(restored), os.fsencode(destination), 0x00000004) != 0:
            raise OSError(ctypes.get_errno(), "Could not restore without replacing existing data")
    return {"restored": str(destination), "name": metadata["name"], "kind": metadata["kind"],
            "entryCount": len(metadata["manifest"])}


def inspect(package, manifest_hash):
    if not HEX.fullmatch(manifest_hash):
        raise ValueError("Missing cloud manifest checksum")
    package = Path(package).absolute()
    # Inspect only after a complete transport checksum; recheck the bounded
    # manifest digest here before displaying names from the downloaded object.
    with zipfile.ZipFile(package) as archive:
        entries = archive.infolist()
        if len(entries) != 2 or {item.filename for item in entries} != {"manifest.json", "payload.zip"}:
            raise ValueError("Unexpected project package structure")
        entry = archive.getinfo("manifest.json")
        if entry.file_size > MAX_MANIFEST or entry.compress_type != zipfile.ZIP_STORED:
            raise ValueError("Invalid project package manifest size or encoding")
        raw = archive.read(entry)
        if hashlib.sha256(raw).hexdigest() != manifest_hash:
            raise RuntimeError("Folder contents checksum does not match the cloud record")
        metadata = validate_manifest(json.loads(raw))
    rows = [{"path": item["path"], "kind": item["type"], "sizeBytes": item.get("size", 0)}
            for item in metadata["manifest"] if item["path"] != "."]
    return {"name": metadata["name"], "kind": metadata["kind"], "logicalBytes": metadata["logicalBytes"],
            "entries": rows[:20000], "truncated": len(rows) > 20000, "entryCount": len(rows)}


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    p = commands.add_parser("prepare"); p.add_argument("--source", required=True); p.add_argument("--scope", required=True)
    p = commands.add_parser("verify-remote"); p.add_argument("--package", required=True); p.add_argument("--scope", required=True)
    p.add_argument("--key", required=True); p.add_argument("--offload", action="store_true")
    p = commands.add_parser("restore"); p.add_argument("--package", required=True); p.add_argument("--destination", required=True)
    p.add_argument("--manifest-sha256", required=True)
    p = commands.add_parser("inspect"); p.add_argument("--package", required=True); p.add_argument("--manifest-sha256", required=True)
    args = parser.parse_args()
    try:
        if args.command == "prepare": result = prepare(args.source, args.scope)
        elif args.command == "verify-remote": result = verify_remote(args.package, args.scope, args.key, args.offload)
        elif args.command == "restore": result = restore(args.package, args.destination, args.manifest_sha256)
        else: result = inspect(args.package, args.manifest_sha256)
        library.reply(**result)
    except Exception as error:
        library.fail(error)


if __name__ == "__main__":
    main()
