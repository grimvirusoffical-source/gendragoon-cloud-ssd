"use strict";
// Contract check against a real Red-XAI Accounts server (v1.1). Skipped unless REDXAI_TEST_ISSUER points at one,
// e.g. `redxai-accounts --dev --store mem --offline-dns --listen 127.0.0.1:18080` (fake SMS and mail; nothing is sent).
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const {createIdentity}=require("./accounts/identity");
const {createOidcVerifier}=require("./accounts/oidc");
const {createBackchannel}=require("./accounts/backchannel");
const ISS=process.env.REDXAI_TEST_ISSUER;

async function call(method,path,body,{form,token}={}){
 const headers={accept:"application/json"};
 if(token)headers.authorization="Bearer "+token;
 if(body)headers["content-type"]=form?"application/x-www-form-urlencoded":"application/json";
 const res=await fetch(ISS+path,{method,headers,body:body?(form?new URLSearchParams(body).toString():JSON.stringify(body)):undefined});
 return {status:res.status,body:await res.json().catch(()=>({}))};
}

test("real Red-XAI Accounts: in-app sign-up, session grant, Gendragoon verifies the access token",{skip:!ISS&&"REDXAI_TEST_ISSUER not set"},async()=>{
 const tos=(await call("GET","/v1/tos?app=gendragoon")).body;
 assert.ok(tos.version&&tos.appVersion,"central and Gendragoon terms");
 const read=await call("POST","/v1/tos/read",{app:"gendragoon",version:tos.version,appVersion:tos.appVersion});
 const agreed=await call("POST","/v1/tos/agree",{grant:read.body.grant});
 const name="gd_live_"+crypto.randomBytes(4).toString("hex");
 const signup=await call("POST","/v1/signup",{app:"gendragoon",username:name,password:"Correct-Horse9!",passwordConfirm:"Correct-Horse9!",
  email:name+"@gendragoon-test.dev",emailConfirm:name+"@gendragoon-test.dev",dob:"07/04/2001",tosGrant:agreed.body.grant,twoFactor:"none",acceptNo2faRisk:true,acknowledgeFalseInfo:true});
 assert.equal(signup.status,201,JSON.stringify(signup.body));
 const grant={grant_type:"urn:red-xai:grant-type:session",client_id:"gendragoon",subject_token:signup.body.session,scope:"openid profile email"};
 const tokens=await call("POST","/oauth2/token",grant,{form:true});
 assert.equal(tokens.status,200,JSON.stringify(tokens.body));
 assert.match(tokens.body.refresh_token,/^rxa_r_/);
 assert.equal((await call("POST","/oauth2/token",grant,{form:true})).body.error,"invalid_grant","the session grant is single use");

 const identity=createIdentity({firebaseVerify:async()=>{throw Error("unused");},store:null,issuer:ISS,audience:["gendragoon"]});
 const id=await identity.identify(tokens.body.access_token);
 assert.equal(id.provider,"redxai");assert.equal(id.username,name);assert.equal(id.ageBand,"18plus");
 assert.equal(id.appTosVersion,tos.appVersion);assert.deepEqual(id.amr,["pwd"]);
 assert.equal(id.uid,"rxa:"+id.sub);
 await assert.rejects(identity.identify(tokens.body.id_token),"an ID token is not an access token");
 await assert.rejects(createOidcVerifier({issuer:ISS,audience:"gendragoon-backend",typ:"at+jwt"}).verify(tokens.body.access_token),{code:"token_audience"});

 const wrong=createBackchannel({issuer:ISS,clientSecret:"not-the-secret"});
 await assert.rejects(wrong.status(id.sub),e=>e.status===401,"back-channel needs the gendragoon-backend secret");
});
