"use strict";
// Text-message providers for phone two-factor sign-in. Interface: send({to,body}) -> Promise<{id}>.
//   Twilio  Programmable Messaging over HTTPS (no SDK). Selected when TWILIO_ACCOUNT_SID is set, or SMS_PROVIDER=twilio.
//           Credentials: TWILIO_AUTH_TOKEN, or TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET.
//           Sender:      TWILIO_MESSAGING_SERVICE_SID (preferred) or TWILIO_FROM_NUMBER (E.164).
//           Incomplete or malformed settings leave phone 2FA unavailable; smsConfigProblem() names the missing
//           variable without printing any value.
//   Mock    SMS_PROVIDER=mock. Records messages in memory and never sends anything. Refused in production unless
//           ACCOUNTS_ALLOW_MOCK_SMS=true (staging only).
// The codes themselves are generated, hashed, rate limited and single-use in routes.js; providers only deliver text.
const E164=/^\+[1-9][0-9]{7,14}$/;
const TWILIO_API="https://api.twilio.com/2010-04-01";
const SEND_TIMEOUT_MS=10_000;

class MockSmsProvider{
 constructor(){this.sent=[];this.mock=true;this.name="mock";}
 async send({to,body}){
  if(!E164.test(String(to)))throw smsError("sms_bad_number");
  const id="mock-"+(this.sent.length+1);
  this.sent.push({id,to,body,at:Date.now()});
  return {id};
 }
 lastTo(to){for(let i=this.sent.length-1;i>=0;i--)if(this.sent[i].to===to)return this.sent[i];return null;}
}

const smsError=(code,extra)=>Object.assign(new Error(code),{code,...extra});

class TwilioSmsProvider{
 // fetchImpl is injectable so tests use HTTP stubs; nothing in the test suite reaches Twilio.
 constructor({accountSid,username,password,from,messagingServiceSid,fetchImpl=globalThis.fetch,timeoutMs=SEND_TIMEOUT_MS,apiBase=TWILIO_API}){
  this.name="twilio";this.mock=false;
  this.accountSid=accountSid;this.from=from||null;this.messagingServiceSid=messagingServiceSid||null;
  this.fetchImpl=fetchImpl;this.timeoutMs=timeoutMs;this.apiBase=apiBase;
  // Kept off enumerable properties so the credential never lands in logs or JSON dumps of the provider.
  Object.defineProperty(this,"authHeader",{value:"Basic "+Buffer.from(username+":"+password).toString("base64"),enumerable:false});
 }
 async send({to,body}){
  if(!E164.test(String(to)))throw smsError("sms_bad_number");
  const form=new URLSearchParams({To:to,Body:body});
  if(this.messagingServiceSid)form.set("MessagingServiceSid",this.messagingServiceSid);else form.set("From",this.from);
  const url=this.apiBase+"/Accounts/"+encodeURIComponent(this.accountSid)+"/Messages.json";
  let res;
  try{
   res=await this.fetchImpl(url,{method:"POST",redirect:"error",signal:AbortSignal.timeout(this.timeoutMs),
    headers:{Authorization:this.authHeader,"Content-Type":"application/x-www-form-urlencoded",Accept:"application/json"},body:form.toString()});
  }catch(error){throw smsError("sms_send_failed",{retryable:true,cause:error?.name||"network"});}
  let data=null;try{data=await res.json();}catch{}
  if(!res.ok){
   // Twilio error codes: 21211 invalid To, 21610 recipient opted out (STOP), 21408/21612 region or route not permitted.
   const vendorCode=data&&typeof data.code==="number"?data.code:null;
   const badNumber=[21211,21214,21217,21408,21610,21612,21614].includes(vendorCode);
   throw smsError(badNumber?"sms_bad_number":"sms_send_failed",{retryable:!badNumber&&(res.status===429||res.status>=500),status:res.status,vendorCode});
  }
  if(!data||typeof data.sid!=="string")throw smsError("sms_send_failed",{retryable:true,status:res.status});
  return {id:data.sid};
 }
}

const SID=(prefix)=>new RegExp("^"+prefix+"[0-9a-fA-F]{32}$");
// Returns {config} or {problem:"<VARIABLE> ..."}; never includes a value.
function twilioConfigFromEnv(env){
 const accountSid=env.TWILIO_ACCOUNT_SID||"";
 if(!SID("AC").test(accountSid))return {problem:"TWILIO_ACCOUNT_SID is missing or not an account SID (AC...)"};
 let username,password;
 if(env.TWILIO_API_KEY_SID||env.TWILIO_API_KEY_SECRET){
  if(!SID("SK").test(env.TWILIO_API_KEY_SID||""))return {problem:"TWILIO_API_KEY_SID is missing or not an API key SID (SK...)"};
  if(!env.TWILIO_API_KEY_SECRET)return {problem:"TWILIO_API_KEY_SECRET is missing"};
  username=env.TWILIO_API_KEY_SID;password=env.TWILIO_API_KEY_SECRET;
 }else if(env.TWILIO_AUTH_TOKEN){
  username=accountSid;password=env.TWILIO_AUTH_TOKEN;
 }else return {problem:"TWILIO_AUTH_TOKEN or TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET is missing"};
 const messagingServiceSid=env.TWILIO_MESSAGING_SERVICE_SID||"";
 const from=(env.TWILIO_FROM_NUMBER||"").replace(/[\s().-]/g,"");
 if(messagingServiceSid){if(!SID("MG").test(messagingServiceSid))return {problem:"TWILIO_MESSAGING_SERVICE_SID is not a Messaging Service SID (MG...)"};}
 else if(!from)return {problem:"TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER is missing"};
 else if(!E164.test(from))return {problem:"TWILIO_FROM_NUMBER is not an E.164 number (+15551234567)"};
 return {config:{accountSid,username,password,from:messagingServiceSid?null:from,messagingServiceSid:messagingServiceSid||null}};
}

const wantsTwilio=env=>env.SMS_PROVIDER==="twilio"||(!env.SMS_PROVIDER&&Boolean(env.TWILIO_ACCOUNT_SID));
// Why phone 2FA is unavailable, or null when it is available (or deliberately not configured).
function smsConfigProblem(env=process.env){
 if(!wantsTwilio(env))return null;
 return twilioConfigFromEnv(env).problem||null;
}
function smsProviderFromEnv(env=process.env,{fetchImpl}={}){
 const kind=env.SMS_PROVIDER||"";
 if(kind==="mock")return (env.NODE_ENV!=="production"||env.ACCOUNTS_ALLOW_MOCK_SMS==="true")?new MockSmsProvider():null;
 if(wantsTwilio(env)){
  const {config}=twilioConfigFromEnv(env);
  return config?new TwilioSmsProvider({...config,...(fetchImpl?{fetchImpl}:{})}):null;
 }
 return null;
}
module.exports={MockSmsProvider,TwilioSmsProvider,smsProviderFromEnv,smsConfigProblem,twilioConfigFromEnv,E164};
