"use strict";
// The Gendragoon Terms of Service and the read-then-agree gate.
// 1. The app shows the text; the "Read ToS" button only unlocks after the person scrolls to the end.
// 2. "Read ToS" calls POST /v1/accounts/tos/read, which returns a signed read receipt for the current version.
// 3. "Agree to ToS" sends that receipt with agreed:true in the sign-up (or re-accept) request.
// The server creates the account only with a valid receipt for the current version and an explicit agree.
const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
const TOS_FILE=path.join(__dirname,"..","legal","GENDRAGOON_TOS.md");
const RECEIPT_TTL_MS=24*3600_000;

function loadTerms(file=TOS_FILE){
 const raw=fs.readFileSync(file,"utf8");
 const text=raw.replace(/^\s*<!--[\s\S]*?-->\s*/,"");
 const match=/^Version:\s*(\S+)\s*$/m.exec(text);
 if(!match)throw Error("Terms file has no Version line");
 return {version:match[1],text,sha256:crypto.createHash("sha256").update(text).digest("hex")};
}

function createTosGate({terms=loadTerms(),key,now=()=>Date.now()}){
 if(!key||key.length<32)throw Error("ToS receipt key required");
 const mac=body=>crypto.createHmac("sha256",key).update(body).digest("base64url");
 function issueReadReceipt(version){
  if(version!==terms.version)return {ok:false,code:"tos_outdated"};
  const readAtMs=now();
  const body=["v1",terms.version,readAtMs,crypto.randomBytes(9).toString("base64url")].join(".");
  return {ok:true,readToken:body+"."+mac(body),version:terms.version,readAtMs};
 }
 // {ok:true,version,readAtMs,agreedAtMs} | {ok:false,code}
 function verifyAcceptance(tos){
  if(!tos||typeof tos!=="object")return {ok:false,code:"tos_not_read"};
  if(tos.version!==terms.version)return {ok:false,code:"tos_outdated"};
  const token=typeof tos.readToken==="string"?tos.readToken:"";
  const parts=token.split(".");
  if(parts.length!==5||parts[0]!=="v1")return {ok:false,code:"tos_not_read"};
  const body=parts.slice(0,4).join(".");
  const expected=Buffer.from(mac(body)),given=Buffer.from(parts[4]);
  if(expected.length!==given.length||!crypto.timingSafeEqual(expected,given))return {ok:false,code:"tos_not_read"};
  if(parts[1]!==terms.version)return {ok:false,code:"tos_outdated"};
  const readAtMs=Number(parts[2]),t=now();
  if(!Number.isSafeInteger(readAtMs)||readAtMs>t||t-readAtMs>RECEIPT_TTL_MS)return {ok:false,code:"tos_not_read"};
  if(tos.agreed!==true)return {ok:false,code:"tos_not_agreed"};
  return {ok:true,version:terms.version,readAtMs,agreedAtMs:t};
 }
 return {terms,issueReadReceipt,verifyAcceptance};
}
module.exports={loadTerms,createTosGate,TOS_FILE};
