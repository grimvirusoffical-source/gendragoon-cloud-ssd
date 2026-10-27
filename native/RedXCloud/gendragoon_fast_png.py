"""Fast unencrypted PNG transport for users who explicitly disable encryption.

This format is not an encryption format and must never be offered as protected
storage. It satisfies the existing PNG-only Receiver API without invoking or
modifying the pinned Red-SecretsXAI implementation. A complete archive retains
independent SHA-256 readback and a manifest verification before any offload.
"""
# Signed app resources must remain immutable, even for a bare helper CLI.
import os
import sys
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
import hashlib
import struct
import zlib

PNG = b"\x89PNG\r\n\x1a\n"
MARKER = b"GenDragoon\x00Unencrypted-v1"
MAGIC = b"GDRP\x01"
PROFILE = "gendragoon-plaintext-png-v1"
WIDTH = 2048
MAX_PAYLOAD = 1024 * 1024
MAX_HEIGHT = 515
MAX_PNG_SIZE = 2 * 1024 * 1024

class PlainCarrierError(ValueError):
    pass

def _chunk(kind, value):
    return struct.pack(">I", len(value)) + kind + value + struct.pack(
        ">I", zlib.crc32(kind + value) & 0xffffffff)

def is_plain_carrier(png):
    return (isinstance(png, bytes) and png.startswith(PNG)
            and len(png) >= 41 + len(MARKER) + 4
            and png[33:37] == struct.pack(">I", len(MARKER))
            and png[37:41] == b"tEXt"
            and png[41:41 + len(MARKER)] == MARKER)

def encode(plain, object_id):
    if not isinstance(plain, bytes) or not (1 <= len(plain) <= MAX_PAYLOAD):
        raise PlainCarrierError("Invalid unencrypted carrier payload size")
    if not isinstance(object_id, str) or len(object_id) != 32:
        raise PlainCarrierError("Invalid unencrypted carrier object id")
    try:
        identifier = bytes.fromhex(object_id)
    except ValueError:
        raise PlainCarrierError("Invalid unencrypted carrier object id") from None
    body = MAGIC + identifier + struct.pack(">I", len(plain)) + hashlib.sha256(plain).digest() + plain
    height = (len(body) + WIDTH - 1) // WIDTH
    if not 1 <= height <= MAX_HEIGHT:
        raise PlainCarrierError("Unencrypted carrier exceeds raster limit")
    raster = body.ljust(WIDTH * height, b"\0")
    scanlines = b"".join(b"\0" + raster[i:i + WIDTH] for i in range(0, len(raster), WIDTH))
    ihdr = struct.pack(">IIBBBBB", WIDTH, height, 8, 0, 0, 0, 0)
    return PNG + _chunk(b"IHDR", ihdr) + _chunk(b"tEXt", MARKER) + _chunk(
        b"IDAT", zlib.compress(scanlines, 1)) + _chunk(b"IEND", b"")

def decode(png, object_id):
    if not is_plain_carrier(png) or len(png) > MAX_PNG_SIZE:
        raise PlainCarrierError("Not a recognized unencrypted GenDragoon carrier")
    try:
        identifier = bytes.fromhex(object_id)
        if len(identifier) != 16:
            raise ValueError()
    except (ValueError, TypeError):
        raise PlainCarrierError("Invalid unencrypted carrier object id") from None
    position = len(PNG)
    chunks = []
    for expected in (b"IHDR", b"tEXt", b"IDAT", b"IEND"):
        if len(png) - position < 12:
            raise PlainCarrierError("Truncated PNG carrier")
        size = struct.unpack_from(">I", png, position)[0]
        kind = png[position + 4:position + 8]
        end = position + 12 + size
        if kind != expected or end > len(png) or size > MAX_PNG_SIZE:
            raise PlainCarrierError("Invalid PNG carrier layout")
        value = png[position + 8:position + 8 + size]
        crc = struct.unpack_from(">I", png, position + 8 + size)[0]
        if zlib.crc32(kind + value) & 0xffffffff != crc:
            raise PlainCarrierError("PNG carrier CRC mismatch")
        chunks.append(value)
        position = end
    if position != len(png) or chunks[1] != MARKER or chunks[3]:
        raise PlainCarrierError("Unexpected PNG carrier data")
    if len(chunks[0]) != 13:
        raise PlainCarrierError("Invalid PNG carrier image header")
    width, height, depth, typ, comp, filt, interlace = struct.unpack(">IIBBBBB", chunks[0])
    if (width != WIDTH or not 1 <= height <= MAX_HEIGHT or
            (depth, typ, comp, filt, interlace) != (8, 0, 0, 0, 0)):
        raise PlainCarrierError("Unexpected PNG image format")
    limit = (WIDTH + 1) * height
    decoder = zlib.decompressobj()
    try:
        rows = decoder.decompress(chunks[2], limit + 1)
        if len(rows) != limit or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
            raise PlainCarrierError("Invalid PNG compressed carrier length")
        rows += decoder.flush()
    except zlib.error:
        raise PlainCarrierError("Invalid PNG compressed carrier") from None
    if len(rows) != limit:
        raise PlainCarrierError("Unexpected PNG decoded size")
    if any(rows[i] != 0 for i in range(0, len(rows), WIDTH + 1)):
        raise PlainCarrierError("Unexpected PNG scanline filtering")
    raw = b"".join(rows[i + 1:i + WIDTH + 1] for i in range(0, len(rows), WIDTH + 1))
    header = len(MAGIC) + 16 + 4 + 32
    if len(raw) < header or raw[:len(MAGIC)] != MAGIC or raw[len(MAGIC):len(MAGIC) + 16] != identifier:
        raise PlainCarrierError("Carrier object identity mismatch")
    length = struct.unpack_from(">I", raw, len(MAGIC) + 16)[0]
    if not 1 <= length <= MAX_PAYLOAD or header + length > len(raw) or any(raw[header + length:]):
        raise PlainCarrierError("Carrier length or padding mismatch")
    plain = raw[header:header + length]
    if hashlib.sha256(plain).digest() != raw[len(MAGIC) + 20:header]:
        raise PlainCarrierError("Carrier SHA-256 mismatch")
    return plain


if __name__ == "__main__":
    # Production clients import this module as a library; expose only help as
    # a standalone signed helper. No cloud request or file content is touched.
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    parser.print_help()
