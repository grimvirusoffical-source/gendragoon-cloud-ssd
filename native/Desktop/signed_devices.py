"""Windows/Linux signing, using existing account auth and the unchanged vault codec.

The local device credential is encrypted with Red-SecretsXAI, never saved as JSON
plaintext. The visible Red-X receipt does not contain the credential.
"""
import base64
import hashlib
import json
from pathlib import Path
import platform
import re
import private_fs
import gendragoon_signed_device as identity
import gendragoon_redx_storage as crypto

ID=re.compile(r'[a-f0-9]{32}\Z')
TOKEN=re.compile(r'[A-Za-z0-9_-]{43}\Z')

class SignedDevices:
    def __init__(self,model):self.model=model
    def context(self):
        model=self.model
        if model.session.integration_mode:raise ValueError('Sign in with your account; API keys cannot manage device registrations.')
        config=model.config()
        return config,config['receiverId'],config['workspaceId']
    @staticmethod
    def route(workspace):
        if not ID.fullmatch(workspace or ''):raise ValueError('Choose an owned MachineNote first.')
        return '/v1/receivers/me/workspaces/'+workspace+'/devices'
    def file(self,owner,workspace):
        return private_fs.private_directory(self.model.root/'SignedDevices'/owner)/(workspace+'.png')
    def _client(self,config):
        from machinenotes_client import DesktopReceiver
        return DesktopReceiver(config)
    def local(self,config,owner,workspace):
        path=self.file(owner,workspace)
        if not path.exists():return None
        info=private_fs.verify(path)
        if info.st_nlink!=1 or info.st_size>1024*1024:raise ValueError('Invalid private device registration.')
        with crypto.Codec(self._client(config)) as codec:
            raw=codec.open(path.read_bytes(),crypto.object_id('signed-device-local',owner,workspace))
        value=json.loads(raw)
        if set(value)!={'id','credential'} or not ID.fullmatch(value['id']) or not TOKEN.fullmatch(value['credential']):raise ValueError('Invalid encrypted device registration.')
        return value
    def headers(self):
        config,owner,workspace=self.context();value=self.local(config,owner,workspace)
        return {} if not value else {'x-gendragoon-device-id':value['id'],'x-gendragoon-device-token':value['credential']}
    def list(self):
        config,owner,workspace=self.context()
        result=self.model.session.request(self.route(workspace))
        if self.model.session.receiver!=owner or self.model.selected_note!=workspace:raise ValueError('The account or workspace changed.')
        rows=result.get('devices')
        if result.get('workspace')!=workspace or not isinstance(rows,list) or len(rows)>20:raise ValueError('Invalid device list.')
        for row in rows:
            if not isinstance(row,dict) or not ID.fullmatch(row.get('id','')) or not isinstance(row.get('name'),str) or len(row['name'])>80:raise ValueError('Invalid device entry.')
        local=self.local(config,owner,workspace)
        if local and not any(row['id']==local['id'] for row in rows):
            path=self.file(owner,workspace);private_fs.verify(path);path.unlink();local=None
        return {'workspace':workspace,'devices':rows,'local':local['id'] if local else None}
    def sign(self):
        config,owner,workspace=self.context();existing=self.list()
        if existing['local']:return existing
        prepared=identity.prepare_receipt(config)
        result=self.model.session.request(self.route(workspace),'POST',{
            'name':(platform.node() or 'This computer')[:80],'platform':prepared['platform'],
            'deviceFingerprint':prepared['deviceFingerprint'],'qr':prepared['qr']})
        if self.model.session.receiver!=owner or self.model.selected_note!=workspace:raise ValueError('The account or workspace changed; review the server registration.')
        device=result.get('device',{});secret=result.get('credential','')
        if result.get('workspace')!=workspace or not ID.fullmatch(device.get('id','')) or not TOKEN.fullmatch(secret):raise ValueError('Invalid device registration response.')
        try:
            plain=json.dumps({'id':device['id'],'credential':secret},separators=(',',':')).encode()
            with crypto.Codec(self._client(config)) as codec:sealed=codec.seal(plain,crypto.object_id('signed-device-local',owner,workspace))
            private_fs.write_private(self.file(owner,workspace),sealed,replace=True)
        except Exception:
            self.model.session.request(self.route(workspace)+'/'+device['id'],'DELETE')
            raise
        return self.list()
    def unsign(self,device):
        config,owner,workspace=self.context()
        if not ID.fullmatch(device or ''):raise ValueError('Select a registered device.')
        result=self.model.session.request(self.route(workspace)+'/'+device,'DELETE')
        if self.model.session.receiver!=owner or self.model.selected_note!=workspace:raise ValueError('The account changed.')
        local=self.local(config,owner,workspace)
        if local and local['id']==device:
            path=self.file(owner,workspace);private_fs.verify(path);path.unlink()
        return result
    def image(self,device):
        _,owner,workspace=self.context()
        if not ID.fullmatch(device or ''):raise ValueError('Select a registered device.')
        result=self.model.session.request(self.route(workspace)+'/'+device+'/qr')
        if self.model.session.receiver!=owner or self.model.selected_note!=workspace:raise ValueError('The account changed.')
        if result.get('id')!=device or result.get('workspace')!=workspace or result.get('format')!='redsecretsxai-visual-v3':raise ValueError('Invalid receipt response.')
        encoded=result.get('png','')
        if not isinstance(encoded,str) or len(encoded)>175000:raise ValueError('Receipt is too large.')
        raw=base64.b64decode(encoded,validate=True)
        if len(raw)>131072 or raw[:8]!=b'\x89PNG\r\n\x1a\n' or hashlib.sha256(raw).hexdigest()!=result.get('sha256'):raise ValueError('Receipt verification failed.')
        return raw
