"use strict";
// The Gendragoon Terms of Service and the Read-then-Agree gate, shaped like the Red-XAI Accounts v1 ToS gate:
// 1. The app shows the text. "Read ToS" unlocks only after the person scrolls to the end.
// 2. "Read ToS"  -> POST /v1/accounts/tos/read {version}  -> {grant, stage:"read"}
// 3. "Agree to ToS" -> POST /v1/accounts/tos/agree {grant} -> {grant, stage:"agreed"}
// 4. The agreed grant goes into sign-up (or re-acceptance). It is valid 30 minutes and single use
//    (the caller consumes its id through the account store), and the account is created only with it.
const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
const TOS_FILE=path.join(__dirname,"..","legal","GENDRAGOON_TOS.md");
const GRANT_TTL_MS=30*60_000;

function loadTerms(file=TOS_FILE){
 const raw=fs.readFileSync(file,"utf8");
 const text=raw.replace(/^\s*<!--[\s\S]*?-->\s*/,"");
 const match=/^Version:\s*(\S+)\s*$/m.exec(text);
 if(!match)throw Error("Terms file has no Version line");
 const title=(/^#\s+(.+)$/m.exec(text)||[])[1]||"Terms of Service";
 return {version:match[1],title,text,sha256:crypto.createHash("sha256").update(text).digest("hex")};
}

function createTosGate({terms=loadTerms(),key,now=()=>Date.now()}){
 if(!key||key.length<32)throw Error("ToS grant key required");
 const mac=body=>crypto.createHmac("sha256",key).update(body).digest("base64url");
 const sign=fields=>{const body=["gdt1",...fields].join(".");return body+"."+mac(body);};
 function parse(grant){
  if(typeof grant!=="string"||grant.length>300)return null;
  const parts=grant.split(".");
  if(parts.length!==7||parts[0]!=="gdt1")return null;
  const body=parts.slice(0,6).join(".");
  const want=Buffer.from(mac(body)),got=Buffer.from(parts[6]);
  if(want.length!==got.length||!crypto.timingSafeEqual(want,got))return null;
  const [,stage,version,id,readMs,agreedMs]=parts;
  return {stage,version,id,readMs:Number(readMs),agreedMs:Number(agreedMs)};
 }
 function read(version){
  if(version!==terms.version)return {ok:false,code:"tos_changed",status:409};
  const t=now();
  return {ok:true,grant:sign(["read",terms.version,crypto.randomBytes(12).toString("base64url"),t,0]),stage:"read",version:terms.version};
 }
 function fresh(g){const t=now();return Number.isSafeInteger(g.readMs)&&g.readMs<=t&&t-g.readMs<=GRANT_TTL_MS;}
 function agree(grant){
  const g=parse(grant);
  if(!g||!fresh(g))return {ok:false,code:"tos_grant_invalid",status:400};
  if(g.version!==terms.version)return {ok:false,code:"tos_changed",status:409};
  if(g.stage!=="read")return {ok:false,code:g.stage==="agreed"?"tos_grant_invalid":"tos_not_read",status:409};
  return {ok:true,grant:sign(["agreed",g.version,g.id,g.readMs,now()]),stage:"agreed",version:g.version};
 }
 // What sign-up checks. {ok:true,id,version,readMs,agreedMs} | {ok:false,code}
 function verifyAgreed(grant){
  if(grant===undefined||grant===null||grant==="")return {ok:false,code:"tos_required"};
  const g=parse(grant);
  if(!g||!fresh(g))return {ok:false,code:"tos_grant_invalid"};
  if(g.version!==terms.version)return {ok:false,code:"tos_changed"};
  if(g.stage!=="agreed")return {ok:false,code:"tos_required"};
  if(!(g.agreedMs>=g.readMs))return {ok:false,code:"tos_grant_invalid"};
  return {ok:true,id:g.id,version:g.version,readMs:g.readMs,agreedMs:g.agreedMs,expiresMs:g.readMs+GRANT_TTL_MS};
 }
 return {terms,read,agree,verifyAgreed};
}
module.exports={loadTerms,createTosGate,TOS_FILE,GRANT_TTL_MS};
