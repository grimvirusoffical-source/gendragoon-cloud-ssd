"""Validate the REAL Red-SecretsXAI image carrier, not only PNG magic bytes.

The storage server has no decryption key: carrier validation is not proof of
AEAD authenticity. Decryption/authentication happens at the client. This
preview accepts existing RSX3 or RXAI2 envelopes, not ordinary pictures.
"""
import json
import os
import struct
import sys
import warnings
from pathlib import Path

def validate(path):
    from PIL import Image
    from redsecretsxai import decode_image, decode_storage_image, StorageImageError
    Image.MAX_IMAGE_PIXELS = 4_000_000
    warnings.simplefilter('error', Image.DecompressionBombWarning)
    p = Path(path)
    if p.is_symlink() or not p.is_file() or not 8 <= p.stat().st_size <= 8 * 1024 * 1024:
        raise ValueError('invalid_carrier')
    raw = p.read_bytes()
    if raw[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('png_required')
    with Image.open(p) as image:
        if image.format != 'PNG' or image.width * image.height > 4_000_000:
            raise ValueError('carrier_dimensions')
        image.verify()
    profile = 'visual-v3'
    try:
        blob = decode_storage_image(raw)
        profile = 'compact-storage-v1'
    except StorageImageError:
        blob = decode_image(raw)
    if blob[:4] == b'RXAI':
        if len(blob) < 10:
            raise ValueError('invalid_envelope')
        magic, version, flags, klen, nlen = struct.unpack_from('>4sBBHH', blob)
        offset = 10 + klen + nlen
        if version != 2 or flags & ~3 or offset + 32 > len(blob) or blob[offset:offset+4] != b'RSX3':
            raise ValueError('invalid_envelope')
    elif blob[:4] != b'RSX3' or len(blob) < 32:
        raise ValueError('encrypted_envelope_required')
    return {'format': 'redsecretsxai-png-v1', 'profile': profile, 'cipherBytes': len(blob), 'aeadVerified': False}

if __name__ == '__main__':
    try:
        # These limits are only on the short-lived decoder, not the host service.
        if sys.platform.startswith('linux'):
            import resource
            resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
            resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
        print(json.dumps(validate(sys.argv[1])))
    except Exception:
        print(json.dumps({'error': 'invalid_redx_png_carrier'}))
        sys.exit(1)
