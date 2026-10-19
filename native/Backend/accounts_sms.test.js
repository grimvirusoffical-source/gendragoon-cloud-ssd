"use strict";
// Twilio SMS provider. Every request goes to an in-process stub (fetchImpl); nothing here can reach Twilio or send a text.
const test=require("node:test");
const assert=require("node:assert/strict");
const {TwilioSmsProvider,MockSmsProvider,smsProviderFromEnv,smsConfigProblem,twilioConfigFromEnv}=require("./accounts/sms");
const {accountsStartup}=require("./accounts");

const AC="AC"+"0".repeat(31)+"1",SK="SK"+"a".repeat(32),MG="MG"+"b".repeat(32);
const TOKEN="test-auth-token-not-real",KEY_SECRET="test-key-secret-not-real";
const SEAL=Buffer.alloc(32,7).toString("base64");

function stub(responses){
 const calls=[];
 const fetchImpl=async(url,init)=>{
  calls.push({url,init,form:new URLSearchParams(init.body)});
  const next=responses.length>1?responses.shift():responses[0];
  if(next instanceof Error)throw next;
  return {ok:next.status>=200&&next.status<300,status:next.status,json:async()=>{if(next.body===undefined)throw Error("no json");return next.body;}};
 };
 return {calls,fetchImpl};
}
const basic=(u,p)=>"Basic "+Buffer.from(u+":"+p).toString("base64");

test("Twilio config: auth token or API key, Messaging Service or From number, nothing else",()=>{
 assert.equal(smsProviderFromEnv({}),null,"nothing configured: phone stays unavailable");
 assert.equal(smsConfigProblem({}),null,"not configuring Twilio is not a problem");
 const tokenFrom=twilioConfigFromEnv({TWILIO_ACCOUNT_SID:AC,TWILIO_AUTH_TOKEN:TOKEN,TWILIO_FROM_NUMBER:"+1 (505) 555-0100"}).config;
 assert.deepEqual(tokenFrom,{accountSid:AC,username:AC,password:TOKEN,from:"+15055550100",messagingServiceSid:null});
 const keyService=twilioConfigFromEnv({TWILIO_ACCOUNT_SID:AC,TWILIO_API_KEY_SID:SK,TWILIO_API_KEY_SECRET:KEY_SECRET,TWILIO_MESSAGING_SERVICE_SID:MG,TWILIO_FROM_NUMBER:"+15055550100"}).config;
 assert.equal(keyService.username,SK);assert.equal(keyService.messagingServiceSid,MG);assert.equal(keyService.from,null,"Messaging Service wins over From");
 const bad=[
  [{TWILIO_ACCOUNT_SID:"nope",TWILIO_AUTH_TOKEN:TOKEN,TWILIO_FROM_NUMBER:"+15055550100"},"TWILIO_ACCOUNT_SID"],
  [{TWILIO_ACCOUNT_SID:AC,TWILIO_FROM_NUMBER:"+15055550100"},"TWILIO_AUTH_TOKEN"],
  [{TWILIO_ACCOUNT_SID:AC,TWILIO_API_KEY_SID:SK,TWILIO_FROM_NUMBER:"+15055550100"},"TWILIO_API_KEY_SECRET"],
  [{TWILIO_ACCOUNT_SID:AC,TWILIO_API_KEY_SID:"SKshort",TWILIO_API_KEY_SECRET:KEY_SECRET,TWILIO_FROM_NUMBER:"+15055550100"},"TWILIO_API_KEY_SID"],
  [{TWILIO_ACCOUNT_SID:AC,TWILIO_AUTH_TOKEN:TOKEN},"TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER"],
  [{TWILIO_ACCOUNT_SID:AC,TWILIO_AUTH_TOKEN:TOKEN,TWILIO_FROM_NUMBER:"5055550100"},"TWILIO_FROM_NUMBER"],
  [{TWILIO_ACCOUNT_SID:AC,TWILIO_AUTH_TOKEN:TOKEN,TWILIO_MESSAGING_SERVICE_SID:"MG1"},"TWILIO_MESSAGING_SERVICE_SID"],
  [{SMS_PROVIDER:"twilio"},"TWILIO_ACCOUNT_SID"],
 ];
 for(const [env,name] of bad){
  assert.equal(smsProviderFromEnv({...env,NODE_ENV:"production"}),null,name+": phone stays unavailable");
  const problem=smsConfigProblem(env);
  assert.ok(problem&&problem.includes(name),name+" is named: "+problem);
  assert.ok(!problem.includes(TOKEN)&&!problem.includes(KEY_SECRET),"no secret in the message");
 }
 assert.ok(smsProviderFromEnv({TWILIO_ACCOUNT_SID:AC,TWILIO_AUTH_TOKEN:TOKEN,TWILIO_FROM_NUMBER:"+15055550100",NODE_ENV:"production"}) instanceof TwilioSmsProvider,
  "a complete Twilio setup is allowed in production");
 assert.ok(smsProviderFromEnv({SMS_PROVIDER:"mock",TWILIO_ACCOUNT_SID:AC}) instanceof MockSmsProvider,"SMS_PROVIDER=mock wins for staging");
 assert.equal(smsProviderFromEnv({SMS_PROVIDER:"mock",NODE_ENV:"production"}),null,"mock is still refused in production");
});

test("startup warns (without values) when Twilio is half configured, and never stops the server for it",()=>{
 const g=accountsStartup({NODE_ENV:"production",ACCOUNTS_SEAL_KEY:SEAL,TWILIO_ACCOUNT_SID:AC,TWILIO_AUTH_TOKEN:TOKEN});
 assert.equal(g.exit,false);assert.equal(g.warn,true);
 assert.match(g.message,/TWILIO_FROM_NUMBER/);assert.ok(!g.message.includes(TOKEN));
 assert.deepEqual(accountsStartup({NODE_ENV:"production",ACCOUNTS_SEAL_KEY:SEAL}),{exit:false});
 assert.deepEqual(accountsStartup({NODE_ENV:"production",ACCOUNTS_SEAL_KEY:SEAL,TWILIO_ACCOUNT_SID:AC,TWILIO_AUTH_TOKEN:TOKEN,TWILIO_FROM_NUMBER:"+15055550100"}),{exit:false});
});

test("Twilio send: one form POST to the Messages API with Basic auth, returns the message SID",async()=>{
 const s=stub([{status:201,body:{sid:"SM"+"c".repeat(32),status:"queued"}}]);
 const p=smsProviderFromEnv({TWILIO_ACCOUNT_SID:AC,TWILIO_AUTH_TOKEN:TOKEN,TWILIO_FROM_NUMBER:"+15055550100"},{fetchImpl:s.fetchImpl});
 const r=await p.send({to:"+15551234567",body:"Your Gendragoon code is 123456."});
 assert.equal(r.id,"SM"+"c".repeat(32));
 assert.equal(s.calls.length,1);
 const c=s.calls[0];
 assert.equal(c.url,"https://api.twilio.com/2010-04-01/Accounts/"+AC+"/Messages.json");
 assert.equal(c.init.method,"POST");assert.equal(c.init.redirect,"error");assert.ok(c.init.signal,"has a timeout");
 assert.equal(c.init.headers.Authorization,basic(AC,TOKEN));
 assert.equal(c.init.headers["Content-Type"],"application/x-www-form-urlencoded");
 assert.equal(c.form.get("To"),"+15551234567");assert.equal(c.form.get("From"),"+15055550100");
 assert.equal(c.form.get("Body"),"Your Gendragoon code is 123456.");assert.equal(c.form.get("MessagingServiceSid"),null);
 assert.ok(!JSON.stringify(p).includes(TOKEN),"the credential isn't serialised with the provider");
});

test("Twilio send with an API key and Messaging Service",async()=>{
 const s=stub([{status:201,body:{sid:"SM1"}}]);
 const p=smsProviderFromEnv({TWILIO_ACCOUNT_SID:AC,TWILIO_API_KEY_SID:SK,TWILIO_API_KEY_SECRET:KEY_SECRET,TWILIO_MESSAGING_SERVICE_SID:MG},{fetchImpl:s.fetchImpl});
 await p.send({to:"+447700900123",body:"x"});
 assert.equal(s.calls[0].init.headers.Authorization,basic(SK,KEY_SECRET));
 assert.equal(s.calls[0].form.get("MessagingServiceSid"),MG);assert.equal(s.calls[0].form.get("From"),null);
});

test("Twilio send: E.164 only, and vendor failures map to bad number or retryable send failure",async()=>{
 const env={TWILIO_ACCOUNT_SID:AC,TWILIO_AUTH_TOKEN:TOKEN,TWILIO_FROM_NUMBER:"+15055550100"};
 const none=stub([{status:201,body:{sid:"SM1"}}]);
 const p=smsProviderFromEnv(env,{fetchImpl:none.fetchImpl});
 for(const to of ["5551234567","+05551234567","+1555","+1 555 123 4567","tel:+15551234567"])
  await assert.rejects(p.send({to,body:"x"}),{code:"sms_bad_number"},to);
 assert.equal(none.calls.length,0,"invalid numbers never reach Twilio");
 const cases=[
  [{status:400,body:{code:21211,message:"Invalid 'To' Phone Number"}},"sms_bad_number",false],
  [{status:400,body:{code:21610,message:"unsubscribed recipient"}},"sms_bad_number",false],
  [{status:401,body:{code:20003,message:"Authenticate"}},"sms_send_failed",false],
  [{status:429,body:{code:20429}},"sms_send_failed",true],
  [{status:503},"sms_send_failed",true],
  [{status:201,body:{}},"sms_send_failed",true],
  [Object.assign(Error("timeout"),{name:"TimeoutError"}),"sms_send_failed",true],
 ];
 for(const [response,code,retryable] of cases){
  const s=stub([response]);
  const q=smsProviderFromEnv(env,{fetchImpl:s.fetchImpl});
  await assert.rejects(q.send({to:"+15551234567",body:"x"}),e=>{
   assert.equal(e.code,code);assert.equal(e.retryable,retryable);
   assert.ok(!String(e.message).includes(TOKEN));return true;});
 }
});
