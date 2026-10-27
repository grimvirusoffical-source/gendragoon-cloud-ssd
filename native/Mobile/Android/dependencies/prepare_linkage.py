#!/usr/bin/env python3
"""Preserve cibuildwheel Android linker flags and explicitly link CPython."""
import sys
sys.dont_write_bytecode = True
import argparse
import json
import os
from pathlib import Path
import shlex
import struct


def needed_libraries(data):
    """Read actual ELF64 DT_NEEDED names, independent of incidental strings."""
    if data[:6] != b'\x7fELF\x02\x01' or len(data) < 64:
        raise RuntimeError('Expected bounded little-endian ELF64')
    offset = struct.unpack_from('<Q', data, 32)[0]
    size, count = struct.unpack_from('<HH', data, 54)
    if size < 56 or count > 1000 or offset + size * count > len(data):
        raise RuntimeError('Invalid ELF64 program headers')
    headers = [struct.unpack_from('<IIQQQQQQ', data, offset + index * size) for index in range(count)]
    dynamic = [header for header in headers if header[0] == 2]
    if len(dynamic) != 1:
        raise RuntimeError('Expected exactly one ELF dynamic segment')
    start, length = dynamic[0][2], dynamic[0][5]
    if length % 16 or start + length > len(data):
        raise RuntimeError('Invalid bounded ELF dynamic table')
    tags = []
    for index in range(start, start + length, 16):
        tag, value = struct.unpack_from('<qQ', data, index)
        if tag == 0:
            break
        tags.append((tag, value))
    address = next((value for tag, value in tags if tag == 5), None)
    length = next((value for tag, value in tags if tag == 10), None)
    if address is None or length is None or length > 16 * 1024 * 1024:
        raise RuntimeError('Missing or oversized ELF dynamic string table')
    loads = [header for header in headers if header[0] == 1 and header[3] <= address and address + length <= header[3] + header[5]]
    if len(loads) != 1:
        raise RuntimeError('ELF string table is outside its file-backed load segment')
    base = loads[0][2] + address - loads[0][3]
    if base + length > len(data):
        raise RuntimeError('Truncated ELF dynamic strings')
    strings = data[base:base + length]
    names = []
    for tag, index in tags:
        if tag != 1:
            continue
        end = strings.find(b'\0', index)
        if index >= length or end < 0:
            raise RuntimeError('Invalid ELF dependency string')
        names.append(strings[index:end].decode('ascii'))
    return names


def prepare(output):
    flags = shlex.split(os.environ.get('LDFLAGS', ''))
    if '-Wl,--no-undefined' not in flags or '-Wl,-z,max-page-size=16384' not in flags:
        raise RuntimeError('Preserve the official Android linker safety and alignment flags')
    libraries = [Path(flag[2:]) / 'libpython3.13.so' for flag in flags if flag.startswith('-L')]
    if not any(path.is_absolute() and path.is_file() for path in libraries):
        raise RuntimeError('The actual cross-target CPython 3.13 shared library is unavailable')
    # PEP738 requires an explicit DT_NEEDED libpython dependency on Android.
    # Meson built-in arguments replace LDFLAGS, so carry forward every flag.
    flags += ['-Wl,--no-as-needed', '-lpython3.13', '-Wl,--as-needed']
    literals = '[' + ', '.join("'" + flag.replace('\\', '\\\\').replace("'", "\\'") + "'" for flag in flags) + ']'
    text = '[built-in options]\nc_link_args = ' + literals + '\ncpp_link_args = ' + literals + '\n'
    Path(output).write_text(text)
    return {'explicitPythonLinkage': 'libpython3.13.so', 'preservesAndroidLinkerFlags': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    print(json.dumps(prepare(parser.parse_args().output)))
