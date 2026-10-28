"""Seekable Kamatera-backed archives; no payload files, extraction or disk cache.

Only authenticated manifest pages and requested data chunks are fetched. Existing
flat and zip-root uploads remain readable without re-upload. Payload LRU is 8 MiB
per reader; oversized metadata/read requests fail closed, never fall back to a
complete download. Explicit offline downloads still use the separate restore API.
"""
from bisect import bisect_right
from collections import OrderedDict
from contextlib import contextmanager
import hashlib
import io
import json
import stat
import threading
import zipfile

import gendragoon_storage_mode as storage

PAYLOAD_CACHE_BYTES = 8 * 1024 * 1024
MAX_READ_BYTES = 16 * 1024 * 1024
MAX_INDEX_BYTES = 128 * 1024 * 1024
MAX_INDEX_PAGES = 65536
MAX_ZIP_ENTRIES = 100000
MAX_CONCURRENT_READS = 4
_READERS = threading.BoundedSemaphore(MAX_CONCURRENT_READS)


class RemoteReadError(ValueError):
    pass


def _integer(value, minimum, maximum, what):
    if type(value) is not int or not minimum <= value <= maximum:
        raise RemoteReadError('Invalid or oversized remote ' + what)
    return value


def _record(value):
    if (not isinstance(value, dict) or not storage.ID.fullmatch(str(value.get('id', '')))
            or not storage.SHA.fullmatch(str(value.get('plainSha256', '')))
            or not storage.SHA.fullmatch(str(value.get('carrierSha256', '')))):
        raise RemoteReadError('Invalid authenticated remote chunk descriptor')
    _integer(value.get('plainBytes'), 1, storage.MAX_PNG, 'chunk length')
    _integer(value.get('carrierBytes'), 1, storage.MAX_PNG, 'carrier length')
    return value


class RemoteArchive(io.RawIOBase):
    """Read-only seekable byte stream over authenticated encrypted PNG chunks.

    One open stream owns one codec/session. No tempfile, stage_item, extract or
    download_archive call is made. Manifest leaves are indexed by range and only
    two leaves are kept, rather than retaining all chunk records in RAM.
    """
    def __init__(self, client, item, *, codec_factory=None, cache_bytes=PAYLOAD_CACHE_BYTES):
        super().__init__()
        self.client, self.item = client, dict(item)
        if item.get('workspace') != client.workspace:
            raise RemoteReadError('Remote archive belongs to another workspace')
        self.limit = _integer(cache_bytes, 0, PAYLOAD_CACHE_BYTES, 'memory budget')
        self.position = 0
        self.cache = OrderedDict()
        self.cache_bytes = 0
        self.peak_cache_bytes = 0
        self.leaves = []
        self.starts = []
        self.leaf_cache = OrderedDict()
        self._manager = None
        self.codec = None
        self.client.verified_workers()
        try:
            self._manager = (codec_factory or storage.codec_for_item)(client, item)
            self.codec = self._manager.__enter__()
            self.root, _ = storage._root_for_item(client, self.codec, item)
            self.size = _integer(self.root.get('archiveBytes'), 1, 64 * 1024**4, 'archive size')
            self.chunk_size = _integer(self.root.get('chunkBytes'), 1, storage.MAX_PNG, 'chunk size')
            self.count = _integer(self.root.get('chunkCount'), 1, 2**40, 'chunk count')
            if self.count != (self.size + self.chunk_size - 1) // self.chunk_size:
                raise RemoteReadError('Remote archive length/count mismatch')
            self._index()
        except BaseException:
            self.close()
            raise

    def readable(self): return not self.closed
    def seekable(self): return not self.closed
    def writable(self): return False
    def tell(self):
        self._checkClosed()
        return self.position

    def seek(self, offset, whence=io.SEEK_SET):
        self._checkClosed()
        if type(offset) is not int or whence not in (0, 1, 2):
            raise ValueError('Invalid remote seek')
        position = offset if whence == 0 else (self.position if whence == 1 else self.size) + offset
        if position < 0: raise ValueError('Negative remote seek')
        self.position = position
        return position

    def _page(self, descriptor):
        _record(descriptor)
        return json.loads(storage._get_plain(self.client, self.codec, descriptor))

    def _index(self):
        seen = set()
        consumed = 0
        next_index = 0
        def visit(pages, depth):
            nonlocal consumed, next_index
            if not isinstance(pages, list) or depth > 8 or len(pages) > MAX_INDEX_PAGES:
                raise RemoteReadError('Remote index exceeds its bounded depth/size')
            for descriptor in pages:
                _record(descriptor)
                oid = descriptor['id']
                if oid in seen or len(seen) >= MAX_INDEX_PAGES:
                    raise RemoteReadError('Remote index repeats a page or exceeds its bound')
                seen.add(oid)
                consumed += descriptor['plainBytes']
                if consumed > MAX_INDEX_BYTES:
                    raise RemoteReadError('Remote index exceeds the streaming metadata limit; no local copy was created')
                page = self._page(descriptor)
                if not isinstance(page, dict): raise RemoteReadError('Invalid remote manifest page')
                if page.get('schema') == storage.INDEX_SCHEMA:
                    visit(page.get('pages'), depth + 1)
                elif page.get('schema') == storage.PAGE_SCHEMA:
                    records = page.get('records')
                    if not isinstance(records, list) or not records:
                        raise RemoteReadError('Empty or invalid remote chunk page')
                    first = next_index
                    for record in records:
                        _record(record)
                        expected = min(self.chunk_size, self.size - next_index * self.chunk_size)
                        if type(record.get('index')) is not int or record['index'] != next_index or record['plainBytes'] != expected:
                            raise RemoteReadError('Remote archive chunk ordering/size mismatch')
                        next_index += 1
                        if next_index > self.count: raise RemoteReadError('Remote chunk count exceeded')
                    self.starts.append(first)
                    self.leaves.append((first, next_index, dict(descriptor)))
                else:
                    raise RemoteReadError('Unsupported remote manifest page')
        visit(self.root.get('chunkPages'), 0)
        if next_index != self.count: raise RemoteReadError('Remote archive chunk count mismatch')

    def _chunk_record(self, index):
        page_index = bisect_right(self.starts, index) - 1
        if page_index < 0: raise RemoteReadError('Remote index is incomplete')
        start, end, descriptor = self.leaves[page_index]
        if not start <= index < end: raise RemoteReadError('Remote index range mismatch')
        if page_index in self.leaf_cache:
            records = self.leaf_cache.pop(page_index)
        else:
            page = self._page(descriptor)
            records = page['records']
            if len(records) != end - start: raise RemoteReadError('Remote index changed')
        self.leaf_cache[page_index] = records
        while len(self.leaf_cache) > 2: self.leaf_cache.popitem(last=False)
        record = _record(records[index - start])
        if record.get('index') != index: raise RemoteReadError('Remote index changed')
        return record

    def _chunk(self, index):
        if index in self.cache:
            value = self.cache.pop(index)
            self.cache[index] = value
            return value
        value = storage._get_plain(self.client, self.codec, self._chunk_record(index))
        if len(value) <= self.limit:
            while self.cache and self.cache_bytes + len(value) > self.limit:
                self.cache_bytes -= len(self.cache.popitem(last=False)[1])
            self.cache[index] = value
            self.cache_bytes += len(value)
            self.peak_cache_bytes = max(self.peak_cache_bytes, self.cache_bytes)
        return value

    def read(self, size=-1):
        self._checkClosed()
        if size is None or size == -1: size = max(0, self.size - self.position)
        _integer(size, 0, MAX_READ_BYTES, 'read allocation')
        remaining = min(size, max(0, self.size - self.position))
        result = bytearray()
        while remaining:
            index, offset = divmod(self.position, self.chunk_size)
            chunk = self._chunk(index)
            count = min(remaining, len(chunk) - offset)
            if count <= 0: raise RemoteReadError('Truncated remote archive')
            result.extend(chunk[offset:offset + count])
            remaining -= count
            self.position += count
        return bytes(result)

    def readinto(self, buffer):
        data = self.read(len(buffer))
        buffer[:len(data)] = data
        return len(data)

    def close(self):
        if not self.closed:
            getattr(self,"cache",{}).clear()
            getattr(self,"leaf_cache",{}).clear()
            self.cache_bytes = 0
            if getattr(self,"_manager",None) is not None and getattr(self,"codec",None) is not None:
                self._manager.__exit__(None, None, None)
            self.codec = None
            super().close()


class _Member:
    """Bound caller allocations; verify file hash on a full sequential read."""
    def __init__(self, source, record):
        self.source = source
        self.record = record
        self.position = 0
        self.hasher = hashlib.sha256()
        self.hashing = True

    def seek(self, offset, whence=0):
        position = self.source.seek(offset, whence)
        if position != self.position:
            self.hashing = position == 0
            self.hasher = hashlib.sha256()
        self.position = position
        return position

    def tell(self): return self.position
    def read(self, size=-1):
        if size is None or size == -1: size = max(0, self.record['size'] - self.position)
        _integer(size, 0, MAX_READ_BYTES, 'file read allocation')
        data = self.source.read(min(size, max(0, self.record['size'] - self.position)))
        self.position += len(data)
        if self.hashing:
            self.hasher.update(data)
            if self.position == self.record['size'] and self.hasher.hexdigest() != self.record['sha256']:
                raise RemoteReadError('Remote file failed full-read integrity verification')
        return data


@contextmanager
def open_member(client, item, relative, record, *, codec_factory=None):
    """Yield bytes of one authenticated file without restoring its archive."""
    if (not isinstance(relative, str) or '\\' in relative or '\0' in relative
            or relative != '.' and any(part in ('', '.', '..') for part in relative.split('/'))
            or record.get('type') != 'file' or not storage.SHA.fullmatch(str(record.get('sha256', '')))):
        raise RemoteReadError('Invalid remote file selection')
    _integer(record.get('size'), 0, 64 * 1024**4, 'file length')
    if not _READERS.acquire(timeout=3): raise RemoteReadError('Remote read slots are busy; retry safely')
    try:
        with RemoteArchive(client, item, codec_factory=codec_factory) as source:
            layout = source.root.get('archiveLayout')
            if layout == 'flat':
                if relative != '.' or record['size'] != source.size or record['sha256'] != source.root['archiveSha256']:
                    raise RemoteReadError('Flat archive file identity mismatch')
                yield _Member(source, record)
            elif layout == 'zip-root':
                name = source.root.get('name')
                if not isinstance(name, str) or name in ('', '.', '..') or any(c in name for c in '/\\\0'):
                    raise RemoteReadError('Invalid archive root name')
                selected = name if relative == '.' else name + '/' + relative
                # ZipFile reads only the central directory and selected member.
                # The raw reader bounds even adversarial central-directory reads.
                with zipfile.ZipFile(source, 'r') as archive:
                    entries = archive.infolist()
                    if len(entries) > MAX_ZIP_ENTRIES: raise RemoteReadError('Remote ZIP directory exceeds its streaming limit')
                    matches = [entry for entry in entries if entry.filename == selected]
                    if len(matches) != 1: raise RemoteReadError('Missing or duplicate remote ZIP member')
                    entry = matches[0]
                    mode = entry.external_attr >> 16
                    if (entry.is_dir() or entry.file_size != record['size'] or entry.flag_bits & 1
                            or stat.S_ISLNK(mode) or stat.S_IFMT(mode) not in (0, stat.S_IFREG)
                            or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)):
                        raise RemoteReadError('Remote ZIP member metadata is incompatible')
                    with archive.open(entry, 'r') as member:
                        yield _Member(member, record)
            else:
                raise RemoteReadError('This legacy archive is not streamable; no local fallback was used')
    finally:
        _READERS.release()
