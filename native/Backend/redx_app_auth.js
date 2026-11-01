"use strict";
const BEARER=/^Bearer (rxca_[A-Za-z0-9_-]{43})$/;
const SUBJECT=/^[A-Za-z0-9._:@+-]{1,200}$/;

function createRedXAppAuth({issuer="https://red-xai.com",accounts,decorate,fetchImpl=globalThis.fetch}={}){
 const origin=new URL(issuer);
 if(origin.protocol!=="https:"||origin.username||origin.password||origin.pathname!=="/"||origin.search||origin.hash)
   throw Error("Invalid Red-XAI app issuer");
 if(!accounts?.store?.resolveLink)throw Error("Red-XAI app auth requires account link store");
 async function bounded(response){
   const text=await response.text();
   if(text.length>64*1024)throw Error("identity response too large");
   return JSON.parse(text);
 }
 return function redXAppAuth(req,res,next){
   const match=BEARER.exec(req.headers?.authorization||"");
   if(!match)return next("route");
   (async()=>{
     let response;
     try{
       response=await fetchImpl(origin.origin+"/redxai-connect/userinfo",{
         headers:{authorization:"Bearer "+match[1],accept:"application/json"},
         redirect:"error",signal:AbortSignal.timeout(8000)
       });
     }catch(_){return res.status(503).json({error:"Red-XAI account service unavailable"});}
     if(response.status===401||response.status===403)return res.status(401).json({error:"Red-XAI app session expired"});
     if(!response.ok)return res.status(503).json({error:"Red-XAI account service unavailable"});
     let info;try{info=await bounded(response);}catch(_){return res.status(503).json({error:"Red-XAI identity response invalid"});}
     if(info.protocol!=="redx-site-session-v1"||info.client_id!=="gendragoon"||info.scope!=="gendragoon.receiver"||
        typeof info.sub!=="string"||!SUBJECT.test(info.sub)||info.email_verified!==true)
       return res.status(403).json({error:"Red-XAI account is not eligible for GenDragoon"});
     const linked=await accounts.store.resolveLink(origin.origin,info.sub);
     const uid=linked||"rxa:"+info.sub;
     req.user={uid,email:typeof info.email==="string"?info.email:null,email_verified:true,
       firebase:{sign_in_provider:"redxai"},__identity:{provider:"redxai",issuer:origin.origin,sub:info.sub,
       email:typeof info.email==="string"?info.email:null,emailVerified:true,username:typeof info.username==="string"?info.username:null,
       appGrant:true}};
     req.authKind="redx-app";
     if(typeof decorate==="function")await decorate(req,req.user);
     next();
   })().catch(_=>{if(!res.headersSent)res.status(503).json({error:"Red-XAI authentication unavailable"});});
 };
}

function hybridAuth({redx,fallback}){
 if(typeof redx!=="function"||typeof fallback!=="function")throw Error("hybrid auth requires both providers");
 return function(req,res,next){
   if(BEARER.test(req.headers?.authorization||""))return redx(req,res,next);
   return fallback(req,res,next);
 };
}
module.exports={createRedXAppAuth,hybridAuth,BEARER};
