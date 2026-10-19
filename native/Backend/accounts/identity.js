"use strict";
// Who is calling. Two token kinds are accepted:
//  - Red-XAI Accounts tokens (OIDC, verified against the issuer's JWKS) when REDXAI_ISSUER is configured;
//  - Firebase ID tokens (Google or email/password), the transitional backing until Red-XAI Accounts is live.
// A Red-XAI subject maps to a Gendragoon uid through gd_identity_links (set by POST /v1/accounts/link/redxai for
// existing Firebase users, so their workspaces carry over). An unlinked subject gets the uid "rxa:<sub>".
const {createOidcVerifier,issuedBy}=require("./oidc");

// Red-XAI Accounts v1.1 access tokens (typ at+jwt, aud = client_id = "gendragoon") carry every claim Gendragoon
// needs: preferred_username, email, email_verified, age_band, amr, auth_time, sid and app_tos_version (the
// Gendragoon Terms version this account accepted centrally). No userinfo round trip is needed.
function createIdentity({firebaseVerify,store,issuer,audience,fetchImpl=globalThis.fetch,now=()=>Date.now()}){
 const oidc=issuer?createOidcVerifier({issuer,audience,typ:"at+jwt",fetchImpl,now}):null;
 async function identify(token){
  if(oidc&&issuedBy(token,oidc.issuer)){
   const c=await oidc.verify(token);
   const linked=store?await store.resolveLink(oidc.issuer,c.sub):null;
   return {uid:linked||"rxa:"+c.sub,provider:"redxai",issuer:oidc.issuer,sub:c.sub,email:c.email||null,emailVerified:c.email_verified===true,
    username:c.preferred_username||null,ageBand:c.age_band||null,adultVerified:c.adult_verified===true,amr:Array.isArray(c.amr)?c.amr:[],
    authTime:c.auth_time??null,sid:c.sid||null,appTosVersion:typeof c.app_tos_version==="string"?c.app_tos_version:null,signInProvider:"redxai"};
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
