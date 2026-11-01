#!/usr/bin/env python3
"""Release36 READ-ONLY preflight. Activation is intentionally unavailable.

Old Control33 has no complete async-drain boundary. Even --activate fails closed
before all filesystem/network/service operations. There is no config, link,
firewall, service, database or writer-lock mutation implementation in this file.
Private HTTP helpers are for isolated tests and separately reviewed future use.
"""
import sys
sys.dont_write_bytecode=True
from pathlib import Path
import argparse,datetime,hashlib,hmac,importlib.util,json,os,re,stat,subprocess,time,urllib.error,urllib.parse,urllib.request,uuid
PRODUCTS=('receiver','control')
ENV=Path('/etc/red-x-ai/gendragoon-receiver.env')
SHARED_ENV=Path('/opt/redx/etc/redxd.env')
CONTROL_ENV=Path('/etc/red-x-ai/gendragoon-control.env')
STORAGE=Path('/srv/red-xai/gendragoon-receivers')

def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def run(*args):
 if args[:2]!=('systemctl','show'):raise ValueError('only read-only service property queries are allowed')
 return subprocess.check_output(args,text=True,timeout=15).strip()
def props(kind):
 raw=run('systemctl','show','gendragoon-'+kind,'-p','MainPID','-p','ActiveState','-p','ControlGroup','-p','KillMode','-p','SendSIGKILL','-p','TimeoutStopUSec')
 return dict(x.split('=',1) for x in raw.splitlines() if '=' in x)
def private_file(p,expected_uid=0):
 s=p.lstat();assert stat.S_ISREG(s.st_mode) and not p.is_symlink() and s.st_uid==expected_uid and s.st_nlink==1 and s.st_mode&0o077==0;return s

def manifest(root,expected):
 root=Path(root);assert root.resolve()==root and root.is_dir()
 m=root/'SOURCE_MANIFEST.sha256';assert sha(m)==expected
 rows={}
 for line in m.read_text().splitlines():
  digest,name=line.split('  ',1);relative=Path(name)
  assert not relative.is_absolute() and '..' not in relative.parts and name not in rows
  rows[name]=digest
 found={}
 for p in root.rglob('*'):
  assert not p.is_symlink()
  if p.is_file() and p!=m:found[str(p.relative_to(root))]=sha(p)
 assert found==rows
 return len(rows)

def process_environment(pid):return dict(x.split('=',1) for x in Path('/proc/'+str(pid)+'/environ').read_bytes().decode().split('\0') if '=' in x)
def same_data(left,right):
 assert left['metadata']['logicalSha256']==right['metadata']['logicalSha256'],'metadata changed; never restore an old ledger automatically'
 assert left['metadata']['tables']==right['metadata']['tables'],'table coverage changed'
 assert left['payload']['fileManifestSha256']==right['payload']['fileManifestSha256'],'payload changed; retain all files and backups'

class DenyRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl):
  raise urllib.error.HTTPError(req.full_url,code,'redirect forbidden',headers,fp)

def private_open(request,*,allowed,timeout=15):
 url=request.full_url if isinstance(request,urllib.request.Request) else request
 if not isinstance(url,str) or url not in allowed:raise ValueError('unreviewed loopback URL')
 value=urllib.parse.urlsplit(url)
 if value.scheme!='http' or value.hostname!='127.0.0.1':raise ValueError('literal IPv4 loopback HTTP required')
 if value.username or value.password or value.query or value.fragment:raise ValueError('userinfo, query or fragment forbidden')
 if value.netloc!='127.0.0.1:'+str(value.port):raise ValueError('canonical literal loopback authority required')
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),DenyRedirect())
 return opener.open(request,timeout=timeout)

def bounded_response(response):
 raw=response.read(16385);assert len(raw)<=16384,'oversized private response';return raw

def health(kind,seconds=60):
 port={'control':17778,'receiver':17779}[kind];deadline=time.monotonic()+seconds
 url='http://127.0.0.1:'+str(port)+'/healthz'
 while time.monotonic()<deadline:
  try:
   with private_open(url,allowed={url},timeout=2) as r:value=json.loads(bounded_response(r))
   assert value.get('billing') is True and value.get('redx') is True if kind=='control' else value.get('productionReady') is True and value.get('developmentOnly') is False
   return value
  except Exception:time.sleep(1)
 raise RuntimeError(kind+' did not reach verified health')

def verify_internal_boundary(token,issuer):
 subject='gendragoon-activation-readonly-'+uuid.uuid4().hex
 owner=hashlib.sha256(json.dumps(['red-xai-receiver/v1',issuer,subject],separators=(',',':')).encode()).hexdigest()
 body=json.dumps({'owner':owner,'issuer':issuer,'subject':subject,'workspaceId':uuid.uuid4().hex}).encode()
 for credential,expected,code in ((None,401,'service_login_required'),(token,404,'workspace_not_found')):
  headers={'content-type':'application/json'}
  if credential:headers['authorization']='Bearer '+credential
  url='http://127.0.0.1:17778/internal/receiver-entitlements'
  req=urllib.request.Request(url,data=body,headers=headers,method='POST')
  try:
   with private_open(req,allowed={url},timeout=15) as response:status=response.status;raw=bounded_response(response)
  except urllib.error.HTTPError as error:
   with error:status=error.code;raw=bounded_response(error)
  assert len(raw)<=16384 and status==expected and json.loads(raw).get('error')==code,'private service boundary did not fail closed'
 return {'unauthenticatedDenied':True,'existingCredentialAcceptedForReadOnlyUnknownAccountLookup':True,'noAccountProvisioned':True}

def verify_private_runtime(token):
 result={}
 for kind,port in (('control',17778),('receiver',17779)):
  pid=int(props(kind)['MainPID']);assert pid>1;values=process_environment(pid)
  assert hmac.compare_digest(values.get('GENDRAGOON_CONTROL_INTERNAL_TOKEN',''),token)
  if kind=='receiver':assert values.get('GENDRAGOON_INTEGRATION_ENTITLEMENTS_URL')=='http://127.0.0.1:17778/internal/receiver-entitlements'
  sockets=set()
  for fd in Path('/proc/'+str(pid)+'/fd').iterdir():
   try:entry=os.readlink(fd)
   except FileNotFoundError:continue
   if entry.startswith('socket:['):sockets.add(entry[8:-1])
  listeners=[]
  for name in ('tcp','tcp6'):
   for line in Path('/proc/net/'+name).read_text().splitlines()[1:]:
    fields=line.split()
    if fields[9] in sockets and fields[3]=='0A':listeners.append((name,fields[1]))
  assert listeners==[('tcp','0100007F:'+format(port,'04X'))],'only the reviewed IPv4 loopback listener is permitted'
  result[kind]={'samePrivateCredentialLoaded':True,'listener':'127.0.0.1:'+str(port)}
 return result

def environment_values(data):
 result={}
 for line in data.decode().splitlines():
  if re.match(r'^[A-Za-z_][A-Za-z0-9_]*=',line):
   key,value=line.split('=',1);result[key]=value.strip().strip('"\'')
 return result

ACTIVATION_BLOCKER = (
 'Control33 still lacks an approved live no-new-admission and complete async-drain '
 'adapter. A local exact-source Node20 prototype exists, pending Linux CI and review. Zero sockets, blocked SYNs, stable snapshots and candidate36 lifecycle '
 'tests cannot prove completion of disconnected handlers or background workers '
 'inside the CURRENT old PID. Root needs a reviewed application-level completion '
 'mechanism covering admitted/detached handlers and account locks while all '
 'admissions stay blocked; any separately identified worker must also be covered. An externally supervised '
 'offline boundary must prove that work completed BEFORE the old PID exited '
 'normally, and retain admission isolation throughout replacement. No such proof '
 'adapter exists here; a separate reviewed implementation and explicit activation '
 'authority are required. This artifact cannot activate.'
)

class ActivationBlocked(RuntimeError):pass

def require_activation_boundary():
 # Do not turn an idle sample, elapsed interval or supplied JSON flag into stop authority.
 raise ActivationBlocked(ACTIVATION_BLOCKER)

def validate_plan(plan,stage,control):
 assert plan['schema']==2 and plan['activationAuthorized'] is False
 assert plan['readOnlyArtifact'] is True and plan['activationImplemented'] is False
 assert plan['maintenanceBoundary']['status']=='UNRESOLVED'
 assert stage['activated'] is False and control['activated'] is False
 for kind,receipt in (('receiver',stage),('control',control)):
  expected=plan['stages'][kind]
  assert receipt['sourceCommit']==expected['sourceCommit']
  assert receipt[kind]['prepared']==expected['path']
  assert receipt[kind]['manifestSha256']==expected['manifestSha256']
  assert receipt[kind]['files']==expected['files']
 assert control['control']['gracefulCLIProof'] is True

def readonly_preflight(plan,stage,control):
 assert os.geteuid()==0,'read-only preflight runs on the reviewed GenDragoon server as root'
 validate_plan(plan,stage,control)
 checked={k:manifest(plan['stages'][k]['path'],plan['stages'][k]['manifestSha256']) for k in PRODUCTS}
 assert checked=={k:plan['stages'][k]['files'] for k in PRODUCTS}
 cfg=plan['privateConfig']
 assert cfg['activeReceiver']==str(ENV) and cfg['sharedRedXEnv']==str(SHARED_ENV)
 assert cfg['controlOnlyOverlay']==str(CONTROL_ENV)
 assert cfg['preparedReceiver']=='/etc/red-x-ai/gendragoon-receiver.env.prepared-36'
 for path in (ENV,Path(cfg['preparedReceiver'])):private_file(path)
 # Shared service configuration keeps its verified service owner; never chmod/chown/write it.
 private_file(SHARED_ENV,expected_uid=cfg['sharedRedXEnvUid'])
 assert sha(ENV)==cfg['activeReceiverSha256'] and sha(SHARED_ENV)==cfg['sharedRedXEnvSha256'] and sha(cfg['preparedReceiver'])==cfg['preparedReceiverSha256']
 links={k:os.readlink('/usr/local/lib/gendragoon-'+k+'/current') for k in PRODUCTS}
 assert links==plan['expectedActiveBefore']
 old=environment_values(ENV.read_bytes());new=environment_values(Path(cfg['preparedReceiver']).read_bytes())
 assert all(new.get(k)==v for k,v in old.items())
 token=new['GENDRAGOON_CONTROL_INTERNAL_TOKEN'];assert re.fullmatch('[A-Za-z0-9_-]{43,128}',token)
 assert new['GENDRAGOON_INTEGRATION_ENTITLEMENTS_URL']=='http://127.0.0.1:17778/internal/receiver-entitlements'
 services={k:props(k) for k in PRODUCTS}
 return {'schema':2,'readOnly':True,'targetFiles':checked,'currentLinksUnchanged':True,'serviceProperties':services,'privateConfigHashesMatch':True,'preparedCredentialShapeAndLoopbackURLValid':True,'activationAuthorized':False,'activationImplemented':False,'decision':'NO_GO','blocker':ACTIVATION_BLOCKER}

def main(args):
 # Reject activation before root/files/network/backups/config/signals/services.
 if args.activate:require_activation_boundary()
 plan=json.loads(Path(args.plan).read_text());stage=json.loads(Path(args.receiver_stage).read_text());control=json.loads(Path(args.control_stage).read_text())
 print(json.dumps(readonly_preflight(plan,stage,control),indent=2))

if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--plan',required=True);parser.add_argument('--receiver-stage',required=True);parser.add_argument('--control-stage',required=True);parser.add_argument('--activate',action='store_true',help='always fails closed; activation is not implemented')
 try:main(parser.parse_args())
 except ActivationBlocked as error:
  print(json.dumps({'decision':'NO_GO','activated':False,'mutationsPerformed':False,'blocker':str(error)},indent=2));raise SystemExit(3)
