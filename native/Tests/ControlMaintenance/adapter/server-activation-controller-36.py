#!/usr/bin/env python3
"""Reviewed-bundle controller. Default is capability inspection, never execution.

Execution requires Linux root, an exact root-owned reviewed manifest/plan, and a
fresh challenge-bound proof from the Mac coordinator before every live phase.
Failures retain maintenance; no automatic un-fence, force, lock deletion or DB
restore exists. This file is not approval to execute a bundle.
"""
from __future__ import annotations
import sys
sys.dont_write_bytecode=True
import argparse,datetime,fcntl,hashlib,importlib.util,json,math,os,platform,pwd,re,select,shutil,signal,socket,stat,subprocess,time,uuid
from pathlib import Path

HERE=Path(__file__).resolve().parent
KINDS=('control','receiver')
LINKS={k:Path('/usr/local/lib/gendragoon-'+k+'/current') for k in KINDS}
ACTIVE={'control':'/usr/local/lib/gendragoon-control/releases/MachineNotes-33-21d94503','receiver':'/usr/local/lib/gendragoon-receiver/releases/MachineNotes-35-98eb102'}
TARGETS={'control':'/usr/local/lib/gendragoon-control/releases/MachineNotes-36-bd5983e','receiver':'/usr/local/lib/gendragoon-receiver/releases/MachineNotes-36-c780bd4'}
RECEIVER_ENV=Path('/etc/red-x-ai/gendragoon-receiver.env')
SHARED_ENV=Path('/opt/redx/etc/redxd.env')
OVERLAY=Path('/etc/red-x-ai/gendragoon-control.env')
DROPINS={k:Path('/etc/systemd/system/gendragoon-'+k+'.service.d/36-safe-stop.conf') for k in KINDS}
SOURCE_HASHES={'control':'176ebea80c72bb6ae73017d58829fdde50489164a1a26319fb49699424e391d2','receiver':'9ae4ac7e6590adefa21980069048501c4c2e4de10e0e0eabc24c662de50ef5a6'}
STAGE_HASHES={'control':'600ebc0b4386e2c3e4cd6e0d3fea4072d3d6abc7523860930d0eef0050b37f34','receiver':'52b26df8ff848be8f97c8ed138306fbfc5263e754f64b4d93a2b27950c356e95'}
STAGE_COUNTS={'control':1537,'receiver':33}
HELPER_HASHES={'server-snapshot-36.py':'30423d1e499c8540becdac40f2bdf3cf2cc0ce90ef20625cfb890d854b51d4fc','server-activate-36.py':'5e63d948cebb207be8c309f77bbb40465b54e0adce41fae774969b7c3dcbc48b'}
ADAPTER_FILES=('server-activation-controller-36.py','server-inspector-client-36.cjs','server-admission-gates-36.cjs','server-network-boundary-36.py')

class Hold(RuntimeError):pass

def need(value,code):
 if not value:raise Hold(code)

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def file_stamp(path):
 s=Path(path).stat();return (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns,s.st_mode,s.st_uid,s.st_gid,s.st_nlink)
def module(name,path):
 spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec);sys.modules[name]=value;spec.loader.exec_module(value);return value

def private_file(path,uid=0):
 path=Path(path);s=path.lstat();need(path.resolve()==path and stat.S_ISREG(s.st_mode) and s.st_uid==uid and s.st_nlink==1 and s.st_mode&0o077==0,'private_file_invalid');return s

def trusted_directory(path):
 path=Path(path);s=path.lstat();need(path.is_absolute() and path.resolve()==path and stat.S_ISDIR(s.st_mode) and s.st_uid==0 and s.st_mode&0o022==0,'directory_untrusted');return path

def verify_bundle(review):
 need(sys.flags.optimize==0,'optimized_python_forbidden')
 need(sys.platform=='linux' and os.geteuid()==0,'linux_root_required')
 need(review.get('reviewedForExecution') is True and review.get('implementationCISuccess') is True,'bundle_not_reviewed')
 need(re.fullmatch('[0-9a-f]{40}',review.get('validatedCommit','')) is not None,'ci_commit_unverified')
 need(set(review['files'])==set(ADAPTER_FILES),'bundle_file_scope_invalid');trusted_directory(HERE);trusted_directory(HERE.parent)
 for name,digest in review['files'].items():private_file(HERE/name);need(sha(HERE/name)==digest,'bundle_hash_mismatch')
 for name,digest in HELPER_HASHES.items():private_file(HERE.parent/name);need(sha(HERE.parent/name)==digest,'proof_helper_changed')

def copy_directory(path):
 path=Path(path);info=path.lstat();need(path.resolve()==path and stat.S_ISDIR(info.st_mode) and info.st_uid==os.geteuid() and stat.S_IMODE(info.st_mode)==0o700,'payload_backup_directory_invalid');return path

def payload_rows(backup,baseline):
 manifest=copy_directory(backup)/baseline['payload']['fileManifest'];need(manifest.parent==Path(backup) and manifest.name==baseline['payload']['fileManifest'],'payload_manifest_path_invalid');private_file(manifest,os.geteuid());need(sha(manifest)==baseline['payload']['fileManifestSha256'],'payload_manifest_changed');rows=[];names=set()
 with manifest.open('r') as stream:
  for line in stream:
   need(len(line)<=32768,'payload_manifest_row_oversized');row=json.loads(line);need(set(row)=={'path','bytes','sha256'} and type(row['path']) is str,'payload_manifest_shape_invalid');relative=Path(row['path']);need(not relative.is_absolute() and '..' not in relative.parts and str(relative)==row['path'] and str(relative) not in ('','.') and relative.parts[0]!='.writer-lock' and row['path'] not in names,'payload_manifest_relative_path_invalid');need(type(row['bytes']) is int and row['bytes']>=0 and re.fullmatch('[0-9a-f]{64}',row['sha256']) is not None,'payload_manifest_value_invalid');names.add(row['path']);rows.append(row)
 need(len(rows)==baseline['payload']['files'] and sum(v['bytes'] for v in rows)==baseline['payload']['bytes'],'payload_manifest_totals_invalid');return rows

def verify_payload_copies(destination,rows):
 destination=copy_directory(destination);seen=set()
 for path in destination.rglob('*'):
  need(not path.is_symlink(),'payload_backup_link_invalid')
  if path.is_dir():copy_directory(path)
  else:private_file(path,os.geteuid());seen.add(str(path.relative_to(destination)))
 need(seen=={row['path'] for row in rows},'payload_backup_coverage_invalid')
 for row in rows:
  path=destination/row['path'];before=private_file(path,os.geteuid());need(before.st_size==row['bytes'],'payload_backup_size_invalid');h=hashlib.sha256();fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
  with os.fdopen(fd,'rb') as file:
   opened=os.fstat(file.fileno());need((opened.st_dev,opened.st_ino)==(before.st_dev,before.st_ino),'payload_backup_replaced')
   for block in iter(lambda:file.read(1024*1024),b''):h.update(block)
   after=os.fstat(file.fileno())
  final=path.lstat();need((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns)==(final.st_dev,final.st_ino,final.st_size,final.st_mtime_ns,final.st_ctime_ns) and h.hexdigest()==row['sha256'],'payload_backup_verification_failed')
 return True

def copy_payload_bytes(source_root,backup,baseline):
 source_root=Path(source_root);need(source_root.resolve()==source_root and source_root.is_dir(),'payload_source_root_invalid');backup=copy_directory(backup);rows=payload_rows(backup,baseline);total=sum(v['bytes'] for v in rows);margin=max(1024**3,(total+9)//10);overhead=len(rows)*8192
 need(shutil.disk_usage(backup).free>=total+overhead+margin,'payload_backup_space_insufficient');destination=backup/'payload-full-bytes';destination.mkdir(mode=0o700);remaining=total
 for row in rows:
  need(shutil.disk_usage(backup).free>=remaining+margin,'payload_backup_space_changed');relative=Path(row['path']);source=source_root/relative;need(source.resolve()==source,'payload_source_link_invalid');before=source.lstat();need(stat.S_ISREG(before.st_mode) and before.st_size==row['bytes'],'payload_source_invalid');target=destination/relative
  for parent in reversed(target.parent.relative_to(destination).parents):
   if parent!=Path('.'): (destination/parent).mkdir(mode=0o700,exist_ok=True)
  target.parent.mkdir(mode=0o700,parents=True,exist_ok=True);copy_directory(target.parent)
  reader=os.open(source,os.O_RDONLY|os.O_NOFOLLOW)
  with os.fdopen(reader,'rb') as incoming:
   opened=os.fstat(incoming.fileno());need((opened.st_dev,opened.st_ino,opened.st_size,opened.st_mtime_ns,opened.st_ctime_ns)==(before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns),'payload_source_replaced');writer=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);h=hashlib.sha256();written=0
   with os.fdopen(writer,'wb') as outgoing:
    for block in iter(lambda:incoming.read(1024*1024),b''):outgoing.write(block);h.update(block);written+=len(block)
    outgoing.flush();os.fsync(outgoing.fileno());copied=os.fstat(outgoing.fileno());need(copied.st_uid==os.geteuid() and stat.S_IMODE(copied.st_mode)==0o600 and copied.st_nlink==1 and (copied.st_dev,copied.st_ino)!=(opened.st_dev,opened.st_ino),'payload_copy_identity_invalid')
   after=os.fstat(incoming.fileno())
  final=source.lstat();need((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns)==(final.st_dev,final.st_ino,final.st_size,final.st_mtime_ns,final.st_ctime_ns) and written==row['bytes'] and h.hexdigest()==row['sha256'],'payload_source_changed_during_copy');remaining-=row['bytes']
 for path in [*sorted((p for p in destination.rglob('*') if p.is_dir()),key=lambda p:len(p.parts),reverse=True),destination,backup]:
  fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
 verify_payload_copies(destination,rows);return {'destination':destination,'rows':rows,'verified':True,'bytes':total,'marginBytes':margin,'measuredSpaceRequired':total+overhead+margin}

def phase_journal_path(backup,nonce):
 need(type(nonce) is str and re.fullmatch('[0-9a-f]{32}',nonce) is not None,'phase_journal_nonce_invalid');expected=Path('/root')/('gendragoon36-preactivation-'+nonce);need(Path(backup)==expected and expected.resolve()==expected,'phase_journal_scope_invalid');trusted_directory(Path('/root'));info=expected.lstat();need(stat.S_ISDIR(info.st_mode) and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o700,'phase_journal_directory_invalid');return expected/'phase.json'

def validate_mac_proof(proof,challenge,now=None):
 now=time.time() if now is None else now
 need(type(proof) is dict and proof.get('challenge')==challenge and proof.get('source')=='native-mac-preflight','mac_proof_identity_invalid')
 need(type(proof.get('observedAtEpoch')) in (int,float) and math.isfinite(proof['observedAtEpoch']) and math.isfinite(now) and 0<=now-proof['observedAtEpoch']<=10,'mac_proof_stale')
 for key in ('screenUnlocked','uploadWorkspaceTerminal','appControlIdle','nativeAppClosedVerified','maintenanceLeaseHeld'):
  need(proof.get(key) is True,'mac_protected_or_open')
 return True

class MacRPCGate:
 def __call__(self):
  challenge=uuid.uuid4().hex;print(json.dumps({'type':'mac_gate_request','challenge':challenge}),flush=True)
  need(bool(select.select([sys.stdin],[],[],30)[0]),'mac_coordinator_unavailable')
  line=sys.stdin.readline(16385);need(0<len(line)<=16384,'mac_proof_unavailable');proof=json.loads(line);validate_mac_proof(proof,challenge);return proof

class Controller:
 """Ordering is shared by live backend and disposable failure-injection tests."""
 def __init__(self,ops,mac_gate,journal=lambda value:None):
  if isinstance(ops,LiveOps):need(ops.mac_gate is mac_gate,'mac_gate_instance_mismatch')
  self.ops=ops;self.mac_gate=mac_gate;self.journal=journal;self.phase='not-started';self.started=False;self.candidate_may_run=False;self.public_may_open=False;self.guard_cleanup_may_start=False
 def step(self,name,fn):
  proof=self.mac_gate()
  if isinstance(self.ops,LiveOps):self.ops.mutation_proof=proof
  self.phase=name
  if name in ('start-control','start-receiver'):self.candidate_may_run=True
  if name=='release-service-fence':self.public_may_open=True
  if name=='owned-debugger-guard-cleanup':self.guard_cleanup_may_start=True
  self.journal({'phase':name,'state':'before'});value=fn();self.journal({'phase':name,'state':'complete'});return value
 def run(self):
  try:
   self.step('preflight',self.ops.preflight)
   self.started=True;self.step('debugger-guard',self.ops.install_guard)
   self.step('control-enable',lambda:self.ops.enable('control'));self.step('control-fence',lambda:self.ops.install('control'))
   control=self.step('control-drain',lambda:self.ops.drain('control'))
   self.step('control-inspector-close',lambda:self.ops.close_inspector('control'))
   self.step('service-syn-fence',lambda:self.ops.service_fence(control))
   self.step('receiver-enable',lambda:self.ops.enable('receiver'));self.step('receiver-fence',lambda:self.ops.install('receiver'))
   self.step('receiver-drain',lambda:self.ops.drain('receiver'));self.step('receiver-inspector-close',lambda:self.ops.close_inspector('receiver'))
   before=self.step('drained-snapshot',lambda:self.ops.snapshot('drained'))
   self.step('full-payload-byte-backup',lambda:self.ops.backup_payload(before))
   self.step('owned-config',self.ops.configure)
   self.step('ordinary-stop-control',lambda:self.ops.stop('control'));self.step('ordinary-stop-receiver',lambda:self.ops.stop('receiver'))
   self.step('stopped-preservation',lambda:self.ops.compare(before,self.ops.snapshot('stopped')))
   self.step('atomic-switch',self.ops.switch)
   self.step('start-control',lambda:self.ops.start('control'));self.step('start-receiver',lambda:self.ops.start('receiver'))
   self.step('private-health-and-credential',self.ops.private_health)
   self.step('after-start-preservation',lambda:self.ops.compare(before,self.ops.snapshot('after-start')))
   self.step('release-service-fence',self.ops.release_services)
   self.step('service-identity-readonly-probe',self.ops.service_probe)
   self.step('owned-debugger-guard-cleanup',self.ops.cleanup)
   self.phase='complete';receipt={'decision':'COMPLETE','activated':True,'activationComplete':True,'noForce':True,'noDatabaseRestore':True};self.journal(receipt);return receipt
  except Exception:
   # Deliberately no finally cleanup or rollback. The two in-process fences and
   # still-needed owned rules/holds must survive transport/controller failure.
   receipt={'decision':'HOLD' if self.started else 'NO_GO','activated':None if self.candidate_may_run else False,'activationComplete':False,'phase':self.phase,'candidateMayBeRunning':self.candidate_may_run,'publicAdmissionMayBeOpen':self.public_may_open,'ownedGuardCleanupMayHaveStarted':self.guard_cleanup_may_start,'recoveryRequired':self.started,'maintenanceResourcesRequireRevalidation':self.started,'noForce':True,'noDatabaseRestore':True}
   try:self.journal(receipt)
   except Exception:pass
   return receipt

def socket_inodes(pid):
 result=set()
 for fd in (Path('/proc')/str(pid)/'fd').iterdir():
  try:value=os.readlink(fd)
  except FileNotFoundError:continue
  if value.startswith('socket:['):result.add(value[8:-1])
 return result

def inspector_session_pair(target_pid,client_pid,port=9229):
 """Exactly one established IPv4 socket pair, owned by target and our client.

 Only the fixture may select an ephemeral port; production calls use9229. No
 socket objects, UUIDs, remote addresses or protocol contents leave this check.
 """
 need(type(port) is int and 0<port<65536,'inspector_port_invalid');suffix=':'+format(port,'04X');target=socket_inodes(target_pid);client=socket_inodes(client_pid);listeners=[];sessions=[]
 for name in ('tcp','tcp6'):
  for line in Path('/proc/net/'+name).read_text().splitlines()[1:]:
   f=line.split();local,remote,state,inode=f[1],f[2],f[3],f[9]
   if not (local.endswith(suffix) or remote.endswith(suffix)):continue
   if state=='0A':listeners.append((name,local,inode in target));continue
   if state=='06':continue # Closed HTTP discovery connections may be TIME_WAIT.
   need(state=='01' and name=='tcp' and local.startswith('0100007F:') and remote.startswith('0100007F:'),'inspector_connection_unexpected')
   sessions.append((local,remote,inode))
 need(listeners==[('tcp','0100007F'+suffix,True)] and len(sessions)==2,'inspector_coowner_or_binding')
 owned=[r for r in sessions if r[0]=='0100007F'+suffix and r[2] in target]
 need(len(owned)==1,'inspector_target_socket_unowned');local,remote,_=owned[0]
 need(sum(a==remote and b==local and inode in client for a,b,inode in sessions)==1,'inspector_client_socket_unowned');return True

class Transport:
 def __init__(self,kind,pid,guard_file):
  source=str(LINKS[kind]/'native/RedXCloud'/('control-server.cjs' if kind=='control' else 'server.cjs'))
  self.process=subprocess.Popen(['/usr/bin/node','--experimental-websocket',str(HERE/'server-inspector-client-36.cjs'),'--role',kind,'--pid',str(pid),'--source',source,'--guard-proof',str(guard_file)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,env={'PATH':'/usr/bin:/bin','LC_ALL':'C'})
  need(self.reply().get('connected') is True,'transport_handshake_invalid')
 def reply(self):
  need(bool(select.select([self.process.stdout],[],[],25)[0]),'transport_observer_timeout')
  raw=self.process.stdout.readline(16385);need(0<len(raw)<=16384,'transport_reply_invalid');r=json.loads(raw);need(r.get('ok') is True,'transport_hold');return r['value']
 def call(self,operation):
  self.process.stdin.write(json.dumps({'operation':operation})+'\n');self.process.stdin.flush()
  return self.reply()

class LiveOps:
 def __init__(self,plan,review,*,mac_gate):
  need(callable(mac_gate),'explicit_mac_gate_required');self.mac_gate=mac_gate
  self.plan=plan;self.review=review;self.nonce=uuid.uuid4().hex;self.clients={};self.status={};self.old_env=None;self.token=None;self.preservation=set();self.old_environments={};self.candidates={};self.full_payload_backup=None
  verify_bundle(review) # Verify every executable byte before importing a backend.
  self.net=module('gd36_network',HERE/'server-network-boundary-36.py')
  self.mutation_proof=None
  owner=self
  class FreshMacBackend(self.net.KernelBackend):
   def invoke(backend,args,script=None,*,mutation=False):
    if mutation:owner.require_fresh_mac(owner.mutation_proof)
    return super().invoke(args,script,mutation=mutation)
  self.boundary=self.net.NetworkBoundary(self.nonce,backend=FreshMacBackend(enable_mutations=True))
  self.backup=None
 def journal(self,record):
  if self.backup is None:
   if record!={'phase':'debugger-guard','state':'before'}:return
   trusted_directory('/root');self.backup=Path('/root')/('gendragoon36-preactivation-'+self.nonce);self.backup.mkdir(mode=0o700)
  self._write_phase_journal(json.dumps({'operationNonce':self.nonce,**record},sort_keys=True).encode())
 def _write_phase_journal(self,data):
  # This fixed evidence leaf alone may persist after a phase's proof expires.
  # There is no caller-supplied path or flag that bypasses atomic() protection.
  target=phase_journal_path(self.backup,self.nonce);need(type(data) is bytes and len(data)<=16384,'phase_journal_record_invalid');need(not target.is_symlink(),'phase_journal_link_invalid')
  if target.exists():private_file(target)
  temporary=target.with_name('.phase.json.'+uuid.uuid4().hex);fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'wb') as output:os.fchown(output.fileno(),0,0);os.fchmod(output.fileno(),0o600);output.write(data);output.flush();os.fsync(output.fileno())
  phase_journal_path(self.backup,self.nonce);need(not target.is_symlink(),'phase_journal_link_invalid');os.replace(temporary,target);directory=os.open(self.backup,os.O_RDONLY|os.O_DIRECTORY);os.fsync(directory);os.close(directory)
 def command(self,*args,timeout=30):
  need(args[0] in ('/usr/bin/systemctl','/usr/bin/node','/usr/sbin/runuser','/usr/bin/python3'),'command_not_allowlisted')
  if args[0]=='/usr/bin/systemctl' and args[1] in ('start','stop','daemon-reload'):self.require_fresh_mac(self.mutation_proof)
  try:return subprocess.check_output(args,text=True,timeout=timeout,stderr=subprocess.DEVNULL,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C','PYTHONDONTWRITEBYTECODE':'1'}).strip()
  except Exception:raise Hold('owned_command_failed') from None
 def properties(self,k,*,timeout=30):
  raw=self.command('/usr/bin/systemctl','show','gendragoon-'+k+'.service','-p','MainPID','-p','ActiveState','-p','ControlGroup','-p','KillMode','-p','SendSIGKILL','-p','TimeoutStopUSec',timeout=timeout)
  return dict(v.split('=',1) for v in raw.splitlines() if '=' in v)
 def identity(self,k):
  p=self.properties(k);pid=int(p['MainPID']);need(pid==self.plan['expectedPIDs'][k] and pid>1,'old_pid_changed');folder=Path('/proc')/str(pid);uid=pwd.getpwnam('redxai').pw_uid
  need(folder.stat().st_uid==uid and os.readlink(folder/'exe')=='/usr/bin/node' and sha(folder/'exe')==self.plan['expectedNodeSha256'],'process_owner_or_exe_changed')
  start=int((folder/'stat').read_text().split(') ',1)[1].split()[19]);need(start==self.plan['expectedStartTicks'][k],'process_start_changed')
  need(p['ControlGroup']=='/system.slice/gendragoon-'+k+'.service','cgroup_changed');self.verify_membership(k,pid)
  args=(folder/'cmdline').read_bytes().split(b'\0');need(args[:-1]==[b'/usr/bin/node',str(LINKS[k]/'native/RedXCloud'/('control-server.cjs' if k=='control' else 'server.cjs')).encode()],'process_arguments_changed')
  raw=(folder/'environ').read_bytes();need(hashlib.sha256(raw).hexdigest()==self.plan['expectedProcessEnvironmentSha256'][k],'process_environment_changed')
  env=dict(v.split('=',1) for v in raw.decode().split('\0') if '=' in v);need(not env.get('NODE_OPTIONS') and not env.get('NODE_PATH'),'unreviewed_node_preload')
  need(os.readlink(LINKS[k])==ACTIVE[k] and sha(LINKS[k]/'native/RedXCloud'/('control-server.cjs' if k=='control' else 'server.cjs'))==SOURCE_HASHES[k],'active_source_changed')
  return pid,start,env
 def require_fresh_mac(self,proof):
  need(type(proof) is dict and type(proof.get('challenge')) is str,'acknowledged_mac_proof_required');validate_mac_proof(proof,proof['challenge']);return proof
 def acknowledge_mac(self):
  proof=self.mac_gate();self.require_fresh_mac(proof);self.mutation_proof=proof;return proof
 def config_stamps(self):
  return {str(p):file_stamp(p) for p in (RECEIVER_ENV,SHARED_ENV,Path('/etc/red-x-ai/gendragoon-receiver.env.prepared-36'))}
 def fast_continuity(self,k,*,candidate=False):
  p=self.properties(k,timeout=2);pid=int(p['MainPID']);need(p['ActiveState']=='active' and p['ControlGroup']=='/system.slice/gendragoon-'+k+'.service','post_gate_unit_changed');folder=Path('/proc')/str(pid)
  pin=self.candidates[k] if candidate else (self.plan['expectedPIDs'][k],self.plan['expectedStartTicks'][k],self.plan['expectedProcessEnvironmentSha256'][k])
  need(pid==pin[0] and pid>1,'post_gate_pid_changed');need(folder.stat().st_uid==pwd.getpwnam('redxai').pw_uid and os.readlink(folder/'exe')=='/usr/bin/node','post_gate_executable_changed');start=int((folder/'stat').read_text().split(') ',1)[1].split()[19]);raw=(folder/'environ').read_bytes();need((pid,start,hashlib.sha256(raw).hexdigest())==tuple(pin),'post_gate_process_changed')
  expected=str(LINKS[k]/'native/RedXCloud'/('control-server.cjs' if k=='control' else 'server.cjs'));need((folder/'cmdline').read_bytes().split(b'\0')[:-1]==[b'/usr/bin/node',expected.encode()],'post_gate_arguments_changed');self.verify_membership(k,pid);need(self.cgroup_members(k,pid)=={str(pid)},'post_gate_children_present')
  target=TARGETS[k] if candidate else ACTIVE[k];need(os.readlink(LINKS[k])==target,'post_gate_link_changed')
  if candidate:self.service_listeners(k,pid)
  else:
   status=self.status[k];need(status['ready'] is True and status['pid']==pid and status['closed'] is True and status['workAdmissionFenced'] is True and status['pendingRejected']==0,'old_drain_proof_changed');need(not self.owned_listeners(pid),'old_drained_listener_reopened')
  return {'identity':tuple(pin),'exe':file_stamp(folder/'exe'),'source':file_stamp(Path(target)/'native/RedXCloud'/('control-server.cjs' if k=='control' else 'server.cjs'))}
 def stopped_continuity(self):
  for k in KINDS:
   p=self.properties(k,timeout=2);need(p['MainPID']=='0' and p['ActiveState']=='inactive' and p['ControlGroup'] in ('','/system.slice/gendragoon-'+k+'.service'),'post_gate_service_not_stopped');need(not self.cgroup_members(k),'post_gate_stopped_children_present');need(os.readlink(LINKS[k])==ACTIVE[k],'post_gate_stopped_link_changed')
  need(not (Path(self.old_env['REDX_RECEIVERS_ROOT'])/'.writer-lock').exists(),'post_gate_writer_lock_present');return self.config_stamps()
 def cgroup_members(self,k,active_pid=0):
  group=Path('/sys/fs/cgroup/system.slice')/('gendragoon-'+k+'.service')
  if not group.exists():need(not active_pid,'active_cgroup_missing');return set()
  need(group.resolve()==group,'cgroup_path_changed');members=set()
  for folder in [group,*group.rglob('*')]:
   need(not folder.is_symlink(),'cgroup_symlink')
   if folder.is_dir():
    file=folder/'cgroup.procs';need(file.is_file(),'cgroup_membership_unavailable');members.update(file.read_text().split())
  if active_pid:need(str(active_pid) in members,'main_pid_not_in_cgroup')
  need(all(v.isdecimal() and int(v)>0 for v in members),'cgroup_members_invalid');return members
 def verify_membership(self,k,pid):
  expected='/system.slice/gendragoon-'+k+'.service';rows=(Path('/proc')/str(pid)/'cgroup').read_text().splitlines();need(rows==['0::'+expected],'process_cgroup_mismatch');self.cgroup_members(k,pid)
 def children(self,k):
  p=self.properties(k);expected='/system.slice/gendragoon-'+k+'.service';need(p['ControlGroup'] in ('',expected),'cgroup_changed');pid=int(p['MainPID']);return self.cgroup_members(k,pid)-{str(pid)}
 def debugger_absent(self):
  for name in ('tcp','tcp6'):
   for line in Path('/proc/net/'+name).read_text().splitlines()[1:]:
    fields=line.split();need(not(fields[1].endswith(':240D') and fields[3] not in ('06',)),'debugger_still_present')
  return True
 def preflight(self):
  verify_bundle(self.review);need(hasattr(os,'pidfd_open') and hasattr(signal,'pidfd_send_signal'),'pidfd_required')
  need(self.plan['activeSourceSha256']==SOURCE_HASHES and self.plan['stageManifests']==STAGE_HASHES and self.plan['stageFiles']==STAGE_COUNTS,'pinned_release_scope_changed')
  need(sha('/etc/machine-id')==self.plan['expectedMachineIdSha256'] and Path('/proc/sys/kernel/random/boot_id').read_text().strip()==self.plan['expectedBootId'],'wrong_host_or_boot')
  need(sha('/usr/bin/node')==self.plan['expectedNodeSha256'] and self.command('/usr/bin/node','--version')=='v20.20.2','runtime_changed')
  need(self.plan['expectedActiveBefore']==ACTIVE and self.plan['targetLinks']==TARGETS,'link_scope_invalid')
  need(all(os.readlink(LINKS[k])==ACTIVE[k] for k in KINDS),'active_link_changed')
  # Immutable previously tested helpers are copied into the private bundle root.
  parent=HERE.parent
  for name,digest in HELPER_HASHES.items():private_file(parent/name);need(sha(parent/name)==digest,'proof_helper_changed')
  self.proof=module('gd36_proof',parent/'server-activate-36.py');self.snap=module('gd36_snapshot',parent/'server-snapshot-36.py')
  for k in KINDS:
   self.identity(k);need(self.proof.manifest(TARGETS[k],self.plan['stageManifests'][k])==self.plan['stageFiles'][k],'stage_changed')
   source=LINKS[k]/'native/RedXCloud'/('control-server.cjs' if k=='control' else 'server.cjs');need(sha(source)==self.plan['activeSourceSha256'][k],'active_source_changed')
  for k in KINDS:
   dependencies={'redx-state.cjs':'6c1fa216357077bf6d9e4b1cb811a1e6c27271f25eb523b823d20f12bbce98d4'}
   dependencies.update({'control-state.cjs':'92f187276d2c026e90fb7749abad07e1409196bce3b6ad5b26f9856c7dea133f'} if k=='control' else {'library-tree.cjs':'90fa3b8f2b6eb2d2b9cf9e13f3ce0832a7ba4965c70a8cf6c1c8a7f1e3ba0507'})
   for name,digest in dependencies.items():need(sha(LINKS[k]/'native/RedXCloud'/name)==digest,'active_dependency_changed')
   self.service_listeners(k,self.plan['expectedPIDs'][k])
  self.debugger_absent()
  for k in KINDS:self.old_environments[k]=self.identity(k)[2]
  self.old_pid,self.old_start,self.old_env=self.identity('receiver')
  for path,key,uid in ((RECEIVER_ENV,'activeReceiverSha256',0),(SHARED_ENV,'sharedRedXEnvSha256',999),(Path('/etc/red-x-ai/gendragoon-receiver.env.prepared-36'),'preparedReceiverSha256',0)):
   private_file(path,uid);need(sha(path)==self.plan['privateConfig'][key],'configuration_changed')
  return True
 def install_guard(self):
  self.boundary.install_guard();self.boundary.readback();self.debugger_absent()
  # Disposable challenge listener proves root reachability and nonroot denial
  # before any inspector enable. Only the already guarded owned port is used.
  need(self.backup is not None,'private_journal_required')
  server=socket.socket();server.settimeout(2);server.bind(('127.0.0.1',9229));server.listen(2)
  try:
   probe=socket.create_connection(('127.0.0.1',9229),timeout=1);accepted,_=server.accept();probe.close();accepted.close()
   code='import socket,sys\ntry:\n s=socket.create_connection(("127.0.0.1",9229),timeout=1)\nexcept OSError:sys.exit(0)\nelse:s.close();sys.exit(7)\n'
   self.command('/usr/sbin/runuser','-u','nobody','--','/usr/bin/python3','-B','-c',code)
  finally:server.close()
  self.debugger_absent();self.guard_probe=True
 def enable(self,k):
  need(self.guard_probe and self.boundary.readback()['verified'],'debugger_guard_unverified');self.debugger_absent();pid,_,_=self.identity(k)
  if k=='control':need(not self.children(k),'control_children_active')
  # Receiver decoder children are allowed here: its actual handler counters and
  # containers plus cgroup emptiness must prove their completion during drain.
  # A pidfd remains bound to this process even if its numeric PID is reused.
  need(hasattr(os,'pidfd_open') and hasattr(signal,'pidfd_send_signal'),'pidfd_required');fd=os.pidfd_open(pid,0)
  try:
   need(self.identity(k)[0]==pid,'signal_identity_changed');self.require_fresh_mac(self.mutation_proof);signal.pidfd_send_signal(fd,signal.SIGUSR1)
  finally:os.close(fd)
  end=time.monotonic()+10
  while time.monotonic()<end:
   owned=set()
   for fd in (Path('/proc')/str(pid)/'fd').iterdir():
    try:v=os.readlink(fd)
    except FileNotFoundError:continue
    if v.startswith('socket:['):owned.add(v[8:-1])
   listeners=[]
   for name in ('tcp','tcp6'):
    for line in Path('/proc/net/'+name).read_text().splitlines()[1:]:
     f=line.split()
     if f[1].endswith(':240D') and f[3]=='0A':listeners.append((name,f[1],f[9] in owned))
   if listeners:
    need(listeners==[('tcp','0100007F:240D',True)],'unexpected_debugger_binding');break
   time.sleep(.1)
  else:raise Hold('debugger_enable_unobserved')
  file=self.backup/(k+'-guard.json');self.atomic(file,json.dumps({'pid':pid,'observedAt':time.time(),'operationNonce':self.nonce,'debuggerGuardInstalled':True,'rootOnlyReachabilityVerified':True}).encode());self.clients[k]=Transport(k,pid,file);self.identity(k);self.verify_session(k)
 def verify_session(self,k):
  need(self.clients[k].process.poll() is None,'owned_transport_exited');return inspector_session_pair(self.identity(k)[0],self.clients[k].process.pid)
 def install(self,k):
  self.verify_session(k);self.require_fresh_mac(self.mutation_proof);value=self.clients[k].call('install');self.verify_session(k);return value
 def drain(self,k):
  deadline=time.monotonic()+120
  while time.monotonic()<deadline:
   self.verify_session(k);s=self.clients[k].call('status');self.verify_session(k)
   if s['ready'] and not self.children(k):self.status[k]=s;return s
   time.sleep(.25)
  raise Hold('still_draining_no_force')
 def close_inspector(self,k):
  self.verify_session(k);self.require_fresh_mac(self.mutation_proof);self.clients[k].call('close');deadline=time.monotonic()+10
  while time.monotonic()<deadline:
   try:self.debugger_absent();return
   except Hold:time.sleep(.1)
  raise Hold('debugger_cleanup_hold')
 def service_fence(self,status):
  pid,start,_=self.identity('control');need(status==self.status['control'] and status['ready'],'control_drain_unverified')
  p=self.net.ControlDrainProof(self.nonce,pid,start,self.plan['expectedBootId'],self.plan['activeSourceSha256']['control'],time.monotonic(),True,status['installedFromSetImmediate'],status['workAdmissionFenced'],status['accountLocks'],status['closed'],status['pendingRejected'],len(self.children('control')),self.debugger_absent());self.boundary.add_service_fence(p)
 def snapshot(self,label):
  value=self.snap.snapshot(self.old_env,self.backup,label);value['maintenancePhase']=label;return value
 def compare(self,a,b):self.proof.same_data(a,b);self.preservation.add(b['maintenancePhase'])
 def atomic(self,path,data):
  path=Path(path);trusted_directory(path.parent);need(not path.is_symlink(),'atomic_path_invalid');self.require_fresh_mac(self.mutation_proof);temp=path.with_name('.'+path.name+'.'+uuid.uuid4().hex);fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
  os.chown(temp,0,0);self.require_fresh_mac(self.mutation_proof);os.replace(temp,path);directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY);os.fsync(directory);os.close(directory)
 def backup_payload(self,baseline):
  value=copy_payload_bytes(self.old_env['REDX_RECEIVERS_ROOT'],self.backup,baseline);self.proof.same_data(baseline,self.snapshot('backup-verified'));self.full_payload_backup=value;return {'fullByteCopiesVerified':True,'bytes':value['bytes']}
 def configure(self):
  need(self.full_payload_backup is not None and self.full_payload_backup['verified'] is True,'full_payload_backup_required');verify_payload_copies(self.full_payload_backup['destination'],self.full_payload_backup['rows'])
  need(all(self.status[k]['ready'] for k in KINDS),'both_drains_required');self.debugger_absent()
  for k in KINDS:self.identity(k)
  self.config_unchanged();observed={k:self.fast_continuity(k) for k in KINDS};config=self.config_stamps();ack=self.acknowledge_mac()
  need({k:self.fast_continuity(k) for k in KINDS}==observed and self.config_stamps()==config,'post_gate_configuration_continuity_changed');self.require_fresh_mac(ack)
  managed=[RECEIVER_ENV,OVERLAY,*DROPINS.values()];original={}
  for n,p in enumerate(managed):
   if p.exists():s=private_file(p);self.atomic(self.backup/('original-'+str(n)+'.bin'),p.read_bytes());original[str(p)]={'mode':stat.S_IMODE(s.st_mode),'uid':s.st_uid,'gid':s.st_gid}
   else:need(not p.is_symlink(),'unsafe_owned_config');original[str(p)]=None
  self.atomic(self.backup/'original-descriptors.json',json.dumps(original).encode());self.atomic(self.backup/'shared-environment-readonly.bin',SHARED_ENV.read_bytes())
  prepared=Path('/etc/red-x-ai/gendragoon-receiver.env.prepared-36');need(sha(prepared)==self.plan['privateConfig']['preparedReceiverSha256'],'prepared_environment_changed');self.prepared=prepared.read_bytes();old=self.proof.environment_values(RECEIVER_ENV.read_bytes());new=self.proof.environment_values(self.prepared);need(all(new.get(k)==v for k,v in old.items()),'prepared_environment_replaces_old_values');self.token=new['GENDRAGOON_CONTROL_INTERNAL_TOKEN'];need(re.fullmatch('[A-Za-z0-9_-]{43,128}',self.token),'private_token_invalid')
  need(new['GENDRAGOON_INTEGRATION_ENTITLEMENTS_URL']=='http://127.0.0.1:17778/internal/receiver-entitlements','private_url_invalid')
  for k,p in DROPINS.items():self.require_fresh_mac(self.mutation_proof);p.parent.mkdir(mode=0o700,exist_ok=True);self.atomic(p,('[Service]\nKillMode=mixed\nSendSIGKILL=no\nTimeoutStopSec=infinity\n'+('EnvironmentFile=/etc/red-x-ai/gendragoon-control.env\n' if k=='control' else '')).encode())
  self.atomic(OVERLAY,('GENDRAGOON_CONTROL_INTERNAL_TOKEN='+self.token+'\n').encode());ack=self.acknowledge_mac();need({k:self.fast_continuity(k) for k in KINDS}==observed and self.config_stamps()==config,'post_gate_configuration_continuity_changed');self.require_fresh_mac(ack);self.command('/usr/bin/systemctl','daemon-reload')
 def config_unchanged(self):
  for p,key,uid in ((RECEIVER_ENV,'activeReceiverSha256',0),(SHARED_ENV,'sharedRedXEnvSha256',999),(Path('/etc/red-x-ai/gendragoon-receiver.env.prepared-36'),'preparedReceiverSha256',0)):
   private_file(p,uid);need(sha(p)==self.plan['privateConfig'][key],'configuration_changed')
 def stop(self,k):
  self.identity(k);need(not self.children(k),'children_active');p=self.properties(k);need(p['KillMode']=='mixed' and p['SendSIGKILL']=='no' and p['TimeoutStopUSec']=='infinity','effective_stop_settings_invalid');observed=self.fast_continuity(k);ack=self.acknowledge_mac();need(self.fast_continuity(k)==observed,'post_gate_old_process_changed');self.require_fresh_mac(ack);self.command('/usr/bin/systemctl','stop','--no-block','gendragoon-'+k+'.service');end=time.monotonic()+120
  while time.monotonic()<end:
   p=self.properties(k)
   if p['MainPID']=='0' and p['ActiveState']=='inactive':
    need(not self.children(k),'orphaned_children');
    if k=='receiver':need(not (Path(self.old_env['REDX_RECEIVERS_ROOT'])/'.writer-lock').exists(),'writer_lock_retained')
    return
   time.sleep(.25)
  raise Hold('ordinary_stop_incomplete_no_force')
 def switch(self):
  need('stopped' in self.preservation,'stopped_preservation_required');need(all(self.properties(k)['MainPID']=='0' for k in KINDS),'service_still_present');need(sha(SHARED_ENV)==self.plan['privateConfig']['sharedRedXEnvSha256'],'shared_environment_changed');self.config_unchanged();observed=self.stopped_continuity();ack=self.acknowledge_mac();need(self.stopped_continuity()==observed,'post_gate_stopped_configuration_changed');self.require_fresh_mac(ack);self.atomic(RECEIVER_ENV,self.prepared)
  for k,p in LINKS.items():self.require_fresh_mac(ack);need(p.is_symlink() and os.readlink(p)==ACTIVE[k],'old_link_changed');temp=p.with_name('.current-gd36-'+self.nonce);trusted_directory(p.parent);os.symlink(TARGETS[k],temp);os.replace(temp,p);directory=os.open(p.parent,os.O_RDONLY|os.O_DIRECTORY);os.fsync(directory);os.close(directory)
 def start(self,k):
  self.command('/usr/bin/systemctl','start','--no-block','gendragoon-'+k+'.service');value=self.proof.health(k);self.candidate_identity(k,allow_initial=True);return value
 def owned_listeners(self,pid):
  sockets=set()
  for fd in (Path('/proc')/str(pid)/'fd').iterdir():
   try:v=os.readlink(fd)
   except FileNotFoundError:continue
   if v.startswith('socket:['):sockets.add(v[8:-1])
  found=[]
  for name in ('tcp','tcp6'):
   for line in Path('/proc/net/'+name).read_text().splitlines()[1:]:
    f=line.split()
    if f[9] in sockets and f[3]=='0A':found.append((name,f[1]))
  return found
 def service_listeners(self,k,pid):
  need(self.owned_listeners(pid)==[('tcp','0100007F:'+format(17778 if k=='control' else 17779,'04X'))],'unexpected_service_listener')
 def candidate_identity(self,k,allow_initial=False):
  p=self.properties(k);pid=int(p['MainPID']);folder=Path('/proc')/str(pid);need(pid>1 and pid!=self.plan['expectedPIDs'][k] and p['ActiveState']=='active' and p['ControlGroup']=='/system.slice/gendragoon-'+k+'.service','candidate_identity_invalid')
  need(folder.stat().st_uid==pwd.getpwnam('redxai').pw_uid and os.readlink(folder/'exe')=='/usr/bin/node' and sha(folder/'exe')==self.plan['expectedNodeSha256'],'candidate_executable_invalid')
  need((folder/'cmdline').read_bytes().split(b'\0')[:-1]==[b'/usr/bin/node',str(LINKS[k]/'native/RedXCloud'/('control-server.cjs' if k=='control' else 'server.cjs')).encode()],'candidate_arguments_invalid')
  need(os.readlink(LINKS[k])==TARGETS[k] and self.proof.manifest(TARGETS[k],STAGE_HASHES[k])==STAGE_COUNTS[k],'candidate_source_changed')
  self.verify_membership(k,pid);raw=(folder/'environ').read_bytes();env=dict(v.split('=',1) for v in raw.decode().split('\0') if '=' in v);need(not env.get('NODE_OPTIONS') and not env.get('NODE_PATH'),'candidate_preload_invalid')
  volatile={'INVOCATION_ID','JOURNAL_STREAM','SYSTEMD_EXEC_PID'};expected={n:v for n,v in self.old_environments[k].items() if n not in volatile};expected.update(self.proof.environment_values(self.prepared) if k=='receiver' else {'GENDRAGOON_CONTROL_INTERNAL_TOKEN':self.token})
  need({n:v for n,v in env.items() if n not in volatile}==expected,'candidate_environment_unexpected')
  start=int((folder/'stat').read_text().split(') ',1)[1].split()[19]);identity=(pid,start,hashlib.sha256(raw).hexdigest())
  if k not in self.candidates:need(allow_initial,'candidate_identity_not_pinned');self.candidates[k]=identity
  need(self.candidates[k]==identity,'candidate_identity_changed');self.service_listeners(k,pid);return True
 def private_health(self):
  for k in KINDS:self.candidate_identity(k)
  self.proof.verify_private_runtime(self.token);self.proof.verify_internal_boundary(self.token,self.old_env.get('REDXAI_ISSUER','https://red-xai.com'));self.debugger_absent()
 def cleanup_proof(self):
  identities=all(self.candidate_identity(k) for k in KINDS)
  observed={k:self.fast_continuity(k,candidate=True) for k in KINDS};ack=self.acknowledge_mac();need({k:self.fast_continuity(k,candidate=True) for k in KINDS}==observed,'post_gate_candidate_changed');self.require_fresh_mac(ack)
  return self.net.CleanupProof(self.nonce,time.monotonic(),self.debugger_absent(),identities,'after-start' in self.preservation,healthy=True)
 def release_services(self):self.boundary.remove_service_fence(self.cleanup_proof())
 def service_probe(self):
  # Token is passed through a private pipe, never argv, logs or a child env.
  helper=HERE.parent/'server-activate-36.py';private_file(helper);need(sha(helper)==HELPER_HASHES[helper.name],'proof_helper_changed')
  code='import sys,json\nv=json.load(sys.stdin);scope={"__name__":"gd36_readonly_probe"};exec(compile(v["source"],"trusted_readonly_probe","exec"),scope);scope["verify_internal_boundary"](v["token"],v["issuer"])\n'
  packet={'source':helper.read_text(),'token':self.token,'issuer':self.old_env.get('REDXAI_ISSUER','https://red-xai.com')}
  r=subprocess.run(['/usr/sbin/runuser','-u','redxai','--','/usr/bin/python3','-I','-S','-B','-c',code],input=json.dumps(packet),text=True,capture_output=True,timeout=20,env={'PATH':'/usr/bin:/bin','LC_ALL':'C','PYTHONDONTWRITEBYTECODE':'1'});need(r.returncode==0,'service_identity_probe_failed')
 def cleanup(self):self.boundary.remove_guard(self.cleanup_proof());need(sha(SHARED_ENV)==self.plan['privateConfig']['sharedRedXEnvSha256'],'shared_environment_changed')

MAC_PROVENANCE=Path('/Users/grim-virus/GenDragoonRelease-0.22.0-36-recovery-final/build-provenance.json')
MAC_PROVENANCE_SHA='468cdfcf4cc4571d52f037e5dd1dffd771f1e09b23e3800d1048c9c009061d1b'
MAC_REPO=Path('/Users/grim-virus/Documents/CodeProjects/RedXAI-integration-9dql2_5l/gendragoon-cloud-ssd')

def verify_mac_inputs(app):
 """Read-only binding to root's existing frozen86 inputs and signed package."""
 need(sha(MAC_PROVENANCE)==MAC_PROVENANCE_SHA,'mac_provenance_changed');record=json.loads(MAC_PROVENANCE.read_text());need(record['schema']==1 and record['sourceCommit']=='bd5983e98965fa5f554f9c53232f25550a1e8887' and len(record['sourceInputs'])==86,'mac_freeze_invalid')
 mappings=record['packagedSourceMappings'];required={'gendragoon_update_restart.py','gendragoon_auto_update.py','gendragoon_app_control.py','gendragoon_app_launch.py','gendragoon_library.py','gendragoon_upload_workspace.py','gendragoon_performance.py','gendragoon_redx_storage.py','gendragoon_progress.py','gendragoon_device_origin.py','gendragoon_auth_broker.py','gendragoon_transfer_errors.py','gendragoon_platform_ipc.py','gendragoon_performance_profiles.json'}
 need({'Contents/Resources/'+v for v in required}.issubset(set(mappings.values())),'mac_helper_not_frozen')
 for name,expected in record['sourceInputs'].items():
  relative=Path(name);need(not relative.is_absolute() and '..' not in relative.parts,'mac_source_scope_invalid');path=MAC_REPO/relative;info=path.lstat();need(path.resolve()==path and stat.S_ISREG(info.st_mode) and info.st_uid in (0,os.getuid()) and not info.st_mode&0o022 and info.st_size==expected['bytes'] and sha(path)==expected['sha256'],'mac_frozen_source_changed')
 for name,relative in mappings.items():
  relative=Path(relative);need(name in record['sourceInputs'] and not relative.is_absolute() and relative.parts[0]=='Contents' and '..' not in relative.parts,'mac_mapping_invalid');path=app/relative;info=path.lstat();need(path.resolve()==path and stat.S_ISREG(info.st_mode) and info.st_uid in (0,os.getuid()) and not info.st_mode&0o022 and sha(path)==record['sourceInputs'][name]['sha256'],'mac_packaged_source_changed')
 result=subprocess.run(['/usr/bin/codesign','--verify','--strict','--deep',str(app)],capture_output=True,text=True,timeout=20,env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','LC_ALL':'C','PYTHONDONTWRITEBYTECODE':'1'});need(result.returncode==0,'mac_signature_invalid')
 result=subprocess.run(['/usr/bin/codesign','--display','--verbose=4',str(app)],capture_output=True,text=True,timeout=20,env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','LC_ALL':'C','PYTHONDONTWRITEBYTECODE':'1'});need(result.returncode==0,'mac_signature_unavailable');identity=result.stderr;expected=record['signedBuildIdentityAfterVerification']
 for field in ('Identifier','TeamIdentifier','CDHash'):
  old=re.search('^'+field+'=(.+)$',expected,re.M);new=re.search('^'+field+'=(.+)$',identity,re.M);need(old is not None and new is not None and old[1]==new[1],'mac_signature_identity_changed')
 return record

def collect_mac_proof(lifecycle,app,support,executable,challenge,lease_held):
 # Existing verified lifecycle helpers perform strict queue/schema/active-job,
 # sessions/open-files, mount/helper and dirty-VFS inspection without mutation.
 lifecycle.ensure_queue_idle(support);lifecycle.ensure_clean_cache(support);lifecycle.ensure_quiet(app,samples=1)
 raw=subprocess.check_output(['/usr/sbin/ioreg','-l','-w','0'],text=True,timeout=20,env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','LC_ALL':'C','PYTHONDONTWRITEBYTECODE':'1'});locks=re.findall(r'"IOConsoleLocked"\s*=\s*(Yes|No|true|false)',raw)
 value={'source':'native-mac-preflight','challenge':challenge,'observedAtEpoch':time.time(),'screenUnlocked':bool(locks) and all(x in ('No','false') for x in locks),'uploadWorkspaceTerminal':True,'appControlIdle':True,'nativeAppClosedVerified':not lifecycle.control.app_pids(executable),'maintenanceLeaseHeld':lease_held};validate_mac_proof(value,challenge);return value

def coordinate_stream(child,proof,interval=1.0):
 """Periodic bounded observation, fresh phase replies, no operation cancellation."""
 next_check=time.monotonic()+interval;pending=b''
 try:
  while True:
   if time.monotonic()>=next_check:proof(uuid.uuid4().hex);next_check=time.monotonic()+interval
   if not select.select([child.stdout],[],[],min(.5,max(0,next_check-time.monotonic())))[0]:continue
   chunk=os.read(child.stdout.fileno(),16385)
   if not chunk:need(not pending,'remote_partial_receipt');break
   pending+=chunk
   while b'\n' in pending:
    line,pending=pending.split(b'\n',1);need(0<len(line)<=16384,'remote_receipt_invalid');value=json.loads(line.decode('utf-8'))
    if value.get('type')=='mac_gate_request':
     child.stdin.write(json.dumps(proof(value['challenge']))+'\n');child.stdin.flush();next_check=time.monotonic()+interval
    else:print(json.dumps(value),flush=True)
   need(len(pending)<=16384,'remote_receipt_invalid')
  return child.wait()
 finally:
  child.stdin.close() # EOF holds before the remote next phase; no cancellation.

def mac_coordinate(args):
 need(sys.platform=='darwin','mac_coordinator_required');app=Path('/Applications/GenDragoon Cloud SSD.app');verify_mac_inputs(app);support=Path.home()/'Library/Application Support/GenDragoon Cloud SSD';fd=os.open(support/'AutoUpdates/update.lock',os.O_RDONLY|os.O_NOFOLLOW);info=os.fstat(fd);need(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and info.st_nlink==1 and info.st_mode&0o077==0,'maintenance_lease_invalid');fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 try:
  resources=app/'Contents/Resources';lifecycle=module('gd36_native_lifecycle',resources/'gendragoon_update_restart.py');lifecycle.load_runtime(resources);control=lifecycle.control
  import plistlib
  executable=app/'Contents/MacOS'/plistlib.loads((app/'Contents/Info.plist').read_bytes())['CFBundleExecutable']
  def proof(challenge):
   verify_mac_inputs(app)
   return collect_mac_proof(lifecycle,app,support,executable,challenge,True)
  proof(uuid.uuid4().hex);need(re.fullmatch('/root/gendragoon36-maintenance-[0-9a-f]{64}',args.remote_bundle),'remote_bundle_invalid')
  command=args.remote_bundle+'/adapter/server-activation-controller-36.py';child=subprocess.Popen(['/usr/bin/ssh','-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',str(Path.home()/'.ssh/id_ed25519'),'root@103.54.56.220','/usr/bin/python3','-I','-S','-B',command,'--execute','--plan',args.remote_bundle+'/plan.json','--review-manifest',args.remote_bundle+'/review.json'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','LC_ALL':'C','PYTHONDONTWRITEBYTECODE':'1'})
  return coordinate_stream(child,proof)
 finally:os.close(fd)

def main(args):
 if args.local_coordinate:return mac_coordinate(args)
 if not args.execute:print(json.dumps({'decision':'NO_GO','defaultReadOnly':True,'executionRequiresReviewedBundleAndLiveMacCoordinator':True,'noLiveActionsPerformed':True}));return 3
 need(args.plan and args.review_manifest,'reviewed_plan_required');private_file(args.plan);private_file(args.review_manifest);plan=json.loads(Path(args.plan).read_text());review=json.loads(Path(args.review_manifest).read_text());need(review['planSha256']==sha(args.plan),'reviewed_plan_changed');verify_bundle(review);mac_gate=MacRPCGate();ops=LiveOps(plan,review,mac_gate=mac_gate);result=Controller(ops,mac_gate,ops.journal).run();print(json.dumps(result),flush=True);return 0 if result.get('activationComplete') is True else 3

if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--execute',action='store_true');p.add_argument('--plan');p.add_argument('--review-manifest');p.add_argument('--local-coordinate',action='store_true');p.add_argument('--remote-bundle');args=p.parse_args()
 try:raise SystemExit(main(args))
 except Hold:print('{"decision":"NO_GO","error":"protected_or_unreviewed_hold","noForce":true}',flush=True);raise SystemExit(3)
