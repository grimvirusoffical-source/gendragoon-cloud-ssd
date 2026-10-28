"""Pinned-origin Red-XAI approval with memory-only credentials and single-flight renewal."""
import base64
import hashlib
import json
import re
import secrets
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ISSUER="https://red-xai.com"
API="https://api.red-xai.com"
ACCESS=re.compile(r"rxca_[A-Za-z0-9_-]{43}\Z")
REFRESH=re.compile(r"rxcr_[A-Za-z0-9_-]{43}\Z")
API_KEY=re.compile(r"gdpk_[a-f0-9]{16}_[A-Za-z0-9_-]{43}\Z")

class SessionError(RuntimeError):
    def __init__(self,message,status=0):super().__init__(message);self.status=status

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise SessionError("Authenticated redirects are not allowed.")

def opener():
    context=ssl.create_default_context();context.minimum_version=ssl.TLSVersion.TLSv1_2
    return urllib.request.build_opener(NoRedirect(),urllib.request.HTTPSHandler(context=context))

def receiver_id(subject):
    return hashlib.sha256(json.dumps(["red-xai-receiver/v1",ISSUER,subject],ensure_ascii=False,separators=(",",":")).encode()).hexdigest()

def http_json(origin,path,method="GET",value=None,token=None,transport=None):
    if origin not in (ISSUER,API) or not path.startswith("/") or any(c in path for c in ("\\","#","\r","\n")) or ".." in path:
        raise SessionError("The service path is unsafe.")
    raw=None if value is None else json.dumps(value,separators=(",",":")).encode()
    if raw and len(raw)>1024*1024:raise SessionError("The request is too large.")
    headers={"Accept":"application/json","Accept-Encoding":"identity","User-Agent":"GenDragoon-Desktop/1"}
    if raw is not None:headers["Content-Type"]="application/json"
    if token is not None:headers["Authorization"]="Bearer "+token
    req=urllib.request.Request(origin+path,data=raw,method=method,headers=headers)
    try:
        with (transport or opener()).open(req,timeout=45) as response:
            if response.geturl()!=origin+path:raise SessionError("Authenticated redirects are not allowed.")
            data=response.read(4*1024*1024+1)
            if len(data)>4*1024*1024:raise SessionError("The service response is too large.")
    except urllib.error.HTTPError as error:
        status=error.code;error.close()
        raise SessionError({401:"The account session expired or was revoked.",403:"This account does not have permission for that action.",409:"The item changed or its name is already in use. Refresh and try again.",429:"The service is busy. Wait briefly and retry."}.get(status,"The service rejected this request (HTTP %d)."%status),status) from None
    except (OSError,urllib.error.URLError):raise SessionError("The Red-XAI service is temporarily unreachable.") from None
    try:result=json.loads(data)
    except Exception:raise SessionError("The service returned invalid JSON.") from None
    if not isinstance(result,dict):raise SessionError("The service returned invalid JSON.")
    return result

class RedXSession:
    def __init__(self):
        self._lock=threading.RLock();self._access=None;self._refresh=None;self._expires=0
        self.subject=None;self.receiver=None;self.email=None;self.generation=0
    @property
    def integration_mode(self):return False
    def _apply(self,value,expected=None):
        user=value.get("user")
        if (not isinstance(user,dict) or not isinstance(user.get("sub"),str) or not user["sub"] or user.get("email_verified") is not True
                or not ACCESS.fullmatch(value.get("access_token", "")) or not REFRESH.fullmatch(value.get("refresh_token", ""))
                or type(value.get("expires_in")) is not int or not 1<=value["expires_in"]<=3600
                or expected is not None and user["sub"]!=expected):
            raise SessionError("The approved account session failed validation.")
        self._access=value["access_token"];self._refresh=value["refresh_token"];self._expires=time.monotonic()+value["expires_in"]
        self.subject=user["sub"];self.receiver=receiver_id(self.subject);self.email=user.get("email");self.generation+=1
    def login(self,approved,open_browser,cancelled=lambda:False):
        verifier=secrets.token_urlsafe(32)
        challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        job=http_json(ISSUER,"/redxai-connect/start","POST",{"client_id":"gendragoon","code_challenge":challenge,"code_challenge_method":"S256"})
        url=urllib.parse.urlsplit(job.get("verification_uri", ""))
        if (url.scheme!="https" or url.netloc!="red-xai.com" or url.path not in ("/redxai-connect","/redxai-connect/","/redxai-connectx")
                or url.fragment or not re.fullmatch(r"[A-Za-z0-9_-]{43}",job.get("device_code", ""))
                or not re.fullmatch(r"[A-Za-z0-9]{8}",job.get("user_code", ""))):
            raise SessionError("The approval request failed validation.")
        approved(job["user_code"]);open_browser(job["verification_uri"])
        deadline=time.monotonic()+min(300,max(1,job.get("expires_in",300)))
        delay=min(10,max(2,job.get("interval",3)))
        while time.monotonic()<deadline and not cancelled():
            time.sleep(delay)
            try:value=http_json(ISSUER,"/redxai-connect/token","POST",{"client_id":"gendragoon","device_code":job["device_code"],"code_verifier":verifier})
            except SessionError as error:
                if error.status==428:continue
                if error.status==429:delay=min(10,delay+1);continue
                raise
            with self._lock:
                self._apply(value)
                result=http_json(API,"/v1/receivers/me","PUT",token=self._access)
                if result.get("id")!=self.receiver or result.get("state")!="ready":
                    self.logout();raise SessionError("The approved Receiver identity did not match this account.")
                return result
        raise SessionError("Red-XAI approval was cancelled or expired.")
    def token(self):
        with self._lock:
            if not self._access:raise SessionError("Connect Red-XAI first.",401)
            if self._expires-time.monotonic()<30:self._renew_locked()
            return self._access
    def _renew_locked(self):
        expected=self.subject
        if not self._refresh:raise SessionError("Connect Red-XAI again.",401)
        value=http_json(ISSUER,"/redxai-connect/refresh","POST",{"client_id":"gendragoon","refresh_token":self._refresh})
        self._apply(value,expected)
    def renew(self,failed_token):
        with self._lock:
            if not self._access:raise SessionError("Connect Red-XAI again.",401)
            if self._access==failed_token:self._renew_locked()
            return self._access
    def request(self,path,method="GET",value=None):
        if not path.startswith(("/v1/receivers/","/v1/integrations","/provider/v1/","/gendragoon/v2/")):
            raise SessionError("Unsupported account service path.")
        expected=self.receiver;token=self.token()
        try:result=http_json(API,path,method,value,token)
        except SessionError as error:
            if error.status!=401:raise
            result=http_json(API,path,method,value,self.renew(token))
        if expected!=self.receiver:raise SessionError("The connected account changed.",401)
        return result
    def logout(self):
        with self._lock:
            self._access=None;self._refresh=None;self._expires=0;self.subject=None;self.receiver=None;self.email=None;self.generation+=1

class IntegrationSession:
    def __init__(self,key):
        if not isinstance(key,str) or not API_KEY.fullmatch(key):raise SessionError("Enter a scoped GenDragoon integration key.")
        self._key=key;self.receiver=None;self.workspace=None;self.generation=0
    @property
    def integration_mode(self):return True
    def token(self):return self._key
    def request(self,path,method="GET",value=None):
        if path!="/v1/receivers/me" and not path.startswith(("/v1/receivers/me/workspaces/","/v1/receivers/me/library/")):
            raise SessionError("Integration keys can only access their bound MachineNote files.",403)
        return http_json(API,path,method,value,self._key)
    def logout(self):self._key="";self.receiver=None;self.workspace=None;self.generation+=1
