"use strict";
// RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s steps), the profile every authenticator app supports.
const crypto=require("node:crypto");
const ALPHABET="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS=30,DIGITS=6,WINDOW=1;

function base32Encode(bytes){
 let bits=0,value=0,out="";
 for(const byte of bytes){
  value=(value<<8)|byte;bits+=8;
  while(bits>=5){out+=ALPHABET[(value>>>(bits-5))&31];bits-=5;}
 }
 if(bits>0)out+=ALPHABET[(value<<(5-bits))&31];
 return out;
}
function base32Decode(text){
 const clean=String(text).toUpperCase().replace(/[\s=-]/g,"");
 let bits=0,value=0;const out=[];
 for(const ch of clean){
  const idx=ALPHABET.indexOf(ch);
  if(idx<0)throw Error("invalid base32");
  value=(value<<5)|idx;bits+=5;
  if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8;}
 }
 return Buffer.from(out);
}
function generateSecret(){return base32Encode(crypto.randomBytes(20));}
function hotp(secret,counter){
 const key=base32Decode(secret);
 const msg=Buffer.alloc(8);msg.writeBigUInt64BE(BigInt(counter));
 const mac=crypto.createHmac("sha1",key).update(msg).digest();
 const offset=mac[mac.length-1]&15;
 const code=((mac[offset]&127)<<24)|(mac[offset+1]<<16)|(mac[offset+2]<<8)|mac[offset+3];
 return String(code%10**DIGITS).padStart(DIGITS,"0");
}
const stepAt=nowMs=>Math.floor(nowMs/1000/STEP_SECONDS);
function totp(secret,nowMs){return hotp(secret,stepAt(nowMs));}
// Returns the matched step (so the caller can refuse a replay of it) or -1.
function verifyTotp(secret,code,nowMs,{lastStep=-1}={}){
 if(typeof code!=="string"||!/^\d{6}$/.test(code.replace(/\s/g,"")))return -1;
 const c=Buffer.from(code.replace(/\s/g,""));
 const now=stepAt(nowMs);
 for(let delta=-WINDOW;delta<=WINDOW;delta++){
  const step=now+delta;
  if(step<=lastStep)continue;
  if(crypto.timingSafeEqual(Buffer.from(hotp(secret,step)),c))return step;
 }
 return -1;
}
function otpauthUri({secret,account,issuer="Gendragoon"}){
 const label=encodeURIComponent(issuer)+":"+encodeURIComponent(account);
 return "otpauth://totp/"+label+"?secret="+secret+"&issuer="+encodeURIComponent(issuer)+"&algorithm=SHA1&digits="+DIGITS+"&period="+STEP_SECONDS;
}
module.exports={base32Encode,base32Decode,generateSecret,hotp,totp,verifyTotp,otpauthUri,STEP_SECONDS,DIGITS};
