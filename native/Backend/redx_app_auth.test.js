'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createRedXAppAuth,hybridAuth}=require('./redx_app_auth');

function response(){
 return {
  statusCode:200,body:null,headers:{},
  status(code){this.statusCode=code;return this;},
  json(value){this.body=value;return this;},
  setHeader(k,v){this.headers[k]=v;}
 };
}
function invoke(mw,req){
 return new Promise(resolve=>{
   const res=response();
   mw(req,res,arg=>resolve({next:true,arg,req,res}));
   setTimeout(()=>{if(res.body!==null)resolve({next:false,req,res});},10);
 });
}
test('opaque Red-XAI app token maps through the existing identity link and decorates billing identity',async()=>{
 let seenURL='',decorated=0;
 const accounts={store:{resolveLink:async(issuer,sub)=>{assert.equal(issuer,'https://red-xai.com');assert.equal(sub,'2611833723633093');return 'firebase-linked-uid';}}};
 const mw=createRedXAppAuth({accounts,fetchImpl:async(url,opts)=>{
   seenURL=url;assert.equal(opts.redirect,'error');assert.match(opts.headers.authorization,/^Bearer rxca_/);
   return new Response(JSON.stringify({protocol:'redx-site-session-v1',client_id:'gendragoon',scope:'gendragoon.receiver',
     sub:'2611833723633093',email:'support@infected-nation.com',email_verified:true,username:'owner'}),{status:200,headers:{'content-type':'application/json'}});
 },decorate:async(req,user)=>{decorated++;req.decorated=user.uid;}});
 const req={headers:{authorization:'Bearer rxca_'+'A'.repeat(43)}};
 const result=await invoke(mw,req);
 assert.equal(result.next,true);assert.equal(req.user.uid,'firebase-linked-uid');assert.equal(req.user.email,'support@infected-nation.com');
 assert.equal(req.user.__identity.provider,'redxai');assert.equal(req.authKind,'redx-app');assert.equal(req.decorated,'firebase-linked-uid');
 assert.equal(decorated,1);assert.equal(seenURL,'https://red-xai.com/redxai-connect/userinfo');
});
test('unlinked Red-XAI subject receives a stable rxa: identity and never trusts unverified email',async()=>{
 const accounts={store:{resolveLink:async()=>null}};
 const good=createRedXAppAuth({accounts,fetchImpl:async()=>new Response(JSON.stringify({protocol:'redx-site-session-v1',client_id:'gendragoon',
   scope:'gendragoon.receiver',sub:'account-123',email:'user@example.com',email_verified:true}),{status:200})});
 const req={headers:{authorization:'Bearer rxca_'+'B'.repeat(43)}};const ok=await invoke(good,req);
 assert.equal(ok.next,true);assert.equal(req.user.uid,'rxa:account-123');
 const bad=createRedXAppAuth({accounts,fetchImpl:async()=>new Response(JSON.stringify({protocol:'redx-site-session-v1',client_id:'gendragoon',
   scope:'gendragoon.receiver',sub:'account-123',email:'support@infected-nation.com',email_verified:false}),{status:200})});
 const rejected=await invoke(bad,{headers:{authorization:'Bearer rxca_'+'C'.repeat(43)}});
 assert.equal(rejected.next,false);assert.equal(rejected.res.statusCode,403);
});
test('invalid or expired app tokens fail closed and non-rxca tokens fall through to the existing auth provider',async()=>{
 const accounts={store:{resolveLink:async()=>null}};
 const mw=createRedXAppAuth({accounts,fetchImpl:async()=>new Response('{}',{status:401})});
 let r=await invoke(mw,{headers:{authorization:'Bearer rxca_'+'D'.repeat(43)}});assert.equal(r.res.statusCode,401);
 let fallback=0;
 const hybrid=hybridAuth({redx:mw,fallback:(req,res,next)=>{fallback++;req.user={uid:'firebase'};next();}});
 r=await invoke(hybrid,{headers:{authorization:'Bearer firebase-token'}});assert.equal(r.next,true);assert.equal(fallback,1);assert.equal(r.req.user.uid,'firebase');
});
