"""Android adapter around the unchanged, pinned GenDragoon storage protocol.

Only selected owner files enter this module. Developer-peer packets cannot call
it. Original document-provider files are never deleted or replaced.
"""
import os
import sys
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
import hashlib
import base64
import io
import json
from pathlib import Path
import shutil
import stat
import tempfile
import threading
import time
import zipfile
import re

_runtime_lock = threading.Lock()
_operation_lock = threading.Lock()
_loader_installed = False


def sourceless_imports():
    """Honor frozen sibling-loader paths without shipping private .py files."""
    global _loader_installed
    if _loader_installed:return
    import importlib.util
    original=importlib.util.spec_from_file_location
    def spec(name,location,*args,**kwargs):
        path=Path(location)
        # Limit the adapter to the two reviewed private package trees. Other
        # dynamic imports and every cryptographic operation remain unchanged.
        if path.suffix==".py" and any(part in ("redxai","redsecretsxai") for part in path.parts) and not path.exists() and path.with_suffix(".pyc").is_file():
            location=path.with_suffix(".pyc")
        return original(name,location,*args,**kwargs)
    importlib.util.spec_from_file_location=spec
    _loader_installed=True


def compiled_modules(encoded, temporary):
    """Validate and privately extract bytecode which Chaquopy skips as source."""
    import importlib.util
    if not isinstance(encoded,str) or len(encoded)>12*1024*1024:
        raise RuntimeError("Invalid bounded packaged crypto modules")
    raw=base64.b64decode(encoded,validate=True)
    if len(raw)>8*1024*1024:raise RuntimeError("Packaged crypto module archive is too large")
    files={}
    with zipfile.ZipFile(io.BytesIO(raw))as archive:
        names=archive.namelist()
        if len(names)>1000 or len(names)!=len(set(names)) or 'manifest.json'not in names or archive.getinfo('manifest.json').file_size>65536:
            raise RuntimeError("Invalid packaged crypto module manifest")
        manifest=json.loads(archive.read('manifest.json'))
        records=manifest.get('files')
        if manifest.get('schema')!=1 or manifest.get('vendorCommit')!='9235941b431bc1c23c34286b82052f845121592f' or not isinstance(records,dict) or set(names)!={'manifest.json',*records}:
            raise RuntimeError("Packaged crypto modules do not match the pinned library")
        total=0
        for name,record in records.items():
            if not re.fullmatch(r'(?:redxai|redsecretsxai)/[A-Za-z0-9_/]+\.pyc',name):raise RuntimeError("Private source and unsafe module paths are forbidden")
            size=archive.getinfo(name).file_size;total+=size
            if not isinstance(record,dict) or record.get('bytes')!=size or not 0<size<=4*1024*1024 or total>8*1024*1024:
                raise RuntimeError("Packaged crypto module exceeds its limit")
            data=archive.read(name)
            if data[:4]!=importlib.util.MAGIC_NUMBER or hashlib.sha256(data).hexdigest()!=record.get('sha256'):
                raise RuntimeError("Packaged crypto bytecode integrity check failed")
            files[name]=data
        if not {'redxai/__init__.pyc','redxai/_librsx.pyc','redsecretsxai/__init__.pyc','redsecretsxai/_image.pyc'}.issubset(files):
            raise RuntimeError("Packaged crypto modules are incomplete")
    root=Path(temporary)/('compiled-'+hashlib.sha256(raw).hexdigest())
    if root.is_symlink():raise RuntimeError("Linked packaged module directory rejected")
    if root.exists():
        for name,data in files.items():
            item=root/name
            if item.is_symlink() or item.parent.is_symlink() or not item.is_file() or item.read_bytes()!=data:
                raise RuntimeError("Existing packaged bytecode differs from its verified input")
    else:
        staging=Path(tempfile.mkdtemp(prefix='.compiled-',dir=temporary))
        try:
            for name,data in files.items():
                item=staging/name;item.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
                with item.open('xb')as output:output.write(data)
                item.chmod(0o600)
            staging.rename(root)
        finally:
            if staging.exists():shutil.rmtree(staging)
    return root


def initialize(library, temporary, compiled=None):
    library, temporary = Path(library), Path(temporary)
    if not library.is_absolute() or not library.is_file() or library.name != "librsx.so":
        raise RuntimeError("The packaged encryption library is unavailable; no upload was sent")
    temporary.mkdir(parents=True, exist_ok=True, mode=0o700)
    with _runtime_lock:
        os.environ["RSX_LIB"] = str(library)
        tempfile.tempdir = str(temporary)
        if compiled is not None:
            package_root=compiled_modules(compiled,temporary)
            if str(package_root)not in sys.path:sys.path.insert(0,str(package_root))
            import importlib
            importlib.invalidate_caches()
        sourceless_imports()
        from redxai import _librsx
        if _librsx.abi_version() != 2:
            raise RuntimeError("The packaged encryption ABI is unsupported")
        from gendragoon_android_codec import file_api
        file_api()
    return json.dumps({"ok": True, "abi": 2})


def verify_vault(path, secret):
    from redxai import _librsx
    session, warnings = _librsx.session_open_readonly(secret, str(path))
    with session:
        return json.dumps({"ok": True, "warnings": warnings})


def initialize_vault(path, secret):
    from redxai import _librsx
    target = Path(path)
    if target.exists() or target.is_symlink():
        raise RuntimeError("An existing private vault must never be replaced")
    with _librsx.session_open(secret, str(target)):
        return json.dumps({"ok": True})


class NativeAuth:
    def __init__(self, java):
        self.java = java
    def token(self):
        return str(self.java.token(False))
    def renew(self, rejected):
        self.java.renew(str(rejected))


def client_type(java_auth):
    import gendragoon_redx_storage as storage
    class Receiver(storage.RedXReceiver):
        def __init__(self, config):
            super().__init__(config)
            self.auth = NativeAuth(java_auth)
    return Receiver


class Progress:
    def __init__(self, callback):
        self.callback, self.lock = callback, threading.RLock()
        self.state = {"schema": 1, "phase": "preparing", "completed_bytes": 0, "total_bytes": 0,
                      "uploaded_bytes": 0, "downloaded_bytes": 0, "objects_done": 0, "objects_total": 0}
        self.started = time.monotonic()
    def emit(self):
        try:
            self.callback.report(json.dumps(self.state, separators=(",", ":")))
        except Exception:
            pass  # Telemetry must never turn a verified backup into a failure.
    def phase(self, name, total_bytes=0, **values):
        with self.lock:
            self.state.update(phase=name, completed_bytes=values.pop("completed_bytes", 0), total_bytes=total_bytes, **values)
            self.started = time.monotonic()
            self.emit()
    def update(self, **values):
        with self.lock:
            self.state.update(values)
            self.emit()
    def advance(self, count, **values):
        with self.lock:
            self.state["completed_bytes"] += count
            for key, value in values.items():
                self.state[key] = self.state.get(key, 0) + value
            self.emit()
    def activity(self, name, during=()):
        with self.lock:
            if not during or self.state["phase"] in during:
                self.state["phase"] = name
                self.emit()
    def enabled(self):
        return True
    def network_begin(self):
        return time.monotonic()
    def network_end(self, token):
        pass
    def network_bytes(self, direction, count):
        with self.lock:
            key = "uploaded_bytes" if direction == "upload" else "downloaded_bytes"
            self.state[key] += count
            self.emit()


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(part)
    return value.hexdigest()


def checked_name(name):
    if not isinstance(name, str) or name in ("", ".", "..") or any(c in name for c in ("/", "\\", "\0")) or any(ord(c) < 32 for c in name) or len(name.encode()) > 255:
        raise ValueError("The selected item has an unsupported name")
    return name


def snapshot(source):
    source = Path(source)
    rows = []
    def visit(path, relative):
        info = path.lstat()
        row = {"path": relative, "executable": info.st_mode & 0o111}
        if stat.S_ISREG(info.st_mode):
            row.update(type="file", size=info.st_size, sha256=digest(path))
        elif stat.S_ISDIR(info.st_mode):
            row["type"] = "directory"
            for child in sorted(path.iterdir()):
                checked_name(child.name)
                visit(child, child.name if relative == "." else relative + "/" + child.name)
        else:
            raise ValueError("Shortcuts, symbolic links and special files are not supported by Android selection")
        rows.append(row)
        if len(rows) > 100000:
            raise ValueError("The selected folder has too many entries for this Android client")
    checked_name(source.name)
    visit(source, ".")
    return sorted(rows, key=lambda row: row["path"])


def prepare(source, destination):
    source, destination = Path(source), Path(destination)
    manifest = snapshot(source)
    if source.is_file() and source.stat().st_size > 0:
        shutil.copyfile(source, destination)
        layout, kind = "flat", "file"
    else:
        with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as output:
            for row in manifest:
                item = source if row["path"] == "." else source / row["path"]
                name = source.name + ("" if row["path"] == "." else "/" + row["path"])
                directory = row["type"] == "directory"
                entry = zipfile.ZipInfo(name + ("/" if directory else ""), (2020, 1, 1, 0, 0, 0))
                entry.create_system = 3
                entry.file_size = row.get("size", 0)
                entry.external_attr = ((stat.S_IFDIR | 0o700) if directory else (stat.S_IFREG | 0o600 | row["executable"])) << 16
                entry.compress_type = zipfile.ZIP_DEFLATED
                if directory:
                    output.writestr(entry, b"")
                else:
                    with item.open("rb") as incoming, output.open(entry, "w", force_zip64=row.get("size", 0) >= 2 * 1024 ** 3) as outgoing:
                        shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
        layout, kind = "zip-root", "folder" if source.is_dir() else "file"
    if snapshot(source) != manifest:
        raise RuntimeError("Selected source changed during preparation; original retained")
    return manifest, layout, kind


def verify_archive(archive, root, manifest):
    if root["archiveLayout"] == "flat":
        if len(manifest) != 1 or manifest[0].get("type") != "file" or manifest[0].get("size") != Path(archive).stat().st_size or manifest[0].get("sha256") != digest(archive):
            raise RuntimeError("Restored file differs from its authenticated manifest")
        return
    if root["archiveLayout"] != "zip-root":
        raise RuntimeError("This archive layout cannot be verified by the Android client")
    with zipfile.ZipFile(archive) as package:
        entries = package.infolist()
        if len(entries) > 200000 or len({entry.filename for entry in entries}) != len(entries):
            raise RuntimeError("Archive has duplicated or excessive entries")
        for entry in entries:
            path = Path(entry.filename)
            if path.is_absolute() or ".." in path.parts or "\\" in entry.filename or "\0" in entry.filename:
                raise RuntimeError("Unsafe archive member rejected")
        for row in manifest:
            relative = row.get("path")
            if not isinstance(relative, str) or relative != "." and (Path(relative).is_absolute() or ".." in Path(relative).parts):
                raise RuntimeError("Unsafe authenticated manifest path")
            if row.get("type") == "file":
                name = root["name"] + ("" if relative == "." else "/" + relative)
                info = package.getinfo(name)
                if info.file_size != row.get("size"):
                    raise RuntimeError("Archive member size mismatch")
                value = hashlib.sha256()
                with package.open(info) as stream:
                    for part in iter(lambda: stream.read(1024 * 1024), b""):
                        value.update(part)
                if value.hexdigest() != row.get("sha256"):
                    raise RuntimeError("Archive member failed SHA-256 verification")
        # Android exports the intact verified ZIP, including macOS metadata and
        # symlinks. It does not extract or claim it can run a macOS app bundle.



def require_space(path, additional_bytes):
    """Require measured operation space, keeping a small working margin."""
    if type(additional_bytes) is not int or additional_bytes < 0:
        raise ValueError("Invalid measured transfer space requirement")
    required = additional_bytes + 64 * 1024 ** 2
    if shutil.disk_usage(path).free < required:
        raise RuntimeError("Not enough local space for this preparation and verified readback; original retained")
    return required


def archive_bound(source, manifest):
    """ZIP deflate worst case plus actual UTF-8 member/header lengths."""
    source = Path(source)
    if source.is_file() and source.stat().st_size > 0:
        return source.stat().st_size
    total = 128
    for row in manifest:
        size = row.get("size", 0)
        # zlib's documented compressBound formula, plus ZIP/ZIP64 headers.
        compressed = size + (size >> 12) + (size >> 14) + (size >> 25) + 13
        name = source.name + ("" if row["path"] == "." else "/" + row["path"])
        total += compressed + 2 * len(name.encode("utf-8")) + 256
    return total


def android_origin(config):
    """Reuse the account's private random ID; Chaquopy's Linux host is Android."""
    from gendragoon_device_origin import current_origin, validate_origin
    receiver = config.get("receiverId")
    if not isinstance(receiver, str) or not re.fullmatch(r"[a-f0-9]{64}", receiver):
        raise ValueError("A verified account is required for device origin")
    keymap = Path(config.get("keymapPath", ""))
    if not keymap.is_absolute() or keymap.name != "private.keymap" or keymap.parent.name != receiver:
        raise ValueError("Device origin must use this account's private vault profile")
    info = keymap.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
        raise ValueError("Device origin requires a private owned vault profile")
    value = current_origin(receiver, state_dir=keymap.parent / "DeviceOrigins")
    # Only the random deviceId is persisted by the shared helper. This explicit
    # application platform does not alter a host-global sys.platform value.
    return validate_origin(dict(value, platform="android"))


def upload(config_json, source, cache, java_auth, callback):
    import gendragoon_redx_storage as storage
    with _operation_lock:
        config = json.loads(config_json)
        progress = Progress(callback)
        storage.progress = progress
        receiver = client_type(java_auth)
        source, cache = Path(source), Path(cache)
        cache.mkdir(mode=0o700, parents=True, exist_ok=True)
        selection = snapshot(source)
        logical = sum(row.get("size", 0) for row in selection)
        require_space(cache, archive_bound(source, selection) * 2)
        progress.phase("archiving", total_bytes=logical)
        archive = cache / "prepared.archive"
        manifest, layout, kind = prepare(source, archive)
        archive_sha = digest(archive)
        key = hashlib.sha256((config["receiverId"] + "|" + config["workspaceId"] + "|android|" + source.name).encode()).hexdigest()[:18]
        result = storage.upload_archive(config, archive, key, source.name, kind, layout, archive_sha, manifest,
                                        client_factory=receiver, origin=android_origin(config))
        item = receiver(config).json("/v1/receivers/me/library")
        matches = [row for row in item.get("items", []) if row.get("key") == key and row.get("workspace") == config["workspaceId"]]
        if len(matches) != 1:
            raise RuntimeError("Receiver did not return the uploaded item")
        verification = cache / "readback.archive"
        verification.unlink(missing_ok=True)
        verification.with_name("."+verification.name+".partial").unlink(missing_ok=True)
        restored = storage.download_archive(config, matches[0], verification, client_factory=receiver)
        progress.phase("verifying", total_bytes=logical)
        if digest(verification) != archive_sha or restored["manifest"] != manifest:
            raise RuntimeError("Full readback differs from the selected source; original retained")
        verify_archive(verification, restored["root"], manifest)
        progress.phase("complete", total_bytes=logical, completed_bytes=logical)
        return json.dumps({"ok": True, "verified": True, "key": key, "archiveBytes": result["archiveBytes"], "originalRetained": True})


def download(config_json, item_json, cache, java_auth, callback):
    import gendragoon_redx_storage as storage
    with _operation_lock:
        config, item = json.loads(config_json), json.loads(item_json)
        if item.get("workspace") != config["workspaceId"]:
            raise RuntimeError("The selected item belongs to another MachineNote")
        root = Path(cache)
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        expected = item.get("archiveBytes")
        if type(expected) is not int or expected < 0:
            raise RuntimeError("Invalid authenticated archive size")
        require_space(root, expected)
        progress = Progress(callback)
        storage.progress = progress
        target = root / "verified.archive"
        target.unlink(missing_ok=True)
        target.with_name("."+target.name+".partial").unlink(missing_ok=True)
        restored = storage.download_archive(config, item, target, client_factory=client_type(java_auth))
        progress.phase("verifying", total_bytes=expected)
        verify_archive(target, restored["root"], restored["manifest"])
        name = checked_name(restored["root"]["name"])
        if restored["root"]["archiveLayout"] == "zip-root":
            name += ".zip"
        progress.phase("complete", total_bytes=expected, completed_bytes=expected)
        return json.dumps({"ok": True, "verified": True, "path": str(target), "name": name,
                           "archiveExport": restored["root"]["archiveLayout"] == "zip-root"})


def codec_selftest(directory, plain_bytes=2048):
    """Device-only fixture: no credentials, user files, or network."""
    from gendragoon_android_codec import file_api
    _librsx = file_api()
    from redsecretsxai import encode_image, decode_image
    import gendragoon_redx_storage as storage
    path = Path(directory)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    secret = "Android-instrumentation-test-only-secret-43A"
    if type(plain_bytes) is not int or plain_bytes not in (2048, 65536):
        raise RuntimeError("Only bounded public device fixture sizes are supported")
    pattern = b"GenDragoon real pinned Android codec fixture\0"
    plain = (pattern * (plain_bytes // len(pattern) + 1))[:plain_bytes]
    incoming, sealed, restored = path / "fixture", path / "sealed", path / "restored"
    incoming.write_bytes(plain)
    with _librsx.session_open(secret, str(path / "test.keymap")) as session:
        _librsx.encrypt_file(session, str(incoming), out_path=str(sealed), aad=b"gendragoon-android-test")
        png = encode_image(sealed.read_bytes(), **storage.VISUAL_PARAMETERS)
        decoded = decode_image(png)
        sealed.unlink()
        sealed.write_bytes(decoded)
        _librsx.decrypt_file(session, str(sealed), out_path=str(restored), aad=b"gendragoon-android-test")
    if restored.read_bytes() != plain:
        raise RuntimeError("Pinned Android codec roundtrip failed")
    # A closed session must fail encryption before creating any output.
    failed_encryption = path / 'failed-encryption'
    try:
        _librsx.encrypt_file(session, str(incoming), out_path=str(failed_encryption), aad=b'gendragoon-android-test')
    except Exception:
        pass
    else:
        raise RuntimeError('Closed-session encryption unexpectedly succeeded')
    if failed_encryption.exists():
        raise RuntimeError('Failed encryption published output')
    wrong_key = path / 'wrong-key-output'
    with _librsx.session_open('PUBLIC-wrong-Android-fixture-key-12345678', str(path / 'wrong.keymap')) as other:
        try:
            _librsx.decrypt_file(other, str(sealed), out_path=str(wrong_key), aad=b'gendragoon-android-test')
        except Exception:
            pass
        else:
            raise RuntimeError('Wrong-key restoration unexpectedly succeeded')
    if wrong_key.exists():
        raise RuntimeError('Failed authentication published plaintext')
    # Account-free device evidence for the exact metadata helper used by upload.
    receiver = "a" * 64
    keymap = path / "origin-profile" / receiver / "private.keymap"
    keymap.parent.mkdir(mode=0o700, parents=True)
    shutil.copyfile(path / "test.keymap", keymap)
    keymap.chmod(0o600)
    profile = {"receiverId": receiver, "keymapPath": str(keymap)}
    origin = android_origin(profile)
    if origin != android_origin(profile) or origin["platform"] != "android":
        raise RuntimeError("Android origin did not retain its account-scoped identity")
    return json.dumps({"ok": True, "pngBytes": len(png), "plainBytes": len(plain), "failedOperationsPublishNothing": True,
                       "sourcePlatform": origin["platform"], "originStable": True})
