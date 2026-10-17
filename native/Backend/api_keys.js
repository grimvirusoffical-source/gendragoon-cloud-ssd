"use strict";
/* GenDragoon API keys: account-scoped free workspace, secret displayed once,
   SHA256 hashed at rest, scoped, expiring, revocable, Firebase minted only. */
const crypto=require("node:crypto");
const PREFIX="gdsk_";
const VALID=new Set(["files:read","files:write"]);
const KEY_TTL_DAYS=90;
const MAX_ACTIVE=5;
const TERMS_VERSION="terms-2026-10-14-v1";
const COLLECTION="gd_api_keys";
function generate(){
 const id=crypto.randomBytes(12).toString("hex");
 const secret=crypto.randomBytes(32).toString("base64url");
 const token=PREFIX+id+"_"+secret;
 return {id,token,digest:crypto.createHash("sha256").update(token).digest("hex")};
}
function parse(token){
 const match=/^gdsk_([0-9a-f]{24})_([A-Za-z0-9_-]{43})$/.exec(token||"");
 return match?{id:match[1],digest:crypto.createHash("sha256").update(token).digest("hex")}:null;
}
function checkScopes(input){
 if(!Array.isArray(input)||!input.length||input.length>2||new Set(input).size!==input.length||
    input.some(x=>!VALID.has(x)))throw Error("Invalid API key scopes");
 return input;
}
async function verify(token,{db,auth,accountKey}){
 const parsed=parse(token);
 if(!parsed)return null;
 const ref=db.collection(COLLECTION).doc(parsed.id),snap=await ref.get();
 if(!snap.exists)return null;
 const key=snap.data();
 if(key.revokedAt||key.termsVersion!==TERMS_VERSION||
    !(key.workspaceId==="free"||/^[0-9a-f-]{36}$/.test(key.workspaceId||""))||
    !key.expiresAt||key.expiresAt.toMillis()<=Date.now()||
    !Array.isArray(key.scopes)||typeof key.ownerUid!=="string"||
    key.ownerHash!==accountKey(key.ownerUid))return null;
 const digest=Buffer.from(String(key.digest||""),"hex"),expected=Buffer.from(parsed.digest,"hex");
 if(digest.length!==32||!crypto.timingSafeEqual(digest,expected))return null;
 const user=await auth.getUser(key.ownerUid);
 if(user.disabled)return null;
 return {uid:key.ownerUid,scopes:key.scopes,keyId:parsed.id,ownerHash:key.ownerHash,workspaceId:key.workspaceId};
}
function requireScope(scope){
 return (req,res,next)=>{
  if(req.authKind==="api_key"&&!req.keyScopes?.includes(scope))
   return res.status(403).json({error:"API key lacks "+scope+" scope"});
  next();
 };
}
function install(app,{db,auth,firebaseAuth,accountKey,workspaceRef,FieldValue}){
 app.get("/v1/keys",firebaseAuth,async(req,res)=>{
  try{
   const docs=await db.collection(COLLECTION).where("ownerHash","==",accountKey(req.user.uid)).limit(50).get();
   res.json({keys:docs.docs.map(doc=>{
    const k=doc.data();
    return {id:doc.id,name:k.name,scopes:k.scopes,workspaceId:k.workspaceId,
      createdAt:k.createdAt?.toDate?.().toISOString()||null,
      expiresAt:k.expiresAt?.toDate?.().toISOString()||null,
      active:!k.revokedAt&&k.expiresAt?.toMillis?.()>Date.now()};
   }),maxActive:MAX_ACTIVE});
  }catch(_){res.status(503).json({error:"API key list unavailable"})}
 });
 app.post("/v1/keys",firebaseAuth,require("express").json({limit:"4kb"}),async(req,res)=>{
  try{
   const workspaceId=req.body?.workspaceId||"free";
   const ownerHash=accountKey(req.user.uid);
   if(workspaceId==="free"){
     const w=await workspaceRef(req.user.uid).get();
     if(!w.exists||w.data().kind!=="free"||w.data().accountKey!==ownerHash)
       return res.status(409).json({error:"Create a free workspace first"});
   }else{
     if(!/^[0-9a-f-]{36}$/.test(workspaceId))return res.status(400).json({error:"Invalid workspace ID"});
     const w=await db.collection("gd_accounts").doc(ownerHash).collection("workspaces").doc(workspaceId).get();
     if(!w.exists||w.data().accountHash!==ownerHash||w.data().kind!=="paid"||
        w.data().storageActive!==true||w.data().provisioned!==true)
       return res.status(403).json({error:"Only owned, active, provisioned paid workspaces can issue keys"});
   }
   const name=String(req.body?.name||"My Application").trim();
   if(name.length<2||name.length>60||/[\x00-\x1f]/.test(name))return res.status(400).json({error:"API key name must be 2–60 characters"});
   const scopes=checkScopes(req.body?.scopes||["files:read"]);
   const registry=db.collection(COLLECTION);
   const existing=await registry.where("ownerHash","==",ownerHash).limit(50).get();
   if(existing.docs.filter(d=>!d.data().revokedAt&&d.data().expiresAt?.toMillis?.()>Date.now()).length>=MAX_ACTIVE)
     return res.status(409).json({error:"Five active keys maximum; revoke an old key first"});
   const {id,token,digest}=generate();
   const expiresAt=new Date(Date.now()+KEY_TTL_DAYS*86400000);
   await registry.doc(id).create({ownerUid:req.user.uid,ownerHash,name,
     digest,scopes,termsVersion:TERMS_VERSION,workspaceId,createdAt:FieldValue.serverTimestamp(),
     expiresAt,revokedAt:null});
   res.setHeader("Cache-Control","no-store");
   res.status(201).json({id,apiKey:token,expiresAt:expiresAt.toISOString(),scopes,
     warning:"Save this secret now. The API key is never displayed again."});
  }catch(e){
   if(e.message==="Invalid API key scopes")return res.status(400).json({error:e.message});
   res.status(503).json({error:"Could not create API key"});
  }
 });
 app.delete("/v1/keys/:id",firebaseAuth,async(req,res)=>{
  if(!/^[0-9a-f]{24}$/.test(req.params.id))return res.status(400).json({error:"Invalid key ID"});
  try{
   const ref=db.collection(COLLECTION).doc(req.params.id),snap=await ref.get();
   if(!snap.exists||snap.data().ownerHash!==accountKey(req.user.uid))
     return res.status(404).json({error:"Key not found"});
   await ref.update({revokedAt:FieldValue.serverTimestamp()});
   res.json({revoked:true});
  }catch(_){res.status(503).json({error:"Could not revoke API key"})}
 });
}
module.exports={generate,parse,verify,requireScope,install,checkScopes,MAX_ACTIVE,KEY_TTL_DAYS};
