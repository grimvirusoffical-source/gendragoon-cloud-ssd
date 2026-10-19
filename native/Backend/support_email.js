"use strict";
// Support email for GenDragoon: password resets and account notices from support@infected-nation.com.
//
// This is the Node port of Rotten Apple's shared sender, package `rottenapple/mailer` (docs/EMAIL.md on the
// Rotten Apple audit-fill branch). It keeps the same interface and rules so both products behave the same and
// either can move to one shared relay later:
//   * Config has no password field. The password is read from the environment variable named by
//     config.passwordEnv (default SUPPORT_EMAIL_PASSWORD) at send time, and is scrubbed from every error.
//   * TLS always: "starttls" (587) refuses a server without STARTTLS, "tls" (465) is implicit TLS; certificates
//     are verified, TLS 1.2 minimum, no plaintext mode. AUTH PLAIN is sent only after TLS.
//   * One plain address per message; CR/LF, several recipients or display-name forms are refused (ErrBadMessage).
//     Subjects are RFC 2047 Q-encoded, bodies quoted-printable, "Auto-Submitted: auto-generated".
//   * Rate limits: 5 per recipient per hour and 60 per minute overall by default (ErrRateLimited). The recipient
//     key folds case, Gmail dots and "+tag" (recipientKey), so address variants share one budget.
//   * Every attempt is recorded to an event log: sent, bounced (permanent 5xx), error, rate_limited, refused;
//     recipients masked (s******@example.com) plus a short hash; no bodies, no password.
//   * Templates: the same built-ins (password_reset, email_verify, twofa_setup_link, moderation_notice,
//     appeal_update, test); GenDragoon replaces password_reset (Firebase issues a link, not a code) and adds
//     provider_connected and provider_revoked with templates.add.
const net=require("node:net");
const tls=require("node:tls");
const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");

const DEFAULT_PASSWORD_ENV="SUPPORT_EMAIL_PASSWORD";
const SUPPORT_ADDRESS="support@infected-nation.com";

function mailerError(name,message){const e=new Error(message);e.code=name;return e;}
const ErrRateLimited=()=>mailerError("ErrRateLimited","mailer: rate limit reached, message not sent");
const ErrNoPassword=()=>mailerError("ErrNoPassword","mailer: the SMTP password environment variable is not set");
const ErrBadMessage=detail=>mailerError("ErrBadMessage","mailer: refused message"+(detail?": "+detail:""));
const ErrNoTLS=()=>mailerError("ErrNoTLS","mailer: the server does not offer STARTTLS; refusing to send without TLS");
class Bounce extends Error{constructor(code,msg){super("mailer: rejected by the server ("+code+"): "+msg);this.code="Bounce";this.smtpCode=code;this.smtpMsg=msg;}}

// Same settings as mailer.DefaultInfectedNation(): Google Workspace submission for support@infected-nation.com
// (the password is a Google app password for that mailbox).
function defaultInfectedNation(){
 return {host:"smtp.gmail.com",port:587,security:"starttls",username:SUPPORT_ADDRESS,from:SUPPORT_ADDRESS,fromName:"Infected Nation Support"};
}

function mask(addr){const at=String(addr).lastIndexOf("@");return at<=0?"***":addr[0]+"*".repeat(at-1)+addr.slice(at);}
function hashAddr(a){return crypto.createHash("sha256").update(String(a).trim().toLowerCase()).digest("hex").slice(0,16);}

// Strict single address: local@domain, nothing else.
const ADDRESS=/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
function validAddress(a){return typeof a==="string"&&a.length<=254&&ADDRESS.test(a)&&!/\.\.|^\.|\.@/.test(a);}

// RFC 2047 encoded-words, byte for byte what Go's mime.QEncoding.Encode("utf-8", s) and
// mime.BEncoding.Encode produce. Text that is printable ASCII (or tab) is returned as is. Otherwise each
// encoded-word is at most 75 characters ("=?utf-8?q?" + at most 63 + "?="); words are joined by a single
// space (folded by the header writer) and a multi-byte character is never split between two words.
const WORD_OPEN={q:"=?utf-8?q?",b:"=?utf-8?b?"},WORD_CLOSE="?=",MAX_WORD_CONTENT=75-"=?UTF-8?q?".length-WORD_CLOSE.length;
const needsEncoding=s=>/[^\t\x20-\x7e]/.test(s);
// One code point at a time as UTF-8 (a lone surrogate becomes U+FFFD, as Go writes invalid UTF-8 as is).
const runes=s=>Array.from(s,ch=>Buffer.from(ch,"utf8"));
function qWord(bytes){let out="";
 for(const b of bytes)out+=b===0x20?"_":(b>=0x21&&b<=0x7e&&b!==0x3d&&b!==0x3f&&b!==0x5f)?String.fromCharCode(b):"="+b.toString(16).toUpperCase().padStart(2,"0");
 return out;}
function qEncode(s){
 if(!needsEncoding(s))return s;
 const words=[];let cur="",len=0;
 for(const r of runes(s)){
  const literal=r.length===1&&r[0]>=0x20&&r[0]<=0x7e&&r[0]!==0x3d&&r[0]!==0x3f&&r[0]!==0x5f;
  const n=literal?1:3*r.length;
  if(len+n>MAX_WORD_CONTENT){words.push(cur);cur="";len=0;}
  cur+=qWord(r);len+=n;
 }
 words.push(cur);
 return words.map(w=>WORD_OPEN.q+w+WORD_CLOSE).join(" ");
}
function bEncode(s){
 if(!needsEncoding(s))return s;
 const all=Buffer.from(s,"utf8");
 if(Math.ceil(all.length/3)*4<=MAX_WORD_CONTENT)return WORD_OPEN.b+all.toString("base64")+WORD_CLOSE;
 const maxBytes=Math.floor(MAX_WORD_CONTENT/4)*3,words=[];let cur=[],len=0;
 for(const r of runes(s)){
  if(len+r.length>maxBytes){words.push(Buffer.concat(cur));cur=[];len=0;}
  cur.push(r);len+=r.length;
 }
 words.push(Buffer.concat(cur));
 return words.map(w=>WORD_OPEN.b+w.toString("base64")+WORD_CLOSE).join(" ");
}
// The From header as Go's (&mail.Address{Name, Address}).String() writes it.
function formatAddress(name,addr){
 if(!name)return "<"+addr+">";
 if(/^[\t\x20-\x7e]*$/.test(name))return "\""+name.replace(/["\\]/g,m=>"\\"+m)+"\" <"+addr+">";
 if(/["#$%&'(),.:;<>@[\]^`{|}~]/.test(name))return bEncode(name)+" <"+addr+">";
 return qEncode(name)+" <"+addr+">";
}
// Header lines longer than 78 characters are folded at the spaces between encoded-words (RFC 5322 2.2.3). The
// first word stays on the header's own line ("Subject: =?utf-8?q?...?=" is at most 9 + 75 characters).
function foldHeader(line){
 if(line.length<=78||!line.includes(" "))return line;
 const parts=line.split(" ");let out=parts.shift()+" "+parts.shift(),cur=out.length;
 for(const p of parts){if(cur+1+p.length>78){out+="\r\n "+p;cur=1+p.length;}else{out+=" "+p;cur+=1+p.length;}}
 return out;
}
// The key the per-recipient limits count on: lower case; for Gmail (gmail.com, googlemail.com) dots and a
// "+tag" in the local part are dropped and the domain is gmail.com; for other domains a "+tag" is dropped.
// So v.ictim@gmail.com, victim+1@gmail.com and VICTIM@googlemail.com share one budget.
function recipientKey(addr){
 const a=String(addr||"").trim().toLowerCase(),at=a.lastIndexOf("@");
 if(at<=0)return a;
 let local=a.slice(0,at),domain=a.slice(at+1);
 const plus=local.indexOf("+");if(plus>0)local=local.slice(0,plus);
 if(domain==="gmail.com"||domain==="googlemail.com"){local=local.replace(/\./g,"");domain="gmail.com";}
 return local+"@"+domain;
}
// Quoted-printable (RFC 2045), CRLF line breaks, soft breaks at 76.
function quotedPrintable(text){
 const lines=text.split("\r\n"),out=[];
 for(const line of lines){
  const bytes=Buffer.from(line,"utf8");let cur="";
  for(let i=0;i<bytes.length;i++){
   const b=bytes[i],last=i===bytes.length-1;
   let t=(b>=33&&b<=126&&b!==61)||((b===32||b===9)&&!last)?String.fromCharCode(b):"="+b.toString(16).toUpperCase().padStart(2,"0");
   if(cur.length+t.length>75){out.push(cur+"=");cur="";}
   cur+=t;
  }
  out.push(cur);
 }
 return out.join("\r\n");
}

// ---- event logs ---------------------------------------------------------------------------------------------
function memLog(){const list=[];return {record:e=>list.push({...e}),events:()=>list.map(e=>({...e}))};}
function fileLog(file){
 fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
 return {record(e){try{fs.appendFileSync(file,JSON.stringify(e)+"\n",{mode:0o600});}catch(_){}}};
}

// ---- mailer ---------------------------------------------------------------------------------------------------
function createMailer(cfgIn,{log=null,now=()=>Date.now(),env=process.env,tlsOptions={},connect=null}={}){
 const cfg={...cfgIn};
 if(Object.hasOwn(cfg,"password"))throw new Error("mailer: config has no password field; set "+(cfg.passwordEnv||DEFAULT_PASSWORD_ENV));
 if(!cfg.host||/[\s/]/.test(cfg.host))throw new Error("mailer: host is required");
 if(!cfg.security||cfg.security==="starttls"){cfg.security="starttls";cfg.port=Number(cfg.port||587);}
 else if(cfg.security==="tls")cfg.port=Number(cfg.port||465);
 else throw new Error("mailer: security must be starttls or tls (there is no plaintext mode), got \""+cfg.security+"\"");
 if(!validAddress(cfg.from))throw new Error("mailer: from must be a plain address");
 if(/[\r\n]/.test(cfg.fromName||""))throw new Error("mailer: bad from name");
 cfg.username=cfg.username||cfg.from;
 cfg.passwordEnv=cfg.passwordEnv||DEFAULT_PASSWORD_ENV;
 cfg.helloName=cfg.helloName||"localhost";
 cfg.timeoutMs=cfg.timeoutMs||30_000;
 cfg.perRecipientPerHour=cfg.perRecipientPerHour||5;
 cfg.perMinute=cfg.perMinute||60;
 const perTo=new Map();let global=[];
 const scrub=s=>{let t=String(s||"");const pw=env[cfg.passwordEnv];
  if(pw&&pw.length>=4)for(const v of [pw,Buffer.from("\0"+cfg.username+"\0"+pw).toString("base64")])t=t.split(v).join("[redacted]");return t;};
 function record(msg,status,code,err){
  if(!log)return;
  const e={atMs:now(),to:mask(msg.to||""),toHash:hashAddr(msg.to||""),status};
  if(msg.template)e.template=msg.template;if(code)e.code=code;if(err)e.error=scrub(err.message||err);
  log.record(e);
 }
 function allow(to){
  const t=now(),key=recipientKey(to);
  const list=(perTo.get(key)||[]).filter(x=>t-x<3_600_000);global=global.filter(x=>t-x<60_000);
  if(cfg.perRecipientPerHour>0&&list.length>=cfg.perRecipientPerHour){perTo.set(key,list);return false;}
  if(cfg.perMinute>0&&global.length>=cfg.perMinute){perTo.set(key,list);return false;}
  list.push(t);global.push(t);perTo.set(key,list);return true;
 }
 function build(msg){
  if(typeof msg.to!=="string"||/[\r\n<>,;]/.test(msg.to)||typeof msg.subject!=="string"||/[\r\n]/.test(msg.subject))throw ErrBadMessage();
  if(!validAddress(msg.to.trim())||msg.to.trim()!==msg.to)throw ErrBadMessage("not a single plain address");
  if(typeof msg.body!=="string"||Buffer.byteLength(msg.body)>256*1024||msg.subject.length>300)throw ErrBadMessage("too long");
  const domain=cfg.from.slice(cfg.from.lastIndexOf("@")+1);
  const from=formatAddress(cfg.fromName||"",cfg.from);
  const hdr=[["From",from],["To",msg.to],["Subject",qEncode(msg.subject)],["Date",new Date(now()).toUTCString().replace("GMT","+0000")],
   ["Message-ID","<"+crypto.randomBytes(12).toString("hex")+"@"+domain+">"],["MIME-Version","1.0"],["Content-Type","text/plain; charset=utf-8"],
   ["Content-Transfer-Encoding","quoted-printable"],["Auto-Submitted","auto-generated"]];
  const body=msg.body.replace(/\r\n/g,"\n").replace(/\n/g,"\r\n");
  return hdr.map(([k,v])=>foldHeader(k+": "+v)).join("\r\n")+"\r\n\r\n"+quotedPrintable(body);
 }
 function open(){
  return new Promise((resolve,reject)=>{
   const opts={host:cfg.host,port:cfg.port,servername:cfg.host,minVersion:"TLSv1.2",...tlsOptions};
   const s=connect?connect(cfg):cfg.security==="tls"?tls.connect(opts):net.connect({host:cfg.host,port:cfg.port});
   const ev=cfg.security==="tls"&&!connect?"secureConnect":"connect";
   const timer=setTimeout(()=>{s.destroy();reject(new Error("mailer: connect timeout"));},cfg.timeoutMs);
   s.once(ev,()=>{clearTimeout(timer);resolve(s);});
   s.once("error",e=>{clearTimeout(timer);reject(new Error("mailer: dial: "+(e.code||e.message)));});
  });
 }
 // One SMTP conversation. Replies are parsed line by line; a 5xx after MAIL/RCPT/DATA is a Bounce.
 async function deliver(to,raw,pw){
  let socket=await open(),buffer="",lines=[],waiter=null,closed=false,isTLS=cfg.security==="tls";
  const deadline=setTimeout(()=>socket.destroy(),cfg.timeoutMs);
  const onData=d=>{buffer+=d.toString("utf8");let i;while((i=buffer.indexOf("\r\n"))>=0){lines.push(buffer.slice(0,i));buffer=buffer.slice(i+2);}pump();};
  const onEnd=()=>{closed=true;pump();};
  const attach=s=>{s.on("data",onData);s.on("end",onEnd);s.on("close",onEnd);s.on("error",onEnd);};
  const detach=s=>{s.off("data",onData);s.off("end",onEnd);s.off("close",onEnd);s.off("error",onEnd);};
  function pump(){if(!waiter)return;const end=lines.findIndex(l=>/^\d{3}(?: |$)/.test(l));
   if(end>=0){const r=lines.splice(0,end+1);const w=waiter;waiter=null;w.resolve({code:Number(r[end].slice(0,3)),lines:r.map(l=>l.slice(4))});}
   else if(closed){const w=waiter;waiter=null;w.reject(new Error("mailer: connection closed"));}}
  const read=()=>new Promise((resolve,reject)=>{waiter={resolve,reject};pump();});
  const write=l=>socket.write(l+"\r\n");
  const expect=async(codes,what,bounces=false)=>{const r=await read();if(codes.includes(r.code))return r;
   if(bounces&&r.code>=500&&r.code<600)throw new Bounce(r.code,r.lines.join(" "));
   throw Object.assign(new Error("mailer: "+what+": "+r.code+" "+r.lines.join(" ")),{smtpCode:r.code});};
  attach(socket);
  try{
   await expect([220],"greeting");
   write("EHLO "+cfg.helloName);let ehlo=await expect([250],"EHLO");
   if(cfg.security==="starttls"){
    if(!ehlo.lines.some(l=>/^STARTTLS\b/i.test(l)))throw ErrNoTLS();
    write("STARTTLS");await expect([220],"STARTTLS");
    detach(socket);
    socket=await new Promise((resolve,reject)=>{const t=tls.connect({socket,servername:cfg.host,minVersion:"TLSv1.2",...tlsOptions},()=>resolve(t));
     t.once("error",e=>reject(new Error("mailer: STARTTLS: "+(e.code||e.message))));});
    isTLS=true;buffer="";lines=[];attach(socket);
    write("EHLO "+cfg.helloName);ehlo=await expect([250],"EHLO");
   }
   if(!isTLS||!socket.encrypted)throw ErrNoTLS();
   if(!ehlo.lines.some(l=>/^AUTH\b/i.test(l)))throw new Error("mailer: the server offers no AUTH after TLS");
   write("AUTH PLAIN "+Buffer.from("\0"+cfg.username+"\0"+pw).toString("base64"));
   const auth=await read();if(auth.code!==235)throw new Error("mailer: sign-in to the SMTP server failed: "+auth.code);
   write("MAIL FROM:<"+cfg.from+">");await expect([250],"MAIL",true);
   write("RCPT TO:<"+to+">");await expect([250,251],"RCPT",true);
   write("DATA");await expect([354],"DATA",true);
   socket.write(raw.replace(/^\./gm,"..")+"\r\n.\r\n");await expect([250],"message",true);
   write("QUIT");await read().catch(()=>{});
  }finally{clearTimeout(deadline);socket.destroy();}
 }
 async function send(msg){
  let raw;
  try{raw=build(msg);}catch(e){record(msg,"refused",0,e);throw e;}
  if(!allow(msg.to)){record(msg,"rate_limited",0,null);throw ErrRateLimited();}
  const pw=env[cfg.passwordEnv];
  if(!pw){const e=ErrNoPassword();record(msg,"error",0,e);throw e;}
  try{await deliver(msg.to,raw,pw);record(msg,"sent",250,null);}
  catch(e){
   if(e instanceof Bounce){record(msg,"bounced",e.smtpCode,e);throw new Bounce(e.smtpCode,scrub(e.smtpMsg));}
   const clean=mailerError(e.code||"error",scrub(e.message));record(msg,"error",e.smtpCode||0,clean);throw clean;
  }
 }
 const mailer={send,build,config:()=>({...cfg})};
 return mailer;
}

// Development sender: writes the message to a log function and sends nothing (mailer.LogSender).
function logSender(logf){return {async send(m){if(!logf)throw new Error("log sender has no log function");logf("DEV EMAIL - NOT SENT to="+m.to+" subject="+JSON.stringify(m.subject)+"\n"+m.body);}};}
// Tests.
function recordingSender(){const sent=[];return {sent,async send(m){sent.push({...m});}};}

// ---- templates (mailer.Templates) -------------------------------------------------------------------------------
const BUILTINS={
 password_reset:["Reset your {{.Product}} password",
  "Someone (hopefully you) asked to reset the password of your {{.Product}} account.\n\nYour code: {{.Code}}\nIt works once and expires in {{.MinutesValid}} minutes.\n\nIf this was not you, ignore this message; your password has not changed.\n\nQuestions: {{.Support}}\n"],
 email_verify:["Confirm your email for {{.Product}}","Your confirmation code: {{.Code}}\nIt works once and expires in {{.MinutesValid}} minutes.\n\nQuestions: {{.Support}}\n"],
 twofa_setup_link:["Set up your authenticator app for {{.Product}}",
  "You asked to set up an authenticator app after signing in with your password.\n\nOpen this link to continue (it works once and expires in {{.MinutesValid}} minutes):\n{{.Link}}\n\nIf this was not you, do not open it: change your password and write to {{.Support}}.\n"],
 moderation_notice:["A notice about your {{.Product}} account ({{.Reference}})",
  "{{.Detail}}\n\nReason: {{.Reason}}\nReference: {{.Reference}}\n\nIf you think this is a mistake you can appeal: {{.AppealURL}}\nOr write to {{.Support}} and quote the reference.\n"],
 appeal_update:["Your appeal {{.Reference}} was updated","{{.Detail}}\n\nReference: {{.Reference}}\nQuestions: {{.Support}}\n"],
 test:["{{.Product}} email test","This is a single test message from the {{.Product}} mailer, sent to confirm that SMTP sign-in and TLS work.\n{{.Detail}}\n"],
};
// GenDragoon's additions and replacement (Firebase issues a one-time link rather than a code).
const GENDRAGOON={
 password_reset:["Reset your {{.Product}} password",
  "Someone (hopefully you) asked to reset the password of your {{.Product}} account.\n\nReset it here (the link works once and expires in {{.MinutesValid}} minutes):\n{{.Link}}\n\nIf this was not you, ignore this message; your password has not changed.\n\nQuestions: {{.Support}}\n"],
 provider_connected:["An app was connected to your {{.Product}} storage",
  "{{.Detail}} can now store data in one of your {{.Product}} workspaces.\n\nIf this was not you, open {{.Product}}, go to Connected apps and revoke it.\n\nQuestions: {{.Support}}\n"],
 provider_revoked:["An app was disconnected from your {{.Product}} storage",
  "{{.Detail}} no longer has access to your {{.Product}} storage. {{.Reason}}\n\nQuestions: {{.Support}}\n"],
};
// The Go templates only use {{.Field}}; this renders exactly that form and errors on a missing field
// (text/template "missingkey=error").
function compile(src){
 if(/\{\{(?!\.[A-Za-z]+\}\})/.test(src))throw new Error("mailer: only {{.Field}} placeholders are supported");
 return data=>src.replace(/\{\{\.([A-Za-z]+)\}\}/g,(_,k)=>{if(!data||!Object.hasOwn(data,k))throw new Error("mailer: missing template field "+k);return String(data[k]);});
}
function templates(){
 const t=new Map();
 const api={
  add(name,subject,body){t.set(name,[compile(subject),compile(body)]);return api;},
  render(name,to,data){const e=t.get(name);if(!e)throw new Error("mailer: no template \""+name+"\"");
   const subject=e[0](data);if(/[\r\n]/.test(subject))throw ErrBadMessage();
   return {to,subject,body:e[1](data),template:name};},
  names:()=>[...t.keys()].sort(),
 };
 for(const [k,[s,b]] of Object.entries(BUILTINS))api.add(k,s,b);
 return api;
}
function gendragoonTemplates(){const t=templates();for(const [k,[s,b]] of Object.entries(GENDRAGOON))t.add(k,s,b);return t;}
const BASE_DATA={Product:"GenDragoon",Support:SUPPORT_ADDRESS};

// SUPPORT_EMAIL_ENABLED=true builds the real mailer (host from SUPPORT_SMTP_HOST, default smtp.gmail.com) and,
// like `ra-core serve --smtp-host`, refuses to start when the password variable is missing.
function senderFromEnv(env=process.env,opts={}){
 if(env.SUPPORT_EMAIL_ENABLED!=="true")return null;
 const cfg={...defaultInfectedNation()};
 if(env.SUPPORT_SMTP_HOST)cfg.host=env.SUPPORT_SMTP_HOST;
 if(env.SUPPORT_SMTP_PORT)cfg.port=Number(env.SUPPORT_SMTP_PORT);
 if(env.SUPPORT_SMTP_SECURITY)cfg.security=env.SUPPORT_SMTP_SECURITY;
 if(env.SUPPORT_SMTP_USER)cfg.username=env.SUPPORT_SMTP_USER;
 if(env.SUPPORT_EMAIL_FROM_NAME)cfg.fromName=env.SUPPORT_EMAIL_FROM_NAME;
 cfg.passwordEnv=env.SUPPORT_EMAIL_PASSWORD_ENV||DEFAULT_PASSWORD_ENV;
 if(!env[cfg.passwordEnv])throw new Error("SUPPORT_EMAIL_ENABLED=true needs "+cfg.passwordEnv);
 const log=env.SUPPORT_EMAIL_LOG?fileLog(env.SUPPORT_EMAIL_LOG):(opts.log||null);
 return createMailer(cfg,{log,env});
}

// ---- notices ----------------------------------------------------------------------------------------------------
function clientLabel(c){const n=String(c?.name||"An app").replace(/[\r\n]/g," ").slice(0,80);return c?.host?n+" ("+String(c.host).replace(/[\r\n]/g," ").slice(0,120)+")":n;}
// notify(uid, kind, details): resolves the address through Firebase Auth at send time (nothing is stored).
function createNotifier({sender,adminAuth,templates:tpl=gendragoonTemplates(),log=()=>{}}){
 const kinds={
  "provider.connected":d=>["provider_connected",{Detail:clientLabel(d.client)}],
  "provider.revoked":d=>["provider_revoked",{Detail:clientLabel(d.client),Reason:d.dataDeleted?"The data it stored was deleted.":"The data it stored was kept."}],
 };
 return async function notify(uid,kind,details={}){
  if(!sender||!adminAuth||!uid||!kinds[kind])return {sent:false,reason:"not_configured"};
  let email;try{email=(await adminAuth.getUser(uid)).email;}catch(_){return {sent:false,reason:"no_user"};}
  if(!validAddress(email))return {sent:false,reason:"no_address"};
  const [name,data]=kinds[kind](details);
  try{await sender.send(tpl.render(name,email,{...BASE_DATA,...data}));log("notice.sent",{kind,toHash:hashAddr(email)});return {sent:true};}
  catch(e){log("notice.failed",{kind,toHash:hashAddr(email),code:e.code||"error"});return {sent:false,reason:"send_failed"};}
 };
}

// POST /v1/auth/password-reset {email}: always 202 with the same body, whether or not the account exists.
// Firebase generates the one-time link. Two limits apply before a link is generated:
//   * per client IP (req.ip; the app must set "trust proxy" to the real proxy hop count, see free_server.js):
//     perIpPer10Min (10) requests, then 429 with Retry-After;
//   * per address (recipientKey: case, Gmail dots and "+tag" folded): perEmailPerHour (5) requests. Over it
//     the answer is the same 202, so the limit reveals nothing about the address, and no link is generated.
// The mailer's own per-recipient limit (5 per hour, same key) still applies to the send.
function registerPasswordReset({app,adminAuth,sender,templates:tpl=gendragoonTemplates(),continueUrl,now=Date.now,log=()=>{},
  limits={},path:routePath="/v1/auth/password-reset"}){
 if(!app||!adminAuth||!sender)throw Error("registerPasswordReset needs app, adminAuth and sender");
 const L={perIpPer10Min:10,perEmailPerHour:5,...limits};
 const hits=new Map();
 const limited=(key,max,windowMs)=>{const t=now(),list=(hits.get(key)||[]).filter(x=>x>t-windowMs);
  if(list.length>=max){hits.set(key,list);return true;}list.push(t);hits.set(key,list);
  if(hits.size>50_000)for(const [k,v] of hits)if(!v.length||v.at(-1)<t-3_600_000)hits.delete(k);return false;};
 const express=require("express");
 app.post(routePath,express.json({limit:"2kb"}),async(req,res)=>{
  const email=typeof req.body?.email==="string"?req.body.email.trim():"";
  if(!validAddress(email))return res.status(400).json({error:"invalid_email"});
  if(limited("ip:"+(req.ip||"?"),L.perIpPer10Min,600_000)){res.set("Retry-After","600");return res.status(429).json({error:"rate_limited"});}
  res.status(202).json({ok:true,message:"If an account uses this address, a reset link is on its way."});
  if(limited("to:"+recipientKey(email),L.perEmailPerHour,3_600_000)){log("password_reset.limited",{toHash:hashAddr(recipientKey(email))});return;}
  let link;
  try{link=await adminAuth.generatePasswordResetLink(email,continueUrl?{url:continueUrl}:undefined);}
  catch(e){log("password_reset.no_link",{toHash:hashAddr(email),code:String(e?.code||e?.errorInfo?.code||"error")});return;}
  try{await sender.send(tpl.render("password_reset",email,{...BASE_DATA,Link:link,MinutesValid:60}));log("password_reset.sent",{toHash:hashAddr(email)});}
  catch(e){log("password_reset.failed",{toHash:hashAddr(email),code:e.code||"error"});}
 });
}

module.exports={DEFAULT_PASSWORD_ENV,SUPPORT_ADDRESS,defaultInfectedNation,createMailer,memLog,fileLog,logSender,recordingSender,
 templates,gendragoonTemplates,senderFromEnv,createNotifier,registerPasswordReset,mask,hashAddr,validAddress,quotedPrintable,qEncode,bEncode,
 formatAddress,foldHeader,recipientKey,Bounce};
