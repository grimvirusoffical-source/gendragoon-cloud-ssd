#!/usr/bin/env python3
"""Validate the opt-in *unencrypted* PNG carrier without the encryption library.

The existing Red-SecretsXAI encrypted PNG validator is unchanged and selected
independently by the Receiver. This script never displays or emits plaintext.
"""
import json
from pathlib import Path
import sys
import gendragoon_fast_png as fast


def validate(path, object_id):
    file = Path(path)
    if file.is_symlink() or not file.is_file() or not 8 <= file.stat().st_size <= fast.MAX_PNG_SIZE:
        raise ValueError("invalid_unencrypted_carrier")
    data = file.read_bytes()
    if not fast.is_plain_carrier(data):
        raise ValueError("unencrypted_marker_required")
    plaintext = fast.decode(data, object_id)
    return {"format": fast.PROFILE, "verified": True, "plainBytes": len(plaintext)}


if __name__ == "__main__":
    try:
        if sys.platform.startswith("linux"):
            import resource
            resource.setrlimit(resource.RLIMIT_CPU, (12, 12))
            resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
        print(json.dumps(validate(sys.argv[1], sys.argv[2])))
    except Exception:
        print(json.dumps({"error": "invalid_unencrypted_png_carrier"}))
        sys.exit(1)
