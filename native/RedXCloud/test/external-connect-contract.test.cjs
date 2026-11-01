'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {spawn}=require('node:child_process');
const crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {createIntegrations}=require('../integrations.cjs');
const {digest}=require('../redx-state.cjs');

test('unchanged pinned RottenApple Go client exchanges S256 and self-revokes against GenDragoon',{skip:!process.env.GENDRAGOON_ROTTENAPPLE_SOURCE,timeout:90000},async t=>{
 const original=await fs.readFile(path.join(process.env.GENDRAGOON_ROTTENAPPLE_SOURCE,'connect/client.go'));
 const expected=process.env.GENDRAGOON_ROTTENAPPLE_CLIENT_BLOB;assert(expected,'Supply reviewed pinned original blob SHA');assert.equal(crypto.createHash('sha1').update('blob '+original.length+'\0').update(original).digest('hex'),expected);
 const issuer='https://accounts.fixture',subject='original-client-fixture',actor={issuer,subject,owner:digest(JSON.stringify(['red-xai-receiver/v1',issuer,subject]))},workspace='a'.repeat(32);
 const accounts=new Map(),lookup=new Map(),grants=new Map();
 const metadata={account:async id=>structuredClone(accounts.get(id)||{keys:{},byo:{}}),update:async(id,fn)=>{const v=structuredClone(accounts.get(id)||{keys:{},byo:{}});fn(v);accounts.set(id,v);return v;},linkKey:async(id,owner)=>lookup.set(id,owner),ownerForKey:async id=>lookup.get(id),createGrant:async(id,v)=>grants.set(id,structuredClone(v)),grant:async id=>structuredClone(grants.get(id)),consumeGrant:async(id,verify,at)=>{const g=grants.get(id);if(!g||g.usedAtMs!==null||g.expiresAtMs<=at||!verify(g))throw Object.assign(Error('invalid_grant'),{status:400});g.usedAtMs=at;return structuredClone(g);}};
 const api=createIntegrations({metadata,authorizeWorkspace:async()=>({id:workspace,active:true,readOnly:false,quotaBytes:100000,workers:1,checkedAtMs:Date.now()})});
 const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://127.0.0.1');const result=api.matchesPublic(u.pathname)?await api.handlePublic(req,u):await api.handle(req,u,await api.authenticateAPIKey(req,u.pathname));res.writeHead(result.status,{'content-type':'application/json'});res.end(JSON.stringify(result.body));}catch(error){res.writeHead(error.status||500,{'content-type':'application/json'});res.end(JSON.stringify({code:'safe_fixture_failure',error:'request refused'}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port,verifier=crypto.randomBytes(48).toString('base64url'),state=crypto.randomBytes(32).toString('base64url');
 const request=Readable.from([Buffer.from(JSON.stringify({name:'RottenApple',service:'rottenapple-store',workspaceId:workspace,scopes:['files:read','files:write'],codeChallengeMethod:'S256',codeChallenge:crypto.createHash('sha256').update(verifier).digest('base64url'),state}))]);request.method='POST';request.headers={};
 const issued=await api.handle(request,new URL('http://fixture/provider/v1/connect/authorize'),actor);
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'gd-unchanged-client-')));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 await fs.writeFile(path.join(directory,'go.mod'),'module fixture\n\ngo 1.22\n');await fs.mkdir(path.join(directory,'connect'));await fs.writeFile(path.join(directory,'connect/client.go'),original);
 await fs.writeFile(path.join(directory,'connect/client_contract_test.go'),`package connect
import("context";"os";"strings";"testing";"net/http")
func TestActualGenDragoon(t *testing.T){
 c:=&Client{}; base:=os.Getenv("GD_FIXTURE_BASE"); in:=ExchangeIn{Code:os.Getenv("GD_FIXTURE_CODE"),PKCEVerifier:os.Getenv("GD_FIXTURE_VERIFIER"),State:os.Getenv("GD_FIXTURE_STATE")}
 out,err:=c.Exchange(context.Background(),base,"",in); if err!=nil{t.Fatal("actual client exchange failed")}; if !strings.HasPrefix(out.Key,"gdpk_")||out.Workspace.DB!="${workspace}"||out.Scope!="write"||out.Endpoints["revoke"]!="/v1/connect/revoke"{t.Fatal("wrong scoped client response")}
 if _,err=c.Exchange(context.Background(),base,"",in);err==nil{t.Fatal("code replay accepted")}
 revoked,err:=c.Revoke(context.Background(),base,"",out.Endpoints["revoke"],out.Key);if err!=nil||!revoked.Revoked||revoked.KeyID!=out.KeyID{t.Fatal("actual client revoke failed")}
 req,_:=http.NewRequest("GET",base+"/provider/v1/health",nil);req.Header.Set("Authorization","Bearer "+out.Key);response,err:=http.DefaultClient.Do(req);if err!=nil{t.Fatal("health failed")};defer response.Body.Close();if response.StatusCode!=401{t.Fatal("revoked key accepted")}
}
`);
 await new Promise((resolve,reject)=>{const child=spawn('go',['test','./connect'],{cwd:directory,env:{...process.env,GD_FIXTURE_BASE:base,GD_FIXTURE_CODE:issued.body.code,GD_FIXTURE_VERIFIER:verifier,GD_FIXTURE_STATE:state},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',reject);child.on('close',code=>{assert(!output.includes(issued.body.code));code===0?resolve():reject(Error('Pinned original client contract failed; inspect generated fixture locally. '+output.slice(-1000)));});});
});
