'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {spawn} = require('node:child_process');
const crypto = require('node:crypto');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function port() {const s = net.createServer(); await new Promise(r => s.listen(0,'127.0.0.1',r)); const p=s.address().port; await new Promise(r=>s.close(r)); return p;}
async function request(url, method='GET', body, token, headers={}) {
 const h={...headers}; if(token)h.authorization='Bearer '+token;
 if(body!==undefined && !Buffer.isBuffer(body))h['content-type']='application/json';
 const r=await fetch(url,{method,headers:h,redirect:'manual',body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)});
 const data=Buffer.from(await r.arrayBuffer());
 let json;try{json=JSON.parse(data);}catch{json=null;}
 return {status:r.status,body:json,bytes:data,headers:r.headers};
}
async function startStack() {
 const base=process.env.REDX_INTEGRATION_ROOT;
 if(!base)throw new Error('REDX_INTEGRATION_ROOT must point to reviewed source checkouts and built tools');
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'redx-real-stack-')));
 const processes=[]; const logs=new Map();
 function child(binary,args,extra={}) {
  const p=spawn(binary,args,{env:{...process.env,...extra},stdio:['ignore','pipe','pipe']});
  processes.push(p); logs.set(p,'');
  const capture=b=>logs.set(p,(logs.get(p)+b.toString()).slice(-200000));
  p.stdout.on('data',capture);p.stderr.on('data',capture);
  return p;
 }
 async function ready(url,p) {
  for(let i=0;i<150;i++){
   if(p.exitCode!==null)throw new Error('Fixture service exited; inspect locally without exposing credentials');
   try{const r=await fetch(url+'/healthz',{signal:AbortSignal.timeout(800)});if(r.ok)return;}catch{}
   await sleep(100);
  } throw new Error('Fixture startup timed out');
 }
 async function close() {
  for(const p of processes.reverse()) {
   if(p.exitCode!==null)continue;
   p.kill('SIGTERM');
   for(let i=0;i<100 && p.exitCode===null;i++)await sleep(50);
   if(p.exitCode===null)p.kill('SIGKILL');
  }
  await fs.rm(dir,{recursive:true,force:true});
 }
 try {
  const redxPort=await port(),redxURL='http://127.0.0.1:'+redxPort;
  const redx=child(path.join(base,'tools/redxd'),['run','--data-dir',path.join(dir,'redx'),'--listen','127.0.0.1:'+redxPort,'--bootstrap','console','--no-open'],{REDX_ENGINE_DURABILITY:'sync'});
  await ready(redxURL,redx);
  const key=(logs.get(redx).match(/rx_live_[A-Za-z0-9]+/)||[])[0];
  if(!key)throw new Error('Fixture bootstrap key missing');
  for(const db of ['redxai_accounts','gendragoon_receivers']) {
   const r=await request(redxURL+'/v1/dbs','POST',{name:db},key);
   if(r.status!==200 && r.status!==201)throw new Error('Fixture DB creation failed '+r.status);
  }
  async function scoped(db) {
   const r=await request(redxURL+'/v1/keys','POST',{db,scope:'write'},key,{'X-RedX-Confirm':'createKey'});
   if(!r.body?.key)throw new Error('Fixture scoped key creation failed '+r.status);
   return r.body.key;
  }
  const accountsKey=await scoped('redxai_accounts'), receiverKey=await scoped('gendragoon_receivers');
  const authPort=await port(), issuer='http://127.0.0.1:'+authPort;
  const accounts=child(path.join(base,'tools/redxai-accounts'),['--dev','--offline-dns','--store','redx','--listen','127.0.0.1:'+authPort,'--issuer',issuer,'--data-dir',path.join(dir,'keys')],{
   REDXAI_REDX_URL:redxURL,REDXAI_REDX_KEY:accountsKey,REDXAI_REDX_DB:'redxai_accounts',
   REDXAI_GENDRAGOON_TOS_FILE:path.join(base,'gendragoon-cloud-ssd/native/Backend/legal/GENDRAGOON_TOS.md'),
  });
  await ready(issuer,accounts);
  async function account(label) {
   const name='gdtest_'+crypto.randomBytes(5).toString('hex'),pw=crypto.randomBytes(24).toString('hex')+'Aa9!';
   const tos=(await request(issuer+'/v1/tos?app=gendragoon')).body;
   const read=await request(issuer+'/v1/tos/read','POST',{app:'gendragoon',version:tos.version,appVersion:tos.appVersion});
   const grant=(await request(issuer+'/v1/tos/agree','POST',{grant:read.body.grant})).body.grant;
   const result=await request(issuer+'/v1/signup','POST',{app:'gendragoon',username:name,password:pw,passwordConfirm:pw,email:name+'@red-xai.test',emailConfirm:name+'@red-xai.test',dob:'07/04/2001',tosGrant:grant,twoFactor:'none',acceptNo2faRisk:true,acknowledgeFalseInfo:true});
   if(result.status!==201)throw new Error('Fixture signup failed: '+JSON.stringify(result.body));
   for(let i=0;i<40;i++){if(/verify-email[#?]token=/.test(logs.get(accounts)))break;await sleep(50);}
   const tokens=[...logs.get(accounts).matchAll(/verify-email[#?]token=([A-Za-z0-9_-]+)/g)];
   const verification=tokens.at(-1)?.[1];
   if(!verification)throw new Error('Fixture verification email not captured');
   const vr=await request(issuer+'/v1/email/verify','POST',{token:verification});
   if(vr.status!==200)throw new Error('Fixture email verification failed');
   const response=await fetch(issuer+'/oauth2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:red-xai:grant-type:session',client_id:'gendragoon',subject_token:result.body.session,scope:'openid profile email'})});
   const auth=await response.json();
   if(!auth.access_token)throw new Error('Fixture OIDC grant failed');
   return {label,session:result.body.session,...auth,tos:tos.appVersion};
  }
  return {base,dir,redxURL,receiverKey,issuer,account,request,close,processes,logs};
 } catch(e) {await close();throw e;}
}
module.exports={startStack,request};
