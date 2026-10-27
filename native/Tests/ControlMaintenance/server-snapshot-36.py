#!/usr/bin/env python3
"""Private read-only logical/payload proof, invoked only after root's review.

Writes NEW files only under an existing root-owned0700 backup directory.
Queries are Get-only. No application GET routes, Stripe calls, CAS, cleanup,
filesystem deletes, state restore, lock changes or service operations.
"""
from pathlib import Path
import hashlib,json,os,re,stat,subprocess,sys
NODE=r'''
const fs=require('node:fs'),crypto=require('node:crypto');
class CloudError extends Error { constructor(code,status=400) { super(code); this.code=code; this.status=status; } }
function origin(value, dev = false) {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' ||
      (u.protocol !== 'https:' && !(dev && u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname)))) throw new Error('HTTPS origin required (explicit loopback development only)');
  return u.origin;
}
class RedXState {
  #key;
  constructor({url, key, db, dev = false, local = false, fetchImpl = fetch}) {
    this.url = origin(url, dev || local);
    if (local && new URL(this.url).hostname !== '127.0.0.1') throw new Error('Local RedX service must use IPv4 loopback');
    if (!key || !/^[a-z][a-z0-9_]{1,50}$/.test(db) || db === 'redxai_accounts') throw new Error('Separate Receiver metadata database and scoped service key required');
    this.#key = key; this.db = db; this.fetch = fetchImpl;
  }
  async call(method, route, body) {
    // No caller-selected route, verb, query, database or mutation is accepted.
    const allowedQueries = new Set([
      '{Get[]} = "receivers.red-xai.db":Receiver[ID > $after] -> [ID, Owner, Revision, State], Sort = ID, Limit = 1',
      '{Get[]} = "dev-teams.red-xai.db":DevEntry[ID > $after] -> [ID, K, Scope, Kind, Position, Revision, ExpiresAtMs, State], Sort = ID, Limit = 10',
      '{Get[]} = "integrations.red-xai.db":Integration[ID > $after] -> [ID, Revision, State], Sort = ID, Limit = 2'
    ]);
    if (method !== 'POST' || route !== 'bx' || !body ||
        JSON.stringify(Object.keys(body).sort()) !== '["params","q"]' ||
        !allowedQueries.has(body.q) || !body.params ||
        JSON.stringify(Object.keys(body.params)) !== '["after"]' ||
        !Number.isSafeInteger(body.params.after) || body.params.after < -1)
      throw new Error('Read-only observer request refused');
    const r = await this.fetch(this.url + '/v1/db/' + this.db + '/' + route, {
      method, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: {authorization: 'Bearer ' + this.#key, 'content-type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.status === 404) throw new CloudError('not_found', 404);
    if (r.status === 409) throw new CloudError('concurrent_update', 409);
    if (!r.ok) throw new CloudError('metadata_unavailable', 503);
    const text = await r.text();
    if (text.length > 2 * 1024 * 1024) throw new CloudError('metadata_limit', 503);
    return text ? JSON.parse(text) : {};
  }
  address(owner) { return Number.parseInt(owner.slice(0, 13), 16); }
}
(async()=>{ if(process.env.REDX_LOCAL_LOOPBACK!=='1'||(process.env.REDX_RECEIVERS_DB||'gendragoon_receivers')!=='gendragoon_receivers'||crypto.createHash('sha256').update(process.env.REDX_URL||'').digest('hex')!=='f8005e84b912eec2701dd1ab2386c43550f389788499a1584177d31ab23eb895')throw Error('Private snapshot scope refused');
const dest=process.argv[1],s=fs.lstatSync(require('node:path').dirname(dest));if(s.isSymbolicLink()||!s.isDirectory()||s.uid!==0||(s.mode&0o777)!==0o700||require('node:path').resolve(dest)!==dest||fs.realpathSync(require('node:path').dirname(dest))!==require('node:path').dirname(dest))throw Error('private backup directory required');
 const store=new RedXState({url:process.env.REDX_URL,key:process.env.REDX_RECEIVERS_KEY,db:process.env.REDX_RECEIVERS_DB||'gendragoon_receivers',local:process.env.REDX_LOCAL_LOOPBACK==='1'}),fd=fs.openSync(dest,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600),hash=crypto.createHash('sha256');
 const result={tables:{},accounts:0,notes:0,libraryItems:0,objects:0,reservations:0,pendingAccountDeletions:0,durableWorkspaceDeletions:0,deletingWorkspaceFlags:0,deletingWorkspaceStatuses:0,deletingControlProjects:0,deletingWorkspaces:0,accountingBytes:0};
 const put=o=>{const b=Buffer.from(JSON.stringify(o)+'\n');let offset=0;while(offset<b.length){const n=fs.writeSync(fd,b,offset,b.length-offset,null);if(!Number.isInteger(n)||n<=0||n>b.length-offset)throw Error('Private metadata write incomplete');offset+=n;}hash.update(b);};
 try{put({schema:1,format:'gendragoon-private-logical-snapshot/v1'});for(const [file,table,columns,limit]of[
  ['receivers.red-xai.db','Receiver',['ID','Owner','Revision','State'],1],
  ['dev-teams.red-xai.db','DevEntry',['ID','K','Scope','Kind','Position','Revision','ExpiresAtMs','State'],10],
  ['integrations.red-xai.db','Integration',['ID','Revision','State'],2]]){
  let after=-1,count=0;for(;;){let r;try{r=await store.call('POST','bx',{q:`{Get[]} = "${file}":${table}[ID > $after] -> [${columns.join(', ')}], Sort = ID, Limit = ${limit}`,params:{after}});}catch(e){if(e.status===404&&count===0&&table!=='Receiver')break;throw e;}
   if(Array.isArray(r.columns)&&r.columns.length===0&&Array.isArray(r.rows)&&r.rows.length===0)break;
   if(JSON.stringify(r.columns)!==JSON.stringify(columns)||!Array.isArray(r.rows)||r.rows.length>limit)throw Error('snapshot shape invalid');if(!r.rows.length)break;
   for(const row of r.rows){if(!Array.isArray(row)||row.length!==columns.length||!Number.isSafeInteger(row[0])||row[0]<=after)throw Error('snapshot order invalid');after=row[0];let value=row.at(-1);for(let n=0;n<3&&typeof value==='string';n++)value=JSON.parse(value);if(!value||typeof value!=='object')throw Error('snapshot state invalid');
    if(table==='Receiver'){
     if(value.id!==value.owner||store.address(value.owner)!==row[0]||row[1]!==value.owner||row[2]!==value.revision)throw Error('snapshot owner binding invalid');
     result.accounts++;result.notes+=Object.keys(value.workspaces||{}).length;result.libraryItems+=Object.keys(value.library||{}).length;result.objects+=Object.keys(value.objects||{}).length;result.reservations+=Object.keys(value.reservations||{}).length;result.pendingAccountDeletions+=value.accountDeletion&&value.accountDeletion.status!=='completed'?1:0;
     const durable=Object.keys(value.workspaceDeletions||{}),workspaces=Object.entries(value.workspaces||{}),projects=Object.entries(value.control?.projects||{});
     result.durableWorkspaceDeletions+=durable.length;
     result.deletingWorkspaceFlags+=workspaces.filter(([,w])=>w?.deleting).length;
     result.deletingWorkspaceStatuses+=workspaces.filter(([,w])=>w?.status==='deleting').length;
     result.deletingControlProjects+=projects.filter(([,p])=>p?.status==='deleting').length;
     result.deletingWorkspaces+=new Set([...durable,...workspaces.filter(([,w])=>w?.deleting||w?.status==='deleting').map(([id])=>id),...projects.filter(([,p])=>p?.status==='deleting').map(([id])=>id)]).size;
     result.accountingBytes+=value.used||0;
    }
    put({file,table,columns,row});count++;
   }
  }result.tables[table]=count;
 }fs.fsyncSync(fd);}finally{fs.closeSync(fd);}result.logicalSha256=hash.digest('hex');console.log(JSON.stringify(result));
})().catch(()=>{console.error('Private Get-only metadata snapshot failed; no server changes performed.');process.exitCode=1;});
'''

def private_directory(path):
 path=Path(path);s=path.lstat()
 assert path.is_absolute() and path.resolve()==path and stat.S_ISDIR(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o700
 return path

def file_stamp(info):
 return (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns,
         info.st_uid,info.st_gid,info.st_mode,info.st_nlink)

def snapshot_environment(env):
 child={'PATH':'/usr/bin:/bin','LC_ALL':'C'}
 for key in ('REDX_URL','REDX_RECEIVERS_KEY','REDX_RECEIVERS_DB','REDX_LOCAL_LOOPBACK'):
  if key in env:
   assert type(env[key]) is str
   child[key]=env[key]
 return child

def metadata_readback(target,backup,expected):
 directory=private_directory(backup);parent=directory.lstat()
 assert target.parent==directory and target.resolve()==target
 before=target.lstat()
 assert stat.S_ISREG(before.st_mode) and before.st_uid==parent.st_uid and stat.S_IMODE(before.st_mode)==0o600 and before.st_nlink==1
 descriptor=os.open(target,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC);digest=hashlib.sha256()
 with os.fdopen(descriptor,'rb') as stream:
  opened=os.fstat(stream.fileno());assert file_stamp(before)==file_stamp(opened)
  for block in iter(lambda:stream.read(1024*1024),b''):digest.update(block)
  after=os.fstat(stream.fileno())
 assert file_stamp(before)==file_stamp(after)==file_stamp(target.lstat())
 assert digest.hexdigest()==expected,'metadata backup bytes did not match logical digest'
 private_directory(directory)
 descriptor=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
 try:
  assert file_stamp(parent)==file_stamp(os.fstat(descriptor))
  os.fsync(descriptor)
 finally:os.close(descriptor)

def metadata(env,backup,prefix):
 assert type(prefix) is str and re.fullmatch('[a-z0-9-]{1,72}',prefix)
 directory=private_directory(backup);target=directory/(prefix+'-metadata.jsonl')
 r=subprocess.run(['/usr/bin/node','-e',NODE,str(target)],env=snapshot_environment(env),capture_output=True,text=True,timeout=600)
 if r.returncode:raise RuntimeError('private Get-only metadata snapshot failed')
 assert len(r.stdout)<=16384
 value=json.loads(r.stdout)
 counters=('accounts','notes','libraryItems','objects','reservations','pendingAccountDeletions','durableWorkspaceDeletions','deletingWorkspaceFlags','deletingWorkspaceStatuses','deletingControlProjects','deletingWorkspaces','accountingBytes')
 assert type(value) is dict and set(value)=={'tables','logicalSha256',*counters}
 assert type(value['tables']) is dict and set(value['tables'])=={'Receiver','DevEntry','Integration'}
 assert all(type(n) is int and n>=0 for n in value['tables'].values())
 assert all(type(value[key]) is int and value[key]>=0 for key in counters)
 assert type(value['logicalSha256']) is str and re.fullmatch('[0-9a-f]{64}',value['logicalSha256'])
 metadata_readback(target,directory,value['logicalSha256'])
 value['metadataFile']=target.name;return value

def payload(env,backup,prefix):
 root=Path(env['REDX_RECEIVERS_ROOT']);assert root.is_absolute() and root.resolve()==root
 target=private_directory(backup)/(prefix+'-files.jsonl');h=hashlib.sha256();totals={'files':0,'bytes':0,'pngFiles':0,'pngBytes':0,'sidecarFiles':0,'partialFiles':0}
 descriptor=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(descriptor,'wb') as output:
  def walk(folder):
   for path in sorted(folder.iterdir(),key=lambda p:p.name):
    s=path.lstat();relative=path.relative_to(root)
    assert not stat.S_ISLNK(s.st_mode)
    if relative==Path('.writer-lock'):
     assert stat.S_ISDIR(s.st_mode) and not any(path.iterdir());continue
    if stat.S_ISDIR(s.st_mode):yield from walk(path)
    else:
     assert stat.S_ISREG(s.st_mode);yield path,s
  for path,before in walk(root):
   file_hash=hashlib.sha256();fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
   with os.fdopen(fd,'rb') as file:
    opened=os.fstat(file.fileno());assert (opened.st_dev,opened.st_ino,opened.st_size,opened.st_mtime_ns,opened.st_ctime_ns)==(before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)
    for block in iter(lambda:file.read(1024*1024),b''):file_hash.update(block)
    after=os.fstat(file.fileno());assert (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns)==(before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)
   final=path.lstat();assert (final.st_dev,final.st_ino,final.st_size,final.st_mtime_ns,final.st_ctime_ns)==(before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)
   row={'path':str(path.relative_to(root)),'bytes':before.st_size,'sha256':file_hash.hexdigest()};line=(json.dumps(row,separators=(',',':'),ensure_ascii=True)+'\n').encode();output.write(line);h.update(line)
   totals['files']+=1;totals['bytes']+=before.st_size
   if path.suffix=='.png':totals['pngFiles']+=1;totals['pngBytes']+=before.st_size
   if path.suffix=='.json':totals['sidecarFiles']+=1
   if path.name.endswith('.partial'):totals['partialFiles']+=1
  output.flush();os.fsync(output.fileno())
 return dict(totals,fileManifestSha256=h.hexdigest(),fileManifest=target.name)

def snapshot(env,backup,prefix):
 assert re.fullmatch('[a-z0-9-]{1,60}',prefix)
 first=metadata(env,backup,prefix+'-before');files=payload(env,backup,prefix);second=metadata(env,backup,prefix+'-after')
 assert first['logicalSha256']==second['logicalSha256'],'metadata changed during payload scan'
 assert_quiet_metadata(first)
 assert files['partialFiles']==0,'active partial payload work'
 return {'schema':1,'metadata':first,'metadataStableDuringPayloadHash':True,'payload':files}

def assert_quiet_metadata(value):
 assert set(value['tables'])=={'Receiver','DevEntry','Integration'},'all three metadata tables must be covered'
 for key in ('reservations','pendingAccountDeletions','durableWorkspaceDeletions','deletingWorkspaceFlags','deletingWorkspaceStatuses','deletingControlProjects','deletingWorkspaces'):
  assert type(value[key]) is int and value[key]==0,'active storage/deletion work: '+key

if __name__=='__main__':
 if len(sys.argv)!=4:raise SystemExit('usage: server-snapshot-36.py BACKUP_DIR PREFIX RECEIVER_PID')
 assert os.geteuid()==0
 pid=int(sys.argv[3]);assert pid>1
 env=dict(v.split('=',1) for v in Path('/proc/'+str(pid)+'/environ').read_bytes().decode().split('\0') if '=' in v)
 print(json.dumps(snapshot(env,sys.argv[1],sys.argv[2]),indent=2))
