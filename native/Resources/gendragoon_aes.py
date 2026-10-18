#!/usr/bin/env python3
"""AES-256-GCM for files and filenames. The key never leaves the device.

docs/SECURITY.md is not in this repo yet. This wire format is the client
assumption until Avery publishes that spec: a 32-byte key, a 12-byte nonce,
and a 16-byte tag. Filenames use the same seal so the original name is not
sent to storage.
"""
import argparse
import ctypes
import ctypes.util
import os
import sys

sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

NONCE_LEN = 12
TAG_LEN = 16
KEY_LEN = 32
_SET_IVLEN = 0x9
_GET_TAG = 0x10
_SET_TAG = 0x11


class VaultError(ValueError):
    pass


def _library():
    for name in ("libcrypto.so.3", "libcrypto.3.dylib", "libcrypto.dylib"):
        try:
            return ctypes.CDLL(name)
        except OSError:
            continue
    found = ctypes.util.find_library("crypto")
    if not found:
        raise VaultError("AES-256 needs the system crypto library")
    return ctypes.CDLL(found)


def _bind(library):
    library.EVP_CIPHER_CTX_new.restype = ctypes.c_void_p
    library.EVP_CIPHER_CTX_free.argtypes = [ctypes.c_void_p]
    library.EVP_aes_256_gcm.restype = ctypes.c_void_p
    library.EVP_EncryptInit_ex.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
    library.EVP_EncryptInit_ex.restype = ctypes.c_int
    library.EVP_DecryptInit_ex.argtypes = library.EVP_EncryptInit_ex.argtypes
    library.EVP_DecryptInit_ex.restype = ctypes.c_int
    library.EVP_CIPHER_CTX_ctrl.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    library.EVP_CIPHER_CTX_ctrl.restype = ctypes.c_int
    library.EVP_EncryptUpdate.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.c_void_p, ctypes.c_int]
    library.EVP_EncryptUpdate.restype = ctypes.c_int
    library.EVP_EncryptFinal_ex.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
    library.EVP_EncryptFinal_ex.restype = ctypes.c_int
    library.EVP_DecryptUpdate.argtypes = library.EVP_EncryptUpdate.argtypes
    library.EVP_DecryptUpdate.restype = ctypes.c_int
    library.EVP_DecryptFinal_ex.argtypes = library.EVP_EncryptFinal_ex.argtypes
    library.EVP_DecryptFinal_ex.restype = ctypes.c_int
    return library


_LIB = None


def crypto():
    global _LIB
    if _LIB is None:
        _LIB = _bind(_library())
    return _LIB


def _check_key(key):
    if not isinstance(key, (bytes, bytearray)) or len(key) != KEY_LEN:
        raise VaultError("The device key must be 32 bytes")
    return bytes(key)


def seal(plaintext, key, nonce=None):
    """Return nonce + ciphertext + tag."""
    key = _check_key(key)
    if isinstance(plaintext, str):
        plaintext = plaintext.encode("utf-8")
    if not isinstance(plaintext, (bytes, bytearray)):
        raise VaultError("Plaintext must be bytes")
    nonce = os.urandom(NONCE_LEN) if nonce is None else bytes(nonce)
    if len(nonce) != NONCE_LEN:
        raise VaultError("AES-GCM nonce must be 12 bytes")
    lib = crypto()
    ctx = lib.EVP_CIPHER_CTX_new()
    if not ctx:
        raise VaultError("Could not start AES-256-GCM")
    try:
        if lib.EVP_EncryptInit_ex(ctx, lib.EVP_aes_256_gcm(), None, None, None) != 1:
            raise VaultError("Could not start AES-256-GCM")
        if lib.EVP_CIPHER_CTX_ctrl(ctx, _SET_IVLEN, NONCE_LEN, None) != 1:
            raise VaultError("Could not set the AES-GCM nonce length")
        key_buf = ctypes.create_string_buffer(key)
        nonce_buf = ctypes.create_string_buffer(nonce)
        if lib.EVP_EncryptInit_ex(ctx, None, None, key_buf, nonce_buf) != 1:
            raise VaultError("Could not load the device key")
        output = ctypes.create_string_buffer(len(plaintext) + TAG_LEN)
        written = ctypes.c_int()
        source = ctypes.create_string_buffer(bytes(plaintext)) if plaintext else None
        if lib.EVP_EncryptUpdate(ctx, output, ctypes.byref(written), source, len(plaintext)) != 1:
            raise VaultError("Could not encrypt")
        total = written.value
        if lib.EVP_EncryptFinal_ex(ctx, ctypes.cast(ctypes.addressof(output) + total, ctypes.c_void_p), ctypes.byref(written)) != 1:
            raise VaultError("Could not finish encryption")
        total += written.value
        tag = ctypes.create_string_buffer(TAG_LEN)
        if lib.EVP_CIPHER_CTX_ctrl(ctx, _GET_TAG, TAG_LEN, tag) != 1:
            raise VaultError("Could not read the AES-GCM tag")
        return nonce + output.raw[:total] + tag.raw
    finally:
        lib.EVP_CIPHER_CTX_free(ctx)


def open_seal(sealed, key):
    key = _check_key(key)
    if not isinstance(sealed, (bytes, bytearray)) or len(sealed) < NONCE_LEN + TAG_LEN:
        raise VaultError("Encrypted data is incomplete")
    nonce, body, tag = bytes(sealed[:NONCE_LEN]), bytes(sealed[NONCE_LEN:-TAG_LEN]), bytes(sealed[-TAG_LEN:])
    lib = crypto()
    ctx = lib.EVP_CIPHER_CTX_new()
    if not ctx:
        raise VaultError("Could not start AES-256-GCM")
    try:
        if lib.EVP_DecryptInit_ex(ctx, lib.EVP_aes_256_gcm(), None, None, None) != 1:
            raise VaultError("Could not start AES-256-GCM")
        if lib.EVP_CIPHER_CTX_ctrl(ctx, _SET_IVLEN, NONCE_LEN, None) != 1:
            raise VaultError("Could not set the AES-GCM nonce length")
        key_buf = ctypes.create_string_buffer(key)
        nonce_buf = ctypes.create_string_buffer(nonce)
        if lib.EVP_DecryptInit_ex(ctx, None, None, key_buf, nonce_buf) != 1:
            raise VaultError("Could not load the device key")
        output = ctypes.create_string_buffer(max(len(body), 1))
        written = ctypes.c_int()
        source = ctypes.create_string_buffer(body) if body else None
        if lib.EVP_DecryptUpdate(ctx, output, ctypes.byref(written), source, len(body)) != 1:
            raise VaultError("Could not decrypt")
        total = written.value
        tag_buf = ctypes.create_string_buffer(tag)
        if lib.EVP_CIPHER_CTX_ctrl(ctx, _SET_TAG, TAG_LEN, tag_buf) != 1:
            raise VaultError("Could not set the AES-GCM tag")
        if lib.EVP_DecryptFinal_ex(ctx, ctypes.cast(ctypes.addressof(output) + total, ctypes.c_void_p), ctypes.byref(written)) != 1:
            raise VaultError("Encrypted data failed its integrity check")
        total += written.value
        return output.raw[:total]
    finally:
        lib.EVP_CIPHER_CTX_free(ctx)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Device AES-256-GCM. The key is not accepted on the command line.")
    parser.add_argument("action", nargs="?", choices=("show",), default="show")
    parser.parse_args(argv)
    print("AES-256-GCM seals files and filenames on this device. Keys stay in the macOS Keychain.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
