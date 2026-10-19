"use strict";
// Verifies Red-XAI Accounts access and ID tokens (OIDC, ES256 per the v1 contract; RS256 also accepted) against the
// issuer's JWKS. Discovery: GET <issuer>/.well-known/openid-configuration -> jwks_uri. Keys are cached and refetched
// on an unknown kid at most once a minute, so a key rotation is picked up without a restart.
const crypto=require("node:crypto");
const ALGS={ES256:{hash:"sha256",kty:"EC",dsaEncoding:"ieee-p1363"},RS256:{hash:"sha256",kty:"RSA"}};
const SKEW_S=60;

class TokenError extends Error{constructor(code){super(code);this.code=code;}}
const b64json=part=>JSON.parse(Buffer.from(part,"base64url").toString("utf8"));

function decodeUnverified(token){
 const parts=typeof token==="string"?token.split("."):[];
 if(parts.length!==3)return null;
 try{return {header:b64json(parts[0]),payload:b64json(parts[1])};}catch(_){return null;}
}

// audience: one client id or a list. With typ:"at+jwt" only access tokens (RFC 9068) whose client_id is one of the
// audiences are accepted, which is what Red-XAI Accounts v1.1 issues (aud = client_id = the requesting app).
function createOidcVerifier({issuer,audience,typ,fetchImpl=globalThis.fetch,now=()=>Date.now(),cacheMs=10*60_000}){
 const audiences=(Array.isArray(audience)?audience:[audience]).filter(Boolean);
 if(!issuer||audiences.length===0)throw Error("issuer and audience required");
 const iss=issuer.replace(/\/+$/,"");
 let keys=new Map(),fetchedAt=0,inflight=null,jwksUri=null;
 async function getJson(url){
  const res=await fetchImpl(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(8000)});
  if(!res.ok)throw new TokenError("jwks_unavailable");
  return res.json();
 }
 async function refresh(){
  if(!jwksUri){
   const conf=await getJson(iss+"/.well-known/openid-configuration");
   if(conf.issuer!==iss||typeof conf.jwks_uri!=="string"||!conf.jwks_uri.startsWith("https://")&&!conf.jwks_uri.startsWith(iss))
    throw new TokenError("discovery_invalid");
   jwksUri=conf.jwks_uri;
  }
  const jwks=await getJson(jwksUri);
  const next=new Map();
  for(const jwk of Array.isArray(jwks.keys)?jwks.keys:[]){
   if(!jwk||typeof jwk.kid!=="string"||(jwk.use&&jwk.use!=="sig"))continue;
   try{next.set(jwk.kid,{jwk,key:crypto.createPublicKey({key:jwk,format:"jwk"})});}catch(_){/* skip unusable key */}
  }
  keys=next;fetchedAt=now();
 }
 async function keyFor(kid){
  const age=now()-fetchedAt;
  if(fetchedAt===0||age>cacheMs||(!keys.has(kid)&&age>60_000)){
   inflight=inflight||refresh().finally(()=>{inflight=null;});
   await inflight;
  }
  return keys.get(kid)||null;
 }
 // Returns the verified claims. Throws TokenError with a stable code.
 async function verify(token,{nonce}={}){
  const decoded=decodeUnverified(token);
  if(!decoded)throw new TokenError("token_malformed");
  const {header,payload}=decoded;
  const alg=ALGS[header.alg];
  if(!alg||typeof header.kid!=="string")throw new TokenError("token_alg");
  if(typ&&String(header.typ||"").toLowerCase()!==typ&&String(header.typ||"").toLowerCase()!=="application/"+typ)throw new TokenError("token_type");
  const entry=await keyFor(header.kid);
  if(!entry||entry.jwk.kty!==alg.kty||(entry.jwk.alg&&entry.jwk.alg!==header.alg))throw new TokenError("token_key");
  const [h,p,s]=token.split(".");
  const good=crypto.verify(alg.hash,Buffer.from(h+"."+p),alg.dsaEncoding?{key:entry.key,dsaEncoding:alg.dsaEncoding}:entry.key,Buffer.from(s,"base64url"));
  if(!good)throw new TokenError("token_signature");
  const t=Math.floor(now()/1000);
  if(payload.iss!==iss)throw new TokenError("token_issuer");
  const aud=Array.isArray(payload.aud)?payload.aud:[payload.aud];
  if(!aud.some(a=>audiences.includes(a)))throw new TokenError("token_audience");
  if(typ==="at+jwt"&&!audiences.includes(payload.client_id))throw new TokenError("token_client");
  if(!Number.isFinite(payload.exp)||payload.exp+SKEW_S<t)throw new TokenError("token_expired");
  if(Number.isFinite(payload.nbf)&&payload.nbf-SKEW_S>t)throw new TokenError("token_not_yet_valid");
  if(Number.isFinite(payload.iat)&&payload.iat-SKEW_S>t)throw new TokenError("token_not_yet_valid");
  if(typeof payload.sub!=="string"||!payload.sub)throw new TokenError("token_subject");
  if(nonce!==undefined&&payload.nonce!==nonce)throw new TokenError("token_nonce");
  return payload;
 }
 return {verify,issuer:iss,audience:audiences[0],audiences};
}
// True when the token claims to come from this issuer (cheap routing before verification).
function issuedBy(token,issuer){const d=decodeUnverified(token);return Boolean(d&&d.payload&&d.payload.iss===String(issuer).replace(/\/+$/,""));}
module.exports={createOidcVerifier,decodeUnverified,issuedBy,TokenError};
