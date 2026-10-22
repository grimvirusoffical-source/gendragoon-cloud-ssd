"""Small-file preview adapter for the actual Red-SecretsXAI core + PNG layer.

No new cipher, no AES substitute, and no binary-only upload fallback. The
keymap/password remain on the client. Passwords come from stdin when invoked
as a subprocess, not command arguments. This is NOT the large-file SDK yet.
"""
import json
import os
import re
import sys
import tempfile
from pathlib import Path

MAX_PLAIN = 64 * 1024

def context_for(receiver, workspace, object_id):
    if not re.fullmatch(r'[a-f0-9]{64}', receiver) or any(not re.fullmatch(r'[a-f0-9]{32}', s) for s in [workspace, object_id]):
        raise ValueError('Invalid Receiver context')
    return json.dumps(['red-xai-receiver/png/v1', receiver, workspace, object_id], separators=(',', ':')).encode()

def keymap_file(value, decrypt=False):
    keymap = Path(value).absolute()
    if any(p.is_symlink() for p in [keymap, *keymap.parents]):
        raise ValueError('Symlinked keymap not allowed')
    if decrypt and not keymap.is_file():
        raise ValueError('Existing keymap required to decrypt')
    keymap.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if keymap.exists() and keymap.stat().st_mode & 0o077:
        raise ValueError('Keymap must be private')
    return keymap

def publish(source, destination):
    out = Path(destination).absolute()
    if any(p.is_symlink() for p in [out, *out.parents]):
        raise ValueError('Symlinked destination not allowed')
    # Private temporary output is on the same volume; link is atomic and never
    # replaces an existing file. The caller owns output directory selection.
    os.link(source, out)
    return str(out)

def seal(source, output, password, keymap, receiver, workspace, object_id):
    from redxai import _librsx as rsx
    from redsecretsxai import encode_image, decode_image
    src = Path(source)
    if src.is_symlink() or not src.is_file() or src.stat().st_size > MAX_PLAIN:
        raise ValueError('Preview accepts regular files up to 64 KiB')
    aad = context_for(receiver, workspace, object_id)
    km = keymap_file(keymap)
    out = Path(output).absolute()
    with tempfile.TemporaryDirectory(prefix='.redxai-encode-', dir=out.parent) as td:
        sealed = Path(td)/'payload.Red_SecretXAI'
        with rsx.session_open(password, str(km)) as session:
            rsx.encrypt_file(session, str(src), out_path=str(sealed), aad=aad)
        os.chmod(km, 0o600)
        blob = sealed.read_bytes()
        png = encode_image(blob, verify=True)
        if not png.startswith(b'\x89PNG\r\n\x1a\n') or decode_image(png) != blob:
            raise ValueError('PNG verification failed')
        carrier = Path(td)/'carrier.png'
        with open(carrier, 'xb') as f:
            os.chmod(carrier, 0o600); f.write(png); f.flush(); os.fsync(f.fileno())
        return publish(carrier, out)

def restore(source, output, password, keymap, receiver, workspace, object_id):
    from redxai import _librsx as rsx
    from redsecretsxai import decode_image
    src = Path(source)
    if src.is_symlink() or not src.is_file() or src.stat().st_size > 8 * 1024 * 1024:
        raise ValueError('Invalid carrier')
    raw = src.read_bytes()
    if not raw.startswith(b'\x89PNG\r\n\x1a\n'):
        raise ValueError('The image layer is required')
    km = keymap_file(keymap, decrypt=True)
    aad = context_for(receiver, workspace, object_id)
    out = Path(output).absolute()
    with tempfile.TemporaryDirectory(prefix='.redxai-decode-', dir=out.parent) as td:
        sealed = Path(td)/'payload.Red_SecretXAI'
        sealed.write_bytes(decode_image(raw)); os.chmod(sealed, 0o600)
        verified = Path(td)/'verified'
        with rsx.session_open(password, str(km)) as session:
            rsx.decrypt_file(session, str(sealed), out_path=str(verified), aad=aad)
        return publish(verified, out)

if __name__ == '__main__':
    try:
        job = json.loads(sys.stdin.buffer.read(32769))
        operation = {'seal': seal, 'restore': restore}[job.pop('operation')]
        output = operation(**job)
        print(json.dumps({'ok': True, 'output': output}))
    except Exception as exc:
        # Never echo a password, key material, plaintext, or decrypted filename.
        print(json.dumps({'ok': False, 'error': type(exc).__name__}), file=sys.stderr)
        sys.exit(1)
