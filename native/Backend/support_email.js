"use strict";
// Support email for GenDragoon: password resets and account notices, sent from support@infected-nation.com.
//
// This matches the sender Rotten Apple uses (racore.EmailSender: one message {to, subject, body} to one address,
// plain text, the support address printed in every message). Rotten Apple's SMTP implementation is being built on
// its audit-fill branch; until both services share it, this module is the GenDragoon-side adapter with the same
// account, message shape and configuration names.
//
// Configuration (all from the environment):
//   SUPPORT_EMAIL_ENABLED=true      mount the password-reset route and send notices
//   SUPPORT_SMTP_HOST               SMTP server host name (required)
//   SUPPORT_SMTP_PORT               587 (STARTTLS, default) or 465 (implicit TLS)
//   SUPPORT_SMTP_SECURE             "starttls" (default) or "tls"
//   SUPPORT_SMTP_USER               login name, default support@infected-nation.com
//   SUPPORT_EMAIL_PASSWORD          the mailbox password. Read here only, kept in a closure, never logged,
//                                   never put in an error message, never written to Firestore.
//   SUPPORT_EMAIL_FROM_NAME         display name, default "Infected Nation Support"
//
// TLS is required: the client refuses to authenticate on a connection that is not encrypted. The only exception
// is allowPlaintextLoopback, which tests use against a fake server on 127.0.0.1.
const net=require("node:net");
const tls=require("node:tls");
const crypto=require("node:crypto");

const SUPPORT_ADDRESS="support@infected-nation.com";
const DEFAULT_FROM_NAME="Infected Nation Support";
const EMAIL_RE=/^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function validAddress(value){return typeof value==="string"&&value.length<=254&&EMAIL_RE.test(value);}
function emailHash(value){return crypto.createHash("sha256").update("gd-email:"+String(value).trim().toLowerCase()).digest("hex").slice(0,16);}

// RFC 2047 for non-ASCII subjects and display names.
function headerText(value){
 const s=String(value).replace(/[\r\n]+/g," ");
 return /^[\x20-\x7e]*$/.test(s)?s:"=?UTF-8?B?"+Buffer.from(s,"utf8").toString("base64")+"?=";
}
function wrap76(b64){return b64.replace(/.{1,76}/g,m=>m+"\r\n");}

// Renders one RFC 5322 message. The body is base64, so no line can start with "." and no header can be injected.
function renderMessage({from,fromName,to,subject,body,date=new Date(),messageId}){
 for(const [k,v] of Object.entries({from,to}))if(!validAddress(v))throw Object.assign(Error("invalid "+k+" address"),{code:"invalid_address"});
 if(typeof subject!=="string"||!subject||subject.length>200)throw Object.assign(Error("invalid subject"),{code:"invalid_message"});
 if(typeof body!=="string"||Buffer.byteLength(body)>256*1024)throw Object.assign(Error("invalid body"),{code:"invalid_message"});
 const id=messageId||"<"+crypto.randomBytes(12).toString("hex")+"@"+from.split("@")[1]+">";
 const name=(fromName||DEFAULT_FROM_NAME).replace(/["\\]/g,"");
 return ["From: \""+headerText(name)+"\" <"+from+">","To: <"+to+">","Subject: "+headerText(subject),"Date: "+date.toUTCString(),
  "Message-ID: "+id,"MIME-Version: 1.0","Content-Type: text/plain; charset=utf-8","Content-Transfer-Encoding: base64","",
  wrap76(Buffer.from(body.replace(/\r?\n/g,"\r\n"),"utf8").toString("base64"))].join("\r\n");
}

// Minimal line-oriented SMTP conversation over a socket. Every reply is checked; any unexpected code ends the
// session. Server replies are kept out of errors once AUTH has started (a broken server could echo input).
function smtpSession(socket,{timeoutMs}){
 let buffer="",waiter=null,closed=false;
 const lines=[];
 const onData=d=>{buffer+=d.toString("utf8");let i;while((i=buffer.indexOf("\r\n"))>=0){lines.push(buffer.slice(0,i));buffer=buffer.slice(i+2);}pump();};
 const onEnd=()=>{closed=true;pump();};
 function attach(s){s.on("data",onData);s.on("end",onEnd);s.on("close",onEnd);s.on("error",onEnd);}
 function detach(s){s.off("data",onData);s.off("end",onEnd);s.off("close",onEnd);s.off("error",onEnd);}
 attach(socket);
 function pump(){
  if(!waiter)return;
  // A reply ends at a line "NNN text" (space, not dash, after the code).
  const end=lines.findIndex(l=>/^\d{3}(?: |$)/.test(l));
  if(end>=0){const reply=lines.splice(0,end+1);const w=waiter;waiter=null;clearTimeout(w.timer);
   w.resolve({code:Number(reply[end].slice(0,3)),lines:reply.map(l=>l.slice(4))});return;}
  if(closed){const w=waiter;waiter=null;clearTimeout(w.timer);w.reject(Object.assign(Error("SMTP connection closed"),{code:"smtp_closed"}));}
 }
 function read(){return new Promise((resolve,reject)=>{
  waiter={resolve,reject,timer:setTimeout(()=>{waiter=null;reject(Object.assign(Error("SMTP timeout"),{code:"smtp_timeout"}));},timeoutMs)};pump();});}
 return {
  read,
  get socket(){return socket;},
  async expect(codes,what){const r=await read();if(!codes.includes(r.code))throw Object.assign(Error("SMTP "+what+" refused ("+r.code+")"),{code:"smtp_refused",smtpCode:r.code});return r;},
  write(line){socket.write(line+"\r\n");},
  swap(next){detach(socket);socket=next;attach(socket);buffer="";lines.length=0;},
 };
}

function createSmtpSender({host,port,secure="starttls",user=SUPPORT_ADDRESS,password,from=SUPPORT_ADDRESS,fromName=DEFAULT_FROM_NAME,
  timeoutMs=20_000,tlsOptions={},allowPlaintextLoopback=false,clientName="gendragoon.local"}={}){
 if(!host||typeof host!=="string")throw Error("SMTP host is required");
 if(typeof password!=="string"||!password)throw Error("SMTP password is required");
 if(secure!=="starttls"&&secure!=="tls")throw Error("SUPPORT_SMTP_SECURE must be starttls or tls");
 const p=Number(port||(secure==="tls"?465:587));
 const plaintextOk=allowPlaintextLoopback&&(host==="127.0.0.1"||host==="::1");
 // Kept only in this closure.
 const secret=password;
 const scrub=msg=>{let m=String(msg||"");for(const v of [secret,Buffer.from(secret).toString("base64"),Buffer.from("\0"+user+"\0"+secret).toString("base64")])m=m.split(v).join("[redacted]");return m;};
 function open(){
  return new Promise((resolve,reject)=>{
   const s=secure==="tls"?tls.connect({host,port:p,servername:host,...tlsOptions}):net.connect({host,port:p});
   const t=setTimeout(()=>{s.destroy();reject(Object.assign(Error("SMTP connect timeout"),{code:"smtp_timeout"}));},timeoutMs);
   s.once(secure==="tls"?"secureConnect":"connect",()=>{clearTimeout(t);resolve(s);});
   s.once("error",e=>{clearTimeout(t);reject(Object.assign(Error("SMTP connect failed"),{code:"smtp_connect",cause:e.code}));});
  });
 }
 async function send({to,subject,body}){
  const message=renderMessage({from,fromName,to,subject,body});
  const socket=await open();
  const c=smtpSession(socket,{timeoutMs});
  let encrypted=secure==="tls";
  try{
   await c.expect([220],"greeting");
   c.write("EHLO "+clientName);let ehlo=await c.expect([250],"EHLO");
   if(!encrypted){
    if(ehlo.lines.some(l=>/^STARTTLS\b/i.test(l))){
     c.write("STARTTLS");await c.expect([220],"STARTTLS");
     const upgraded=await new Promise((resolve,reject)=>{
      const t=tls.connect({socket:c.socket,servername:host,...tlsOptions},()=>resolve(t));t.once("error",()=>reject(Object.assign(Error("STARTTLS failed"),{code:"smtp_tls"})));});
     c.swap(upgraded);encrypted=true;
     c.write("EHLO "+clientName);ehlo=await c.expect([250],"EHLO");
    }else if(!plaintextOk)throw Object.assign(Error("SMTP server does not offer STARTTLS; refusing to send the password in clear"),{code:"smtp_tls_required"});
   }
   const auth=ehlo.lines.find(l=>/^AUTH\b/i.test(l))||"";
   if(/\bPLAIN\b/i.test(auth)){c.write("AUTH PLAIN "+Buffer.from("\0"+user+"\0"+secret).toString("base64"));await c.expect([235],"AUTH");}
   else if(/\bLOGIN\b/i.test(auth)){
    c.write("AUTH LOGIN");await c.expect([334],"AUTH");c.write(Buffer.from(user).toString("base64"));await c.expect([334],"AUTH");
    c.write(Buffer.from(secret).toString("base64"));await c.expect([235],"AUTH");
   }else throw Object.assign(Error("SMTP server offers no supported AUTH method"),{code:"smtp_auth_unsupported"});
   c.write("MAIL FROM:<"+from+">");await c.expect([250],"MAIL FROM");
   c.write("RCPT TO:<"+to+">");await c.expect([250,251],"RCPT TO");
   c.write("DATA");await c.expect([354],"DATA");
   c.socket.write(message+"\r\n.\r\n");await c.expect([250],"message");
   c.write("QUIT");await c.read().catch(()=>{});
   return {accepted:true};
  }catch(e){
   throw Object.assign(Error(scrub(e.message)),{code:e.code||"smtp_failed",smtpCode:e.smtpCode});
  }finally{c.socket.destroy();}
 }
 const sender={send,describe:()=>({host,port:p,secure,user,from})};
 // Keep the password out of util.inspect, JSON and accidental logging of the sender object.
 Object.defineProperty(sender,"toJSON",{value:()=>sender.describe()});
 Object.defineProperty(sender,Symbol.for("nodejs.util.inspect.custom"),{value:()=>"SmtpSender "+JSON.stringify(sender.describe())});
 return sender;
}

// Development and tests. Nothing leaves the process.
function recordingSender(){const sent=[];return {sent,async send(m){renderMessage({from:SUPPORT_ADDRESS,...m});sent.push({...m});return {accepted:true};}};}

function senderFromEnv(env=process.env){
 if(env.SUPPORT_EMAIL_ENABLED!=="true")return null;
 const password=env.SUPPORT_EMAIL_PASSWORD;
 if(!env.SUPPORT_SMTP_HOST||!password)throw Error("SUPPORT_EMAIL_ENABLED=true needs SUPPORT_SMTP_HOST and SUPPORT_EMAIL_PASSWORD");
 return createSmtpSender({host:env.SUPPORT_SMTP_HOST,port:env.SUPPORT_SMTP_PORT,secure:env.SUPPORT_SMTP_SECURE||"starttls",
  user:env.SUPPORT_SMTP_USER||SUPPORT_ADDRESS,password,fromName:env.SUPPORT_EMAIL_FROM_NAME||DEFAULT_FROM_NAME});
}

// ---- messages -----------------------------------------------------------------------------------------------------
const FOOTER="\n\nQuestions: "+SUPPORT_ADDRESS+"\nGenDragoon Cloud SSD, Infected Nation\n";
function clientLabel(c){const n=String(c?.name||"An app").slice(0,80);return c?.host?n+" ("+String(c.host).slice(0,120)+")":n;}
const TEMPLATES={
 "password.reset":d=>({subject:"Reset your GenDragoon password",
  body:"We received a request to reset the password for this GenDragoon account.\n\nReset it here (the link expires in one hour and works once):\n"+d.link+
   "\n\nIf you did not ask for this, ignore this email. Your password stays the same."}),
 "provider.connected":d=>({subject:"An app was connected to your GenDragoon storage",
  body:clientLabel(d.client)+" can now store data in one of your GenDragoon workspaces.\n\nIf you did not do this, open GenDragoon, go to Connected apps and revoke it."}),
 "provider.revoked":d=>({subject:"An app was disconnected from your GenDragoon storage",
  body:clientLabel(d.client)+" no longer has access to your GenDragoon storage."+(d.dataDeleted?" The data it stored was deleted.":" The data it stored was kept.")}),
};
function renderNotice(kind,details={}){
 const t=TEMPLATES[kind];if(!t)throw Object.assign(Error("unknown notice"),{code:"unknown_notice"});
 const m=t(details);return {subject:m.subject,body:m.body+FOOTER};
}

// notify(uid, kind, details): resolves the address through Firebase Auth at send time (no address is stored).
function createNotifier({sender,adminAuth,log=()=>{}}){
 return async function notify(uid,kind,details={}){
  if(!sender||!adminAuth||!uid)return {sent:false,reason:"not_configured"};
  let email;try{email=(await adminAuth.getUser(uid)).email;}catch(_){return {sent:false,reason:"no_user"};}
  if(!validAddress(email))return {sent:false,reason:"no_address"};
  const m=renderNotice(kind,details);
  try{await sender.send({to:email,...m});log("notice.sent",{kind,to:emailHash(email)});return {sent:true};}
  catch(e){log("notice.failed",{kind,to:emailHash(email),code:e.code||"error"});return {sent:false,reason:"send_failed"};}
 };
}

// POST /v1/auth/password-reset {email}. Always 202 with the same body, whether or not the account exists, so the
// route cannot be used to find accounts. Firebase generates the one-time link; this server only delivers it.
function registerPasswordReset({app,adminAuth,sender,continueUrl,now=Date.now,log=()=>{},limits={},path="/v1/auth/password-reset"}){
 if(!app||!adminAuth||!sender)throw Error("registerPasswordReset needs app, adminAuth and sender");
 const L={perIpPer10Min:10,perEmailPerHour:3,...limits};
 const hits=new Map();
 function limited(key,max,windowMs){
  const t=now(),list=(hits.get(key)||[]).filter(x=>x>t-windowMs);
  if(list.length>=max){hits.set(key,list);return true;}
  list.push(t);hits.set(key,list);
  if(hits.size>50_000)for(const [k,v] of hits)if(!v.length||v.at(-1)<t-3_600_000)hits.delete(k);
  return false;
 }
 const express=require("express");
 app.post(path,express.json({limit:"2kb"}),async(req,res)=>{
  const email=typeof req.body?.email==="string"?req.body.email.trim():"";
  if(!validAddress(email))return res.status(400).json({error:"invalid_email"});
  if(limited("ip:"+(req.ip||"?"),L.perIpPer10Min,600_000)){res.set("Retry-After","600");return res.status(429).json({error:"rate_limited"});}
  res.status(202).json({ok:true,message:"If an account uses this address, a reset link is on its way."});
  if(limited("em:"+emailHash(email),L.perEmailPerHour,3_600_000)){log("password_reset.throttled",{to:emailHash(email)});return;}
  let link;
  try{link=await adminAuth.generatePasswordResetLink(email,continueUrl?{url:continueUrl}:undefined);}
  catch(e){log("password_reset.no_link",{to:emailHash(email),code:String(e?.code||e?.errorInfo?.code||"error")});return;}
  try{await sender.send({to:email,...renderNotice("password.reset",{link})});log("password_reset.sent",{to:emailHash(email)});}
  catch(e){log("password_reset.failed",{to:emailHash(email),code:e.code||"error"});}
 });
}

module.exports={SUPPORT_ADDRESS,createSmtpSender,recordingSender,senderFromEnv,renderMessage,renderNotice,createNotifier,
 registerPasswordReset,validAddress,emailHash};
