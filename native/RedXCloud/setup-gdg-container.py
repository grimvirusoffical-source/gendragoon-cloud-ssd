#!/usr/bin/env python3
"""Provision GenDragoon-only DB grants through the existing RedX administration API.

Run as the authorized Kamatera operator. Uses the documented RedX recovery CLI
for a short-lived provisioning credential, revokes it before exit, and never
prints any credential. Does not modify database engine/account/login code.
"""
import argparse
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

API='http://127.0.0.1:7790'
BASE=Path('/etc/red-x-ai')
USER_DB='redx_accounts'
MEDIA_DB='gendragoon_media'
RECEIPT=BASE/'gendragoon-gdg-provisioning.json'

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):
        raise RuntimeError('Administration redirects are forbidden')

def api(key,method,path,value=None,raw=None):
    body=raw if raw is not None else None if value is None else json.dumps(value).encode()
    headers={'Authorization':'Bearer '+key,'Content-Type':'application/octet-stream' if raw is not None else 'application/json'}
    if path=='/v1/keys' and method=='POST':headers['X-RedX-Confirm']='createKey'
    if path.endswith('/revoke'):headers['X-RedX-Confirm']='revokeKey'
    request=urllib.request.Request(API+path,data=body,method=method,headers=headers)
    try:
        with urllib.request.build_opener(NoRedirect()).open(request,timeout=20) as response:
            if response.geturl()!=API+path:raise RuntimeError("Administration origin changed")
            data=response.read(2*1024*1024+1)
            if len(data)>2*1024*1024:raise RuntimeError('Administration response exceeded its limit')
            return response.status,data
    except urllib.error.HTTPError as error:
        status=error.code;error.close();return status,b''

def create_scoped(admin,db,prefix,name,destination):
    if destination.exists() or destination.is_symlink():raise RuntimeError('An existing service key must be reviewed, not overwritten')
    status,data=api(admin,'POST','/v1/keys',{'db':db,'scope':'write','prefix':prefix,'label':name})
    if status not in (200,201):raise RuntimeError('Scoped service key creation was refused')
    value=json.loads(data);secret=value.get('key');identifier=value.get('id')
    if not isinstance(secret,str) or not re.fullmatch(r'rx_live_[A-Za-z0-9]{43}',secret) or not isinstance(identifier,str):raise RuntimeError('Invalid scoped key response')
    account=pwd.getpwnam('redxai')
    fd=os.open(destination,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o400)
    with os.fdopen(fd,'w') as stream:stream.write(secret+'\n');stream.flush();os.fsync(stream.fileno())
    os.chown(destination,account.pw_uid,account.pw_gid)
    return {'id':identifier,'db':db,'scope':'write','prefix':prefix,'file':str(destination)},secret

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--apply',action='store_true');args=parser.parse_args()
    if not args.apply:
        print(json.dumps({'mode':'plan','userDB':USER_DB,'userFile':'gdg-user.red-xai.db','mediaDB':MEDIA_DB,'masterPack':'red-xai-db','loginRecordsModified':False}));return
    if os.getuid()!=0:raise RuntimeError('Authorized server operator privileges required')
    os.umask(0o077)
    if BASE.is_symlink() or not BASE.is_dir():raise RuntimeError('Unsafe configuration directory')
    if RECEIPT.exists():
        value=json.loads(RECEIPT.read_text());print(json.dumps({'mode':'already-provisioned','userDB':value['userDB'],'mediaDB':value['mediaDB'],'masterPack':value['masterPack']}));return
    for name in ('gendragoon-gdg-user.key','gendragoon-gdg-media.key','gendragoon-gdg.env'):
        if (BASE/name).exists():raise RuntimeError('Partial prior setup exists; review it before continuing')
    # Owner-authorized, documented CLI workflow. Execute as the existing RedX
    # service user so key-store ownership/atomic file permissions are preserved.
    result=subprocess.run(['/usr/sbin/runuser','-u','redx','--','/opt/redx/bin/redx','key','create','--offline','--data-dir','/opt/redx/var/data','--scope','admin','--db','*','--ttl','10m','--label','GenDragoon setup temporary','--json'],capture_output=True,text=True,timeout=20)
    if result.returncode:raise RuntimeError('The existing RedX administration CLI refused provisioning')
    bootstrap=json.loads(result.stdout);admin=bootstrap['key'];temporary_id=bootstrap['id']
    receipt={'schema':1,'createdMs':int(time.time()*1000),'userDB':USER_DB,'mediaDB':MEDIA_DB,'masterPack':'red-xai-db','keys':[]}
    try:
        status,_=api(admin,'POST','/v1/dbs',{'name':MEDIA_DB})
        if status not in (200,201,409):raise RuntimeError('The master media database could not be created')
        location='/v1/db/'+MEDIA_DB+'/pack/red-xai-db/file/container.json'
        status,data=api(admin,'GET',location)
        if status==404:
            marker={'schema':1,'application':'GenDragoon','container':'red-xai-db','layout':'accounts/{receiverId}/workspaces/{workspaceId}','userDatabase':USER_DB}
            status,_=api(admin,'PUT',location,raw=json.dumps(marker,separators=(',',':')).encode())
            if status not in (200,201):raise RuntimeError('Master pack initialization failed')
        elif status!=200 or json.loads(data).get('application')!='GenDragoon':raise RuntimeError('An existing master pack must be reviewed')
        user_info,user_key=create_scoped(admin,USER_DB,'gdg-user.red-xai.db','GenDragoon GDGSigned GDGWS only',BASE/'gendragoon-gdg-user.key');receipt['keys'].append(user_info)
        media_info,media_key=create_scoped(admin,MEDIA_DB,'red-xai-db.red-xai-pack:accounts','GenDragoon workspace media only',BASE/'gendragoon-gdg-media.key');receipt['keys'].append(media_info)
        # A service grant must not expose the existing login records or pack root.
        status,_=api(user_key,'GET','/v1/db/'+USER_DB+'/path/'+urllib.parse.quote('acct-account.red-xai-db-qs-ls:Record[ID=1]',safe=''))
        if status not in (401,403):raise RuntimeError('User extension grant did not enforce its required prefix')
        status,_=api(media_key,'GET',location)
        if status not in (401,403):raise RuntimeError('Media grant unexpectedly reached the master container root')
        config='GENDRAGOON_USER_DB='+USER_DB+'\nGENDRAGOON_USER_DB_KEY_FILE='+str(BASE/'gendragoon-gdg-user.key')+'\nGENDRAGOON_MEDIA_DB='+MEDIA_DB+'\nGENDRAGOON_MEDIA_KEY_FILE='+str(BASE/'gendragoon-gdg-media.key')+'\n'
        (BASE/'gendragoon-gdg.env').write_text(config);(BASE/'gendragoon-gdg.env').chmod(0o600)
        RECEIPT.write_text(json.dumps(receipt,indent=2)+'\n');RECEIPT.chmod(0o600)
        print(json.dumps({'mode':'provisioned','userDB':USER_DB,'mediaDB':MEDIA_DB,'masterPack':'red-xai-db','restrictedKeys':len(receipt['keys']),'loginRecordsModified':False,'productionServiceChanged':False}))
    finally:
        status,_=api(admin,'POST','/v1/keys/'+urllib.parse.quote(str(temporary_id),safe='')+'/revoke',{})
        print(json.dumps({'temporaryProvisioningKeyRevoked':status in (200,204)}))

if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'error':type(error).__name__,'message':'GenDragoon setup stopped safely. No credentials are logged; review partial configuration on the server.'}))
        raise SystemExit(1)
