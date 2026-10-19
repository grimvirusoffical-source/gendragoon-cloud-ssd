"use strict";
// AES-256-GCM sealing for 2FA secrets and phone numbers at rest. The key comes from ACCOUNTS_SEAL_KEY
// (32 bytes, base64) and is never written to Firestore or logs.
const crypto=require("node:crypto");
function createSealer(keyB64){
 const key=keyB64?Buffer.from(keyB64,"base64"):null;
 const ready=Boolean(key&&key.length===32);
 return {
  ready,
  seal(plain,context){
   if(!ready)throw Object.assign(Error("sealing unavailable"),{code:"seal_unavailable"});
   const iv=crypto.randomBytes(12);
   const c=crypto.createCipheriv("aes-256-gcm",key,iv);c.setAAD(Buffer.from(String(context)));
   const body=Buffer.concat([c.update(String(plain),"utf8"),c.final()]);
   return "v1."+Buffer.concat([iv,c.getAuthTag(),body]).toString("base64url");
  },
  open(sealed,context){
   if(!ready)throw Object.assign(Error("sealing unavailable"),{code:"seal_unavailable"});
   if(typeof sealed!=="string"||!sealed.startsWith("v1."))throw Error("bad sealed value");
   const raw=Buffer.from(sealed.slice(3),"base64url");
   const d=crypto.createDecipheriv("aes-256-gcm",key,raw.subarray(0,12));
   d.setAAD(Buffer.from(String(context)));d.setAuthTag(raw.subarray(12,28));
   return Buffer.concat([d.update(raw.subarray(28)),d.final()]).toString("utf8");
  },
 };
}
module.exports={createSealer};
