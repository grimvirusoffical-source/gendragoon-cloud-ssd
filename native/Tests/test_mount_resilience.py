"""Mount connection recovery and bounded, authenticated RAM-only reuse."""
import contextlib
import hashlib
import io
import json
import os
import subprocess
from pathlib import Path
import socket
import sys
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock,patch
sys.path.insert(0,str(Path(__file__).parent))
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'Resources'))
import test_workspace_mount as fixture_base
from test_remote_archive import fixture,FixtureCodec
import gendragoon_workspace_mount as mount
import gendragoon_remote_archive as remote

class MountResilienceTests(unittest.TestCase):
    setUp=fixture_base.WorkspaceMountTests.setUp
    server=fixture_base.WorkspaceMountTests.server
    request=fixture_base.WorkspaceMountTests.request

    def test_top_level_app_listing_does_not_open_every_archive(self):
        url=self.server()
        code,_,data=self.request(url+'/', 'PROPFIND', headers={'Depth':'1'})
        self.assertEqual(code,207);self.assertIn(b'Backup',data)
        self.loader.assert_not_called();self.stage.assert_not_called()

    def test_transient_failure_recovers_without_remount(self):
        url=self.server();self.stage.side_effect=OSError('disposable upstream interruption')
        code,headers,data=self.request(url+'/Folder/report.txt')
        self.assertEqual(code,503);self.assertEqual(headers['Retry-After'],'1')
        self.assertNotIn(self.payload,data);self.assertEqual(self.tree.active_reads,0)
        self.stage.side_effect=lambda *a,**kw:contextlib.closing(io.BytesIO(self.payload))
        code,_,data=self.request(url+'/Folder/report.txt')
        self.assertEqual((code,data),(200,self.payload))

    def test_failure_before_first_verified_bytes_does_not_commit_success(self):
        class FailsOnRead(io.BytesIO):
            def read(self,*args):raise OSError('fixture socket disconnected')
        self.stage.side_effect=lambda *a,**kw:contextlib.closing(FailsOnRead(self.payload))
        code,headers,data=self.request(self.server()+'/Folder/report.txt')
        self.assertEqual(code,503);self.assertEqual(headers['Connection'],'close');self.assertEqual(data,b'')

    def test_interrupted_stream_never_appends_http_error_inside_file(self):
        size=300000;self.manifests[self.file][0].update(size=size,sha256=hashlib.sha256(b'x'*size).hexdigest())
        class Partial(io.BytesIO):
            def read(self,n=-1):
                if self.tell():raise OSError('fixture drops after first block')
                return super().read(n)
        self.stage.side_effect=lambda *a,**kw:contextlib.closing(Partial(b'x'*size))
        url=self.server();port=int(url.rsplit(':',1)[1])
        with socket.create_connection(('127.0.0.1',port),timeout=3) as client:
            client.sendall(b'GET /Folder/report.txt HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer private-loopback-capability\r\nConnection: close\r\n\r\n')
            chunks=[]
            while True:
                part=client.recv(65536)
                if not part:break
                chunks.append(part)
        raw=b''.join(chunks);headers,payload=raw.split(b'\r\n\r\n',1)
        self.assertTrue(headers.startswith(b'HTTP/1.1 200'))
        self.assertEqual(payload,b'x'*(256*1024))
        self.assertNotIn(b'HTTP/1.1',payload)
        self.assertEqual(self.tree.active_reads,0)

    def test_busy_reader_returns_retryable_status_not_bad_request(self):
        self.stage.side_effect=remote.RemoteReadBusy('fixture all bounded readers occupied')
        code,headers,_=self.request(self.server()+'/Folder/report.txt')
        self.assertEqual(code,503);self.assertEqual(headers['Retry-After'],'1')

    def test_authentication_error_stays_denied_and_clears_ram(self):
        cache=self.tree.client.mount_block_cache
        data=b'fixture verified data';record=self.record_for(data)
        cache.get(record,lambda:data);self.assertEqual(cache.bytes,len(data))
        self.authorize.side_effect=mount.broker.BrokerError('fixture revoked account')
        code,_,data=self.request(self.server()+'/Folder/report.txt')
        self.assertEqual(code,403);self.assertEqual(cache.bytes,0);self.stage.assert_not_called()

    @staticmethod
    def record_for(data):
        digest=hashlib.sha256(data).hexdigest()
        return dict(id=digest[:32],plainBytes=len(data),plainSha256=digest,carrierBytes=len(data),carrierSha256=digest)

    def test_metadata_io_does_not_hold_global_mount_lock(self):
        entered=threading.Event();release=threading.Event()
        original=self.loader.side_effect
        def slow(client,item):
            entered.set();release.wait(2);return original(client,item)
        self.loader.side_effect=slow
        with ThreadPoolExecutor(max_workers=1) as pool:
            future=pool.submit(self.tree.manifest,self.items[2])
            self.assertTrue(entered.wait(1))
            try:
                acquired=self.tree.lock.acquire(timeout=.25)
                self.assertTrue(acquired,'network I/O held the mount status/unmount lock')
                if acquired:self.tree.lock.release()
            finally:release.set()
            self.assertIn('.',future.result(timeout=2))

    def test_repeated_archive_opens_reuse_verified_blocks_without_disk(self):
        payload=b'a'*262144+b'z'*262144
        client,item,records,_=fixture(payload,chunk=65536)
        client.mount_block_cache=remote.VerifiedBlockCache(limit=1024*1024)
        with patch('builtins.open',side_effect=AssertionError('payload disk access forbidden')):
            for _ in range(3):
                with remote.RemoteArchive(client,item,codec_factory=FixtureCodec) as stream:
                    stream.seek(17);self.assertEqual(stream.read(50),payload[17:67])
        self.assertEqual(client.reads.count(records[0]['id']),1)
        self.assertLessEqual(client.mount_block_cache.bytes,1024*1024)

    def test_cache_bounds_single_flight_tamper_and_clear(self):
        cache=remote.VerifiedBlockCache(limit=32);calls=[];data=b'fixture-block';r=self.record_for(data)
        def load():calls.append(1);time.sleep(.025);return data
        with ThreadPoolExecutor(max_workers=4) as pool:
            self.assertEqual(list(pool.map(lambda _:cache.get(r,load),range(4))),[data]*4)
        self.assertEqual(len(calls),1)
        for i in range(10):
            b=bytes([i])*20;cache.get(self.record_for(b),lambda b=b:b)
            self.assertLessEqual(cache.bytes,32)
        cache.clear();self.assertEqual(cache.bytes,0)
        with self.assertRaises(remote.RemoteReadError):cache.get(r,lambda:b'tampered')
        self.assertEqual(cache.bytes,0)
        self.assertEqual(cache.get(r,lambda:data),data)

    def test_failed_loader_is_not_cached_and_next_request_retries(self):
        cache=remote.VerifiedBlockCache();data=b'fixture';r=self.record_for(data)
        with self.assertRaises(OSError):cache.get(r,Mock(side_effect=OSError('offline')))
        self.assertEqual(cache.bytes,0);self.assertEqual(cache.inflight,{})
        self.assertEqual(cache.get(r,lambda:data),data)

class ActualNFSRecoveryTests(unittest.TestCase):
    setUp=fixture_base.WorkspaceMountTests.setUp
    server=fixture_base.WorkspaceMountTests.server
    @unittest.skipUnless(sys.platform=='darwin' and os.environ.get('GENDRAGOON_NFS_SMOKE')=='1',
                         'explicit disposable macOS NFS recovery test')
    def test_actual_nfs_recovers_from_first_read_and_midstream_failures(self):
        # This tree and all payload bytes are generated fixtures, never user data.
        data=b'generated resilience fixture\n'*24000
        self.manifests[self.file][0].update(size=len(data),sha256=hashlib.sha256(data).hexdigest())
        state={'attempts':0,'interruptions':0};gate=threading.Lock()
        class Interrupted(io.BytesIO):
            def read(stream,n=-1):
                if stream.tell():
                    with gate:state['interruptions']+=1
                    raise OSError('fixture connection dropped mid-response')
                return super().read(n)
        def staged(*a,**kw):
            with gate:
                state['attempts']+=1;attempt=state['attempts']
            if attempt==1:raise OSError('fixture upstream unavailable once')
            return contextlib.closing(Interrupted(data) if attempt==2 else io.BytesIO(data))
        self.stage.side_effect=staged
        url=self.server();point=self.home/'recovery-nfs';point.mkdir()
        environment=dict(os.environ,RCLONE_WEBDAV_URL=url+'/',RCLONE_WEBDAV_VENDOR='other',RCLONE_WEBDAV_BEARER_TOKEN='private-loopback-capability')
        binary=os.environ.get('GENDRAGOON_RCLONE','/Applications/GenDragoon Cloud SSD.app/Contents/Resources/rclone')
        errorlog=(self.home/'fixture-rclone.log').open('wb')
        process=subprocess.Popen([binary,'--config','/dev/null','nfsmount',':webdav:',str(point),
            '--read-only','--vfs-cache-mode=off','--addr=127.0.0.1:0','--nfs-cache-type=memory',
            '--dir-cache-time=0s','--attr-timeout=0s','--buffer-size=1M',
            '--dir-perms=0700','--file-perms=0400'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=errorlog,env=environment)
        try:
            deadline=time.monotonic()+25
            while not os.path.ismount(point) and time.monotonic()<deadline and process.poll() is None:time.sleep(.1)
            self.assertTrue(os.path.ismount(point),'disposable mount did not start')
            script='import pathlib,hashlib,sys;data=pathlib.Path(sys.argv[1]).read_bytes();print(len(data),hashlib.sha256(data).hexdigest())'
            result=subprocess.run([sys.executable,'-B','-c',script,str(point/'Folder/report.txt')],capture_output=True,text=True,timeout=45)
            self.assertEqual(result.returncode,0,result.stderr[-1500:])
            self.assertEqual(result.stdout.strip(),str(len(data))+' '+hashlib.sha256(data).hexdigest())
            self.assertGreaterEqual(state['attempts'],3)
            self.assertGreaterEqual(state['interruptions'],1)
            self.assertIsNone(process.poll());self.assertTrue(os.path.ismount(point))
            print('REAL_NFS_RECOVERY',state,flush=True)
        finally:
            if os.path.ismount(point):
                done=subprocess.run(['/sbin/umount',str(point)],capture_output=True,timeout=20)
                if done.returncode:raise RuntimeError('Disposable NFS mount is busy; no forced unmount attempted')
            if process.poll() is None:process.terminate();process.wait(timeout=10)
            errorlog.close()

if __name__=='__main__':unittest.main()
