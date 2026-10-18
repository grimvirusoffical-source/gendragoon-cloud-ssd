"use strict";
// Wrapped workspace key envelope. The server stores the opaque wrapped key
// and a version. It does not accept a passphrase, a plaintext key, or a filename.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64=/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_ENVELOPE_BYTES=4*1024;
const FORBIDDEN=/^(name|filename|fileName|originalName|plaintext|plaintextName|key|keys|encryptionKey|dek|kek|password|passphrase|secret|secretAccessKey|accessKey|accessKeyId|privateKey|content|data|unwrappedKey|rawKey|masterKey|workspaceKey|keyMaterial|plainKey)$/i;

function refusal(status,error){
 const err=new Error(error);
 err.status=status;
 err.error=error;
 return err;
}
function forbiddenName(name){
 if(name==="wrappedKey")return false;
 if(FORBIDDEN.test(name))return true;
 return /passphrase|plaintext|password|secret|private.?key|unwrapped|raw.?key|master.?key|key.?material/i.test(name);
}
function rejectForbidden(value,depth=0){
 if(depth>6||!value||typeof value!=="object")return;
 for(const [key,child] of Object.entries(value)){
  if(key==="__proto__"||key==="constructor"||key==="prototype"||forbiddenName(key))throw refusal(400,"plaintext_rejected");
  if(child&&typeof child==="object")rejectForbidden(child,depth+1);
 }
}
function validWrappedKey(value){
 if(typeof value!=="string"||!B64.test(value))return false;
 const buf=Buffer.from(value,"base64");
 return buf.length>=32&&buf.toString("base64")===value;
}
function parseEnvelope(body){
 if(!body||typeof body!=="object"||Array.isArray(body))throw refusal(400,"invalid_envelope");
 rejectForbidden(body);
 const extra=Object.keys(body).filter(key=>key!=="version"&&key!=="wrappedKey");
 if(extra.length)throw refusal(400,"invalid_envelope");
 if(!Number.isSafeInteger(body.version)||body.version<1||body.version>1_000_000_000)throw refusal(400,"invalid_envelope");
 if(!validWrappedKey(body.wrappedKey))throw refusal(400,"invalid_envelope");
 const envelope={version:body.version,wrappedKey:body.wrappedKey};
 if(Buffer.byteLength(JSON.stringify(envelope),"utf8")>MAX_ENVELOPE_BYTES)throw refusal(413,"payload_too_large");
 return envelope;
}
function header(req,name){
 const value=req.headers?.[name];
 if(Array.isArray(value))return value.join(",").trim();
 return typeof value==="string"?value.trim():"";
}
function matchVersion(value){
 if(!value||value==="*"||value.startsWith("W/"))return null;
 const quoted=/^"(\d+)"$/.exec(value);
 const bare=/^(\d+)$/.exec(value);
 const digits=quoted?.[1]||bare?.[1];
 if(!digits)return null;
 const version=Number(digits);
 if(!Number.isSafeInteger(version)||version<1)return null;
 return version;
}
function precondition(req){
 const match=header(req,"if-match");
 const none=header(req,"if-none-match");
 if(match&&none)throw refusal(400,"invalid_precondition");
 if(!match&&!none)throw refusal(428,"precondition_required");
 if(none){
  if(none!=="*")throw refusal(400,"invalid_precondition");
  return {create:true};
 }
 const version=matchVersion(match);
 if(version===null)throw refusal(400,"invalid_precondition");
 return {create:false,version};
}
function byteLengthOf(req){
 const declared=Number(req.headers?.["content-length"]);
 const parsed=req.body&&typeof req.body==="object"?Buffer.byteLength(JSON.stringify(req.body),"utf8"):0;
 return Math.max(Number.isFinite(declared)?declared:0,parsed);
}
async function loadWorkspace(db,accountHash,id){
 if(id==="free"){
  const snap=await db.collection("tenants").doc(accountHash).collection("workspaces").doc("free").get();
  if(!snap.exists||snap.data()?.accountKey!==accountHash||snap.data()?.kind!=="free")return null;
  return {id,data:snap.data()};
 }
 if(typeof id!=="string"||!UUID.test(id))return {invalid:true};
 const snap=await db.collection("gd_accounts").doc(accountHash).collection("workspaces").doc(id).get();
 if(!snap.exists||snap.data()?.accountHash!==accountHash)return null;
 return {id,data:snap.data()};
}
function envelopeRef(db,accountHash,id){
 return db.collection("gd_accounts").doc(accountHash).collection("key_envelopes").doc(id);
}
async function deleteAccountKeyEnvelopes(db,accountHash){
 if(!db||typeof accountHash!=="string"||!/^[a-f0-9]{64}$/.test(accountHash))return 0;
 const snap=await db.collection("gd_accounts").doc(accountHash).collection("key_envelopes").get();
 let removed=0;
 for(const doc of snap.docs||[]){
  await doc.ref.delete();
  removed++;
 }
 return removed;
}
function createKeyEnvelope({db,hash}){
 function ownerOf(req){
  const uid=req?.user?.uid;
  if(typeof uid!=="string"||!uid)throw refusal(401,"invalid_token");
  const owner=hash(uid);
  if(typeof owner!=="string"||!/^[a-f0-9]{64}$/.test(owner))throw refusal(400,"invalid_account");
  return owner;
 }
 async function owned(req){
  const owner=ownerOf(req);
  const workspace=await loadWorkspace(db,owner,req.params?.id);
  if(workspace?.invalid)throw refusal(400,"invalid_workspace");
  if(!workspace)throw refusal(404,"not_found");
  return {owner,workspace};
 }
 async function getEnvelope(req){
  const {owner,workspace}=await owned(req);
  const snap=await envelopeRef(db,owner,workspace.id).get();
  if(!snap.exists)throw refusal(404,"not_found");
  return parseEnvelope(snap.data());
 }
 async function putEnvelope(req){
  if(byteLengthOf(req)>MAX_ENVELOPE_BYTES)throw refusal(413,"payload_too_large");
  rejectForbidden(req.body);
  const envelope=parseEnvelope(req.body);
  const gate=precondition(req);
  const {owner,workspace}=await owned(req);
  const ref=envelopeRef(db,owner,workspace.id);
  await db.runTransaction(async tx=>{
   const snap=await tx.get(ref);
   if(gate.create){
    if(snap.exists)throw refusal(409,"envelope_exists");
   }else if(!snap.exists||snap.data()?.version!==gate.version||envelope.version!==gate.version+1){
    throw refusal(412,"version_mismatch");
   }
   tx.set(ref,envelope);
  });
  return envelope;
 }
 return {getEnvelope,putEnvelope};
}
function sendError(res,error){
 const status=Number.isInteger(error?.status)?error.status:500;
 const code=typeof error?.error==="string"?error.error:"key_envelope_failed";
 if(status>=500)console.error("key envelope request failed",code);
 res.setHeader("Cache-Control","private, no-store");
 res.status(status).json({error:code});
}
function registerKeyEnvelope(deps){
 const {app,firebaseAuth}=deps;
 if(!app||typeof firebaseAuth!=="function")throw Error("key envelope requires an app and firebaseAuth");
 const svc=deps.service||createKeyEnvelope(deps);
 app.get("/v2/workspaces/:id/key-envelope",firebaseAuth,async(req,res)=>{
  try{
   const body=await svc.getEnvelope(req);
   res.setHeader("Cache-Control","private, no-store");
   res.setHeader("ETag",'"'+body.version+'"');
   res.json(body);
  }catch(error){sendError(res,error);}
 });
 app.put("/v2/workspaces/:id/key-envelope",firebaseAuth,async(req,res)=>{
  try{
   const created=header(req,"if-none-match")==="*";
   const body=await svc.putEnvelope(req);
   res.setHeader("Cache-Control","private, no-store");
   res.setHeader("ETag",'"'+body.version+'"');
   res.status(created?201:200).json(body);
  }catch(error){sendError(res,error);}
 });
 return svc;
}
module.exports={createKeyEnvelope,registerKeyEnvelope,deleteAccountKeyEnvelopes,MAX_ENVELOPE_BYTES};
