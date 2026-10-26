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
const {RedXState}=require('/usr/local/lib/gendragoon-receiver/current/native/RedXCloud/redx-state.cjs');
(async()=>{const dest=process.argv[1],s=fs.lstatSync(require('node:path').dirname(dest));if(s.uid!==0||(s.mode&0o777)!==0o700)throw Error('private backup directory required');
 const store=new RedXState({url:process.env.REDX_URL,key:process.env.REDX_RECEIVERS_KEY,db:process.env.REDX_RECEIVERS_DB||'gendragoon_receivers',local:process.env.REDX_LOCAL_LOOPBACK==='1'}),fd=fs.openSync(dest,'wx',0o600),hash=crypto.createHash('sha256');
 const result={tables:{},accounts:0,notes:0,libraryItems:0,objects:0,reservations:0,pendingAccountDeletions:0,durableWorkspaceDeletions:0,deletingWorkspaceFlags:0,deletingWorkspaceStatuses:0,deletingControlProjects:0,deletingWorkspaces:0,accountingBytes:0};
 const put=o=>{const b=Buffer.from(JSON.stringify(o)+'\n');fs.writeSync(fd,b);hash.update(b);};put({schema:1,format:'gendragoon-private-logical-snapshot/v1'});
 try{for(const [file,table,columns,limit]of[
  ['receivers.red-xai.db','Receiver',['ID','Owner','Revision','State'],1],
  ['dev-teams.red-xai.db','DevEntry',['ID','K','Scope','Kind','Position','Revision','ExpiresAtMs','State'],10],
  ['integrations.red-xai.db','Integration',['ID','Revision','State'],2]]){
  let after=-1,count=0;for(;;){let r;try{r=await store.call('POST','bx',{q:`{Get[]} = "${file}":${table}[ID > $after] -> [${columns.join(', ')}], Sort = ID, Limit = ${limit}`,params:{after}});}catch(e){if(e.status===404)break;throw e;}
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

def metadata(env,backup,prefix):
 target=private_directory(backup)/(prefix+'-metadata.jsonl')
 r=subprocess.run(['/usr/bin/node','-e',NODE,str(target)],env=env,capture_output=True,text=True,timeout=600)
 if r.returncode:raise RuntimeError('private Get-only metadata snapshot failed')
 value=json.loads(r.stdout);value['metadataFile']=target.name;return value

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
