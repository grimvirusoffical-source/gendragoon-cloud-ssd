"use strict";
// Who is calling. Two token kinds are accepted:
//  - Red-XAI Accounts tokens (OIDC, verified against the issuer's JWKS) when REDXAI_ISSUER is configured;
//  - Firebase ID tokens (Google or email/password), the transitional backing until Red-XAI Accounts is live.
// A Red-XAI subject maps to a Gendragoon uid through gd_identity_links (set by POST /v1/accounts/link/redxai for
// existing Firebase users, so their workspaces carry over). An unlinked subject gets the uid "rxa:<sub>".
const {createOidcVerifier,issuedBy}=require("./oidc");

function createIdentity({firebaseVerify,store,issuer,audience,fetchImpl=globalThis.fetch,now=()=>Date.now()}){
 const oidc=issuer?createOidcVerifier({issuer,audience,fetchImpl,now}):null;
 const userinfoCache=new Map();
 // The v1 access token carries sub, aud, scope, sid; profile claims come from userinfo when absent (cached per sid).
 async function profileClaims(token,claims){
  if(claims.preferred_username&&claims.email!==undefined)return claims;
  const key=claims.sid||claims.jti||token.slice(-24);
  const hit=userinfoCache.get(key);
  if(hit&&hit.until>now())return {...hit.claims,...claims};
  const res=await fetchImpl(oidc.issuer+"/oauth2/userinfo",{headers:{authorization:"Bearer "+token,accept:"application/json"},signal:AbortSignal.timeout(8000)});
  if(!res.ok)throw Object.assign(Error("userinfo_unavailable"),{code:"userinfo_unavailable"});
  const info=await res.json();
  if(info.sub!==claims.sub)throw Object.assign(Error("userinfo_subject"),{code:"userinfo_subject"});
  if(userinfoCache.size>5000)userinfoCache.clear();
  userinfoCache.set(key,{claims:info,until:now()+5*60_000});
  return {...info,...claims};
 }
 async function identify(token){
  if(oidc&&issuedBy(token,oidc.issuer)){
   const verified=await oidc.verify(token);
   const c=await profileClaims(token,verified);
   const linked=store?await store.resolveLink(oidc.issuer,c.sub):null;
   return {uid:linked||"rxa:"+c.sub,provider:"redxai",issuer:oidc.issuer,sub:c.sub,email:c.email||null,emailVerified:c.email_verified===true,
    username:c.preferred_username||null,ageBand:c.age_band||null,amr:Array.isArray(c.amr)?c.amr:[],authTime:c.auth_time??null,sid:c.sid||null,signInProvider:"redxai"};
  }
  const u=await firebaseVerify(token);
  if(!u||typeof u.uid!=="string"||!u.uid)throw Error("invalid token");
  return {uid:u.uid,provider:"firebase",signInProvider:u.firebase?.sign_in_provider||null,email:u.email||null,emailVerified:u.email_verified===true,
   authTime:u.auth_time??null,amr:[],firebaseUser:u};
 }
 // The shape the login gate and the existing routes expect (req.user), with the identity attached.
 async function verifyForGate(token){
  const id=await identify(token);
  const base=id.firebaseUser||{uid:id.uid,email:id.email,email_verified:id.emailVerified,auth_time:id.authTime,firebase:{sign_in_provider:"redxai"}};
  return Object.assign({},base,{uid:id.uid,__identity:id});
 }
 return {identify,verifyForGate,oidcEnabled:Boolean(oidc)};
}
module.exports={createIdentity};
