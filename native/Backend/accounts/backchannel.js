"use strict";
// Red-XAI Accounts back-channel for the Gendragoon backend, as the confidential client "gendragoon-backend"
// (HTTP Basic client_id:client_secret). Env: REDXAI_ISSUER, REDXAI_BACKEND_CLIENT_ID (default gendragoon-backend),
// REDXAI_BACKEND_CLIENT_SECRET (Secret Manager; issued once with `redxai-accounts app-secret gendragoon-backend`).
//   status(sub)          GET /v1/apps/accounts/{sub}/status -> {active,status,until,reason,ageBand,adultVerified}
//   events(since,limit)  GET /v1/apps/events?since&limit    -> {events,next,hasMore}  (apply, then store `next`)
// Returns null from backchannelFromEnv when not configured; callers then rely on access-token expiry (10 min).
class BackchannelError extends Error{constructor(code,status){super(code);this.code=code;this.status=status;}}

function createBackchannel({issuer,clientId="gendragoon-backend",clientSecret,fetchImpl=globalThis.fetch,timeoutMs=8000}){
 if(!issuer||!clientSecret)throw Error("issuer and client secret required");
 const base=String(issuer).replace(/\/+$/,"");
 const auth="Basic "+Buffer.from(encodeURIComponent(clientId)+":"+encodeURIComponent(clientSecret)).toString("base64");
 async function get(path){
  let res;
  try{res=await fetchImpl(base+path,{headers:{authorization:auth,accept:"application/json"},redirect:"error",signal:AbortSignal.timeout(timeoutMs)});}
  catch(_){throw new BackchannelError("backchannel_unavailable",0);}
  let body=null;try{body=await res.json();}catch(_){}
  if(!res.ok)throw new BackchannelError(typeof body?.error==="string"?body.error:"backchannel_failed",res.status);
  return body;
 }
 return {
  clientId,
  status:sub=>get("/v1/apps/accounts/"+encodeURIComponent(sub)+"/status"),
  async events(since=0,limit=100){
   const page=await get("/v1/apps/events?since="+encodeURIComponent(String(since))+"&limit="+Math.max(1,Math.min(500,limit|0)));
   return {events:Array.isArray(page?.events)?page.events:[],next:Number.isFinite(page?.next)?page.next:since,hasMore:page?.hasMore===true};
  },
 };
}
function backchannelFromEnv(env=process.env,{fetchImpl}={}){
 if(!env.REDXAI_ISSUER||!env.REDXAI_BACKEND_CLIENT_SECRET)return null;
 return createBackchannel({issuer:env.REDXAI_ISSUER,clientId:env.REDXAI_BACKEND_CLIENT_ID||"gendragoon-backend",clientSecret:env.REDXAI_BACKEND_CLIENT_SECRET,...(fetchImpl?{fetchImpl}:{})});
}
module.exports={createBackchannel,backchannelFromEnv,BackchannelError};
