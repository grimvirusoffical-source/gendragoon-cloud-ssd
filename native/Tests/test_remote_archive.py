"""Kamatera on-demand reads: bounded memory and zero local payload writes."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'Resources'))
import gendragoon_remote_archive as remote
import gendragoon_storage_mode as storage

class FixtureCodec:
    def __init__(self,client,item=None): self.client=client
    def __enter__(self): return self
    def __exit__(self,*_): return False
    def open(self,carrier,oid):
        if carrier[:32] != oid.encode(): raise ValueError('wrong fixture object')
        return carrier[32:]

class FixtureClient:
    workspace='a'*32
    def __init__(self):self.objects={};self.reads=[]
    def verified_workers(self):return 1
    def get_png(self,oid):self.reads.append(oid);return self.objects[oid]
    def put(self,value):
        oid=hashlib.sha256(value).hexdigest()[:32];carrier=oid.encode()+value;self.objects[oid]=carrier
        return dict(id=oid,plainBytes=len(value),plainSha256=hashlib.sha256(value).hexdigest(),carrierBytes=len(carrier),carrierSha256=hashlib.sha256(carrier).hexdigest())

def fixture(data,layout='flat',name='data.bin',chunk=65536):
    client=FixtureClient();records=[];pages=[]
    for offset in range(0,len(data),chunk):
        record=client.put(data[offset:offset+chunk]);record['index']=len(records);records.append(record)
    for start in range(0,len(records),7):
        pages.append(client.put(json.dumps(dict(schema=storage.PAGE_SCHEMA,records=records[start:start+7])).encode()))
    root=dict(schema=storage.ROOT_SCHEMA,name=name,kind='file' if layout=='flat' else 'folder',
              archiveBytes=len(data),archiveSha256=hashlib.sha256(data).hexdigest(),archiveLayout=layout,
              chunkCount=len(records),chunkBytes=chunk,chunkPages=pages,metadata={})
    root_record=client.put(json.dumps(root).encode())
    item=dict(root,key='b'*18,manifestId=root_record['id'],workspace=client.workspace)
    return client,item,records,root

class RemoteArchiveTests(unittest.TestCase):
    def setUp(self):
        self.payload=os.urandom(4*1024*1024+39)
        self.client,self.item,self.records,self.root=fixture(self.payload)
    def reader(self,**kwargs):return remote.RemoteArchive(self.client,self.item,codec_factory=FixtureCodec,**kwargs)
    def test_small_range_downloads_only_relevant_chunks_and_does_not_write_payload(self):
        with patch('builtins.open',side_effect=AssertionError('payload disk write forbidden')), \
             patch('tempfile.TemporaryDirectory',side_effect=AssertionError('temporary download forbidden')), \
             patch.object(storage,'download_archive',side_effect=AssertionError('full restore forbidden')):
            with self.reader() as reader:
                self.assertFalse(set(self.client.reads)&{r['id'] for r in self.records})
                reader.seek(2*65536+17);self.assertEqual(reader.read(29),self.payload[2*65536+17:2*65536+46])
                downloaded=set(self.client.reads)&{r['id'] for r in self.records}
                self.assertEqual(downloaded,{self.records[2]['id']})
                self.assertLessEqual(reader.cache_bytes,65536)
    def test_seek_boundary_eof_and_lru_are_bounded(self):
        with self.reader(cache_bytes=2*65536) as reader:
            for n in (0,1,4,63,3,4,5,8,0):
                offset=n*65536+65520
                reader.seek(offset);self.assertEqual(reader.read(77),self.payload[offset:offset+77])
                self.assertLessEqual(reader.cache_bytes,2*65536)
            reader.seek(-17,2);self.assertEqual(reader.read(),self.payload[-17:])
            self.assertEqual(reader.read(1),b'')
            reader.seek(0)
            with self.assertRaises(remote.RemoteReadError):reader.read(remote.MAX_READ_BYTES+1)
            with self.assertRaises(ValueError):reader.seek(-1)
            self.assertLessEqual(reader.peak_cache_bytes,2*65536)
        self.assertEqual(reader.cache_bytes,0)
        with self.assertRaises(ValueError):reader.read(1)
    def test_tampered_chunk_is_rejected_before_any_payload_returned(self):
        with self.reader() as reader:
            oid=self.records[2]['id'];self.client.objects[oid]+=b'tampered'
            reader.seek(2*65536)
            with self.assertRaises(storage.RedXStorageError):reader.read(8)
            self.assertEqual(reader.cache_bytes,0)
    def test_cross_workspace_never_fetches_anything(self):
        item=dict(self.item,workspace='c'*32)
        with self.assertRaises(remote.RemoteReadError):remote.RemoteArchive(self.client,item,codec_factory=FixtureCodec)
        self.assertEqual(self.client.reads,[])
    def test_corrupt_index_is_not_used(self):
        descriptor=self.root['chunkPages'][0];self.client.objects[descriptor['id']]+=b'bad'
        with self.assertRaises(storage.RedXStorageError):self.reader()
        self.assertFalse(set(self.client.reads)&{r['id'] for r in self.records})
    def test_full_flat_read_checks_manifest_hash_and_random_read_uses_chunks(self):
        record=dict(type='file',size=len(self.payload),sha256=self.item['archiveSha256'])
        with remote.open_member(self.client,self.item,'.',record,codec_factory=FixtureCodec) as stream:
            stream.seek(512);self.assertEqual(stream.read(128),self.payload[512:640])
            stream.seek(0);self.assertEqual(stream.read(),self.payload)
        bad=dict(record,sha256='f'*64)
        with self.assertRaises(remote.RemoteReadError):
            with remote.open_member(self.client,self.item,'.',bad,codec_factory=FixtureCodec):pass
    def test_zip_member_stream_does_not_restore_or_download_other_members(self):
        source=io.BytesIO();wanted=b'this file is small and remote';large=os.urandom(5*1024*1024)
        with zipfile.ZipFile(source,'w',compression=zipfile.ZIP_STORED) as archive:
            archive.writestr('Bundle/unrelated.bin',large)
            archive.writestr('Bundle/wanted.txt',wanted)
        client,item,records,_=fixture(source.getvalue(),'zip-root','Bundle')
        record=dict(type='file',size=len(wanted),sha256=hashlib.sha256(wanted).hexdigest())
        with patch('builtins.open',side_effect=AssertionError('must not write payload')):
            with remote.open_member(client,item,'wanted.txt',record,codec_factory=FixtureCodec) as stream:
                stream.seek(3);self.assertEqual(stream.read(4),wanted[3:7]);stream.seek(0);self.assertEqual(stream.read(),wanted)
        fetched=set(client.reads)&{r['id'] for r in records}
        self.assertLessEqual(len(fetched),3)
        self.assertNotIn(records[10]['id'],client.reads)
    def test_compressed_member_reads_with_bounded_output(self):
        payload=b'compressed remote member'*200000;source=io.BytesIO()
        with zipfile.ZipFile(source,'w',compression=zipfile.ZIP_DEFLATED) as archive:archive.writestr('Root/file',payload)
        client,item,_,_=fixture(source.getvalue(),'zip-root','Root')
        record=dict(type='file',size=len(payload),sha256=hashlib.sha256(payload).hexdigest())
        with remote.open_member(client,item,'file',record,codec_factory=FixtureCodec) as stream:
            stream.seek(len(payload)-79);self.assertEqual(stream.read(79),payload[-79:])
    def test_duplicate_member_and_wrong_size_are_rejected(self):
        source=io.BytesIO()
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            with zipfile.ZipFile(source,'w') as archive:
                archive.writestr('Root/file',b'abc');archive.writestr('Root/file',b'abc')
        client,item,_,_=fixture(source.getvalue(),'zip-root','Root')
        record=dict(type='file',size=3,sha256=hashlib.sha256(b'abc').hexdigest())
        with self.assertRaises(remote.RemoteReadError):
            with remote.open_member(client,item,'file',record,codec_factory=FixtureCodec):pass
    def test_path_and_index_limits_fail_without_fallback(self):
        record=dict(type='file',size=3,sha256='c'*64)
        for relative in ('../file','/etc/passwd','a//b','a/./b','a\\b','\0'):
            with self.subTest(relative=relative),self.assertRaises(remote.RemoteReadError):
                with remote.open_member(self.client,self.item,relative,record,codec_factory=FixtureCodec):pass
        with patch.object(remote,'MAX_INDEX_BYTES',32):
            with self.assertRaises(remote.RemoteReadError):self.reader()
        self.assertFalse(set(self.client.reads)&{r['id'] for r in self.records})

if __name__=='__main__':unittest.main()
