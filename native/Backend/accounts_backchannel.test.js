"use strict";
// Back-channel client. HTTP stubs only.
const test=require("node:test");
const assert=require("node:assert/strict");
const {backchannelFromEnv}=require("./accounts/backchannel");

test("back-channel: off without a secret; Basic auth as gendragoon-backend; status and event pages",async()=>{
 assert.equal(backchannelFromEnv({REDXAI_ISSUER:"https://accounts.test"}),null);
 const calls=[];
 const fetchImpl=async(url,init)=>{
  calls.push({url,auth:init.headers.authorization});
  if(url.includes("/status"))return {ok:true,status:200,json:async()=>({active:false,status:"banned",until:0,reason:"spam"})};
  if(url.includes("/events"))return {ok:true,status:200,json:async()=>({events:[{seq:42,type:"account.deleted",account:"rxa_X"}],next:42,hasMore:false})};
  return {ok:false,status:404,json:async()=>({error:"not_found"})};
 };
 const b=backchannelFromEnv({REDXAI_ISSUER:"https://accounts.test/",REDXAI_BACKEND_CLIENT_SECRET:"stub-secret"},{fetchImpl});
 assert.equal(b.clientId,"gendragoon-backend");
 assert.deepEqual(await b.status("rxa_X"),{active:false,status:"banned",until:0,reason:"spam"});
 assert.deepEqual(await b.events(41,9999),{events:[{seq:42,type:"account.deleted",account:"rxa_X"}],next:42,hasMore:false});
 assert.equal(calls[0].url,"https://accounts.test/v1/apps/accounts/rxa_X/status");
 assert.equal(calls[1].url,"https://accounts.test/v1/apps/events?since=41&limit=500");
 assert.equal(calls[0].auth,"Basic "+Buffer.from("gendragoon-backend:stub-secret").toString("base64"));
 const denied=backchannelFromEnv({REDXAI_ISSUER:"https://accounts.test",REDXAI_BACKEND_CLIENT_SECRET:"x"},{fetchImpl:async()=>({ok:false,status:401,json:async()=>({error:"invalid_client"})})});
 await assert.rejects(denied.status("a"),{code:"invalid_client",status:401});
});
