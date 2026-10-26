#!/usr/bin/env python3
"""Prepare or validate the explicit test-only, hash-locked Android wheel set."""
import sys
sys.dont_write_bytecode = True
import argparse
import base64
import csv
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import shutil
import stat
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent


def lock():
    value = json.loads((ROOT / 'candidate-lock.json').read_text())
    if value.get('schema') != 1 or value.get('shipping') is not False or len(value.get('files', [])) != 8:
        raise RuntimeError('Invalid explicit candidate dependency lock')
    return value['files']


def validate_wheel(path, record):
    if path.is_symlink() or not path.is_file() or path.stat().st_size != record['bytes'] or hashlib.sha256(path.read_bytes()).hexdigest() != record['sha256']:
        raise RuntimeError('Candidate SHA-256 or byte count failed: ' + path.name)
    sys.path.insert(0, str(ROOT.parent))
    from check_native_pages import inspect_elf
    libraries = 0
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) > 20000 or len(names) != len(set(names)):
            raise RuntimeError('Candidate wheel member count is invalid')
        records = [name for name in names if name.endswith('.dist-info/RECORD')]
        if len(records) != 1 or archive.getinfo(records[0]).file_size > 4 * 1024 * 1024:
            raise RuntimeError('Candidate wheel RECORD is missing or oversized')
        hashes = {row[0]: row[1:] for row in csv.reader(io.StringIO(archive.read(records[0]).decode()))}
        total = 0
        for info in archive.infolist():
            name = info.filename
            member = PurePosixPath(name)
            total += info.file_size
            if member.is_absolute() or '..' in member.parts or '\\' in name or stat.S_ISLNK(info.external_attr >> 16) or info.file_size > 128 * 1024 * 1024 or total > 256 * 1024 * 1024:
                raise RuntimeError('Unsafe or oversized candidate wheel member')
            if info.is_dir():
                continue
            data = archive.read(info)
            if name != records[0]:
                expected = ['sha256=' + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip('='), str(len(data))]
                if hashes.get(name) != expected:
                    raise RuntimeError('Candidate wheel RECORD mismatch: ' + name)
            if data[:4] == b'\x7fELF':
                proof = inspect_elf(data)
                machine = 183 if '_arm64_v8a.whl' in path.name else 62
                if proof['machine'] != machine or not proof['aligned16KiB']:
                    raise RuntimeError('Candidate native dependency is not architecture-bound and 16 KiB aligned')
                libraries += 1
        if not libraries or not any('license' in name.lower() or 'notice' in name.lower() for name in names):
            raise RuntimeError('Candidate native dependency or licenses are missing')
    return {'wheel': path.name, 'sha256': record['sha256'], 'libraries': libraries}


def validate(directory):
    directory = Path(directory).resolve(strict=True)
    expected = lock()
    if not directory.is_dir() or {p.name for p in directory.iterdir()} != {r['name'] for r in expected}:
        raise RuntimeError('Candidate folder must contain exactly the eight reviewed wheels')
    return [validate_wheel(directory / record['name'], record) for record in expected]


def prepare(destination, artifacts):
    destination, artifacts = Path(destination).resolve(), Path(artifacts).resolve(strict=True)
    if destination.exists():
        raise RuntimeError('Prepare candidates in a fresh isolated directory')
    destination.mkdir(mode=0o700, parents=True)
    for record in lock():
        target = destination / record['name']
        source = record['source']
        if source['kind'] == 'bundled':
            shutil.copyfile(ROOT / source['path'], target)
        elif source['kind'] == 'actions':
            found = list(artifacts.rglob(record['name']))
            if len(found) != 1:
                raise RuntimeError('Exactly one pinned NumPy workflow artifact is required')
            shutil.copyfile(found[0], target)
        elif source['kind'] == 'official':
            with urllib.request.urlopen(source['url'], timeout=60) as response, target.open('xb') as output:
                remaining = record['bytes'] + 1
                while remaining:
                    data = response.read(min(65536, remaining))
                    if not data:
                        break
                    output.write(data)
                    remaining -= len(data)
        else:
            raise RuntimeError('Unknown candidate source')
        validate_wheel(target, record)
    return validate(destination)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--prepare-from', type=Path)
    args = parser.parse_args()
    print(json.dumps(prepare(args.directory, args.prepare_from) if args.prepare_from else validate(args.directory), indent=2))
