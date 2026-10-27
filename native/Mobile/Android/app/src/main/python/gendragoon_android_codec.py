"""Android file I/O around unchanged pinned RSX3 memory APIs.

Android SELinux rejects anonymous-file link publication used by the Linux file
API. The pinned memory APIs use the identical authenticated RSX3 stream format.
Only GenDragoon's bounded cloud chunks and metadata use this platform adapter.
The private library's source, bindings, functions and crypto are unchanged.
"""
import os
import sys
sys.dont_write_bytecode = True
import stat
from pathlib import Path

CHUNK = 64 * 1024
MAX_AAD = 2048
MAX_SEALED = CHUNK + 4096
# Existing pinned compact decoder's exact MAX_PAYLOAD. Historic compact chunks
# may exceed the current 64 KiB write size; keep that read compatibility.
MAX_LEGACY_READ = 8 * 1024 * 1024
_installed = None


def read_bounded(path, maximum):
    path = Path(path)
    if not path.is_absolute():
        raise ValueError('Managed codec paths must be absolute')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_size > maximum:
            raise ValueError('Codec input must be an owned bounded regular file')
        data = source.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError('Codec input exceeded its bounded buffer')
    return data


def write_exclusive(path, data):
    """Write verified bytes to a new private path; never replace prior output."""
    path = Path(path)
    if not path.is_absolute():
        raise ValueError('Managed codec paths must be absolute')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    info = os.fstat(fd)
    try:
        with os.fdopen(fd, 'wb') as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        try:
            current = path.lstat()
            if (current.st_dev, current.st_ino) == (info.st_dev, info.st_ino):
                path.unlink()
        except FileNotFoundError:
            pass
        raise


class FileAPI:
    def __init__(self, core):
        self.core = core

    def __getattr__(self, name):
        return getattr(self.core, name)

    def checked_aad(self, aad):
        if not isinstance(aad, (bytes, bytearray)) or len(aad) > MAX_AAD:
            raise ValueError('Cloud codec AAD exceeds its explicit bound')
        return bytes(aad)

    def encrypt_file(self, session, in_path, out_path=None, aad=b''):
        if out_path is None:
            raise ValueError('Cloud encryption requires an explicit private output')
        plain = read_bounded(in_path, CHUNK)
        # Reuse the pinned binding's exact basename/length payload, then its
        # existing native memory seal. No new cipher, KDF or format is defined.
        payload = self.core._pack_file_payload(str(in_path), plain)
        sealed = self.core.seal(session, payload, aad=self.checked_aad(aad))
        if len(sealed) > MAX_SEALED:
            raise ValueError('Pinned ciphertext exceeds its bounded cloud buffer')
        write_exclusive(out_path, sealed)
        return str(out_path)

    def decrypt_file(self, session, in_path, out_dir=None, out_path=None, aad=b''):
        if out_path is None:
            raise ValueError('Cloud restoration requires an explicit private output')
        sealed = read_bounded(in_path, MAX_LEGACY_READ)
        # open_ verifies every chunk, final tag and clean EOF before returning.
        payload = self.core.open_(session, sealed, aad=self.checked_aad(aad))
        if len(payload) > MAX_LEGACY_READ + 265:
            raise ValueError('Authenticated file payload exceeds its cloud bound')
        _, plain = self.core._unpack_file_payload(payload)
        if len(plain) > MAX_LEGACY_READ:
            raise ValueError('Authenticated plaintext exceeds the compact legacy read bound')
        # The output does not exist until full authentication and size checks
        # have succeeded. A failed write removes only the file created here.
        write_exclusive(out_path, plain)
        return str(out_path)


def file_api():
    global _installed
    if _installed is None:
        import gendragoon_storage_mode as storage
        core, *_ = storage._crypto_runtime()
        _installed = FileAPI(core)
        # Platform injection changes only GenDragoon's transport reference.
        # The protected redxai module and its attributes are never modified.
        storage.rsx = _installed
    return _installed
