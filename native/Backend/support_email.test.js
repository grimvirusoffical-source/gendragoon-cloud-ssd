"use strict";
// Support email: SMTP client against an in-process fake server on 127.0.0.1 (no real mail is sent), the
// password-reset route and account notices with a recording sender.
const test=require("node:test");
const assert=require("node:assert/strict");
const net=require("node:net");
const tls=require("node:tls");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const util=require("node:util");
const {execFileSync}=require("node:child_process");
const express=require("express");
const mail=require("./support_email");

const PASSWORD="s3cret-Pa55word!";

function selfSigned(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gd-smtp-"));
 try{execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",path.join(dir,"k.pem"),"-out",path.join(dir,"c.pem"),
  "-days","1","-subj","/CN=127.0.0.1","-addext","subjectAltName=IP:127.0.0.1"],{stdio:"ignore"});}catch(_){return null;}
 return {key:fs.readFileSync(path.join(dir,"k.pem")),cert:fs.readFileSync(path.join(dir,"c.pem"))};
}
const CERT=selfSigned();

// mode: "plain" (no STARTTLS offered), "starttls", "tls"; auth: "PLAIN" | "LOGIN"
function fakeSmtp({mode="starttls",auth="PLAIN",rejectAuth=false,echoAuth=false}={}){
 const sessions=[];
 function start(socket,secure){
  const s={lines:[],data:"",secure,authed:false,tlsAtAuth:null};sessions.push(s);
  let inData=false,buf="",loginStep=0,sock=socket;
  const say=l=>sock.write(l+"\r\n");
  const ehlo=()=>{const caps=["250-fake.test"];if(mode==="starttls"&&!s.secure)caps.push("250-STARTTLS");caps.push("250 AUTH "+auth);caps.forEach(say);};
  function onData(d){
   buf+=d.toString();
   let i;
   while((i=buf.indexOf("\r\n"))>=0){
    const line=buf.slice(0,i);buf=buf.slice(i+2);
    if(inData){if(line==="."){inData=false;say("250 queued");}else s.data+=line+"\r\n";continue;}
    s.lines.push(line);
    if(loginStep===1){loginStep=2;say("334 UGFzc3dvcmQ6");continue;}
    if(loginStep===2){loginStep=0;s.authed=!rejectAuth;s.tlsAtAuth=s.secure;say(rejectAuth?"535 bad":"235 ok");continue;}
    if(/^EHLO/.test(line))ehlo();
    else if(line==="STARTTLS"){
     say("220 go");sock.off("data",onData);
     const t=new tls.TLSSocket(sock,{isServer:true,key:CERT.key,cert:CERT.cert});
     t.on("secure",()=>{s.secure=true;});t.on("data",onData);t.on("error",()=>{});sock=t;return;
    }
    else if(/^AUTH PLAIN /.test(line)){s.authed=!rejectAuth;s.tlsAtAuth=s.secure;say(rejectAuth?(echoAuth?"535 bad "+line:"535 bad"):"235 ok");}
    else if(line==="AUTH LOGIN"){loginStep=1;say("334 VXNlcm5hbWU6");}
    else if(/^MAIL FROM/.test(line)||/^RCPT TO/.test(line))say(s.authed?"250 ok":"530 auth first");
    else if(line==="DATA"){inData=true;say("354 go");}
    else if(line==="QUIT"){say("221 bye");sock.end();}
    else say("500 ?");
   }
  }
  sock.on("data",onData);sock.on("error",()=>{});
  say("220 fake.test ESMTP");
 }
 const server=mode==="tls"?tls.createServer({key:CERT.key,cert:CERT.cert},c=>start(c,true)):net.createServer(c=>start(c,false));
 return new Promise(r=>server.listen(0,"127.0.0.1",()=>r({port:server.address().port,sessions,close:()=>server.close()})));
}
const trust=()=>({ca:CERT.cert});
const decodeBody=data=>Buffer.from(data.split("\r\n\r\n").slice(1).join("").replace(/\r\n/g,""),"base64").toString("utf8");

test("STARTTLS + AUTH PLAIN: authenticates only after TLS, renders a clean message",{skip:!CERT&&"openssl not available"},async()=>{
 const srv=await fakeSmtp({mode:"starttls"});
 try{
  const sender=mail.createSmtpSender({host:"127.0.0.1",port:srv.port,password:PASSWORD,tlsOptions:trust()});
  assert.deepEqual(await sender.send({to:"josh@example.com",subject:"Reset your GenDragoon password",body:"line one\nline two"}),{accepted:true});
  const s=srv.sessions[0];
  assert.equal(s.tlsAtAuth,true,"AUTH happened on the TLS socket");
  const plain=s.lines.find(l=>l.startsWith("AUTH PLAIN "));
  assert.equal(Buffer.from(plain.slice(11),"base64").toString(),"\0support@infected-nation.com\0"+PASSWORD);
  assert.ok(s.lines.includes("MAIL FROM:<support@infected-nation.com>"));
  assert.ok(s.lines.includes("RCPT TO:<josh@example.com>"));
  assert.match(s.data,/^From: "Infected Nation Support" <support@infected-nation\.com>\r\n/);
  assert.match(s.data,/\r\nSubject: Reset your GenDragoon password\r\n/);
  assert.equal(decodeBody(s.data),"line one\r\nline two");
 }finally{srv.close();}
});

test("implicit TLS (465) + AUTH LOGIN",{skip:!CERT&&"openssl not available"},async()=>{
 const srv=await fakeSmtp({mode:"tls",auth:"LOGIN"});
 try{
  const sender=mail.createSmtpSender({host:"127.0.0.1",port:srv.port,secure:"tls",password:PASSWORD,tlsOptions:trust()});
  await sender.send({to:"a@example.com",subject:"Hello",body:"x"});
  const s=srv.sessions[0];
  assert.ok(s.lines.includes(Buffer.from(PASSWORD).toString("base64")));
  assert.equal(s.tlsAtAuth,true);
 }finally{srv.close();}
});

test("refuses to authenticate without TLS; untrusted certificates fail",{skip:!CERT&&"openssl not available"},async()=>{
 const srv=await fakeSmtp({mode:"plain"});
 const tlsSrv=await fakeSmtp({mode:"starttls"});
 try{
  const sender=mail.createSmtpSender({host:"127.0.0.1",port:srv.port,password:PASSWORD});
  await assert.rejects(sender.send({to:"a@example.com",subject:"Hi",body:"x"}),e=>e.code==="smtp_tls_required");
  assert.ok(!srv.sessions[0].lines.some(l=>l.startsWith("AUTH")),"no AUTH attempted in clear");
  const untrusted=mail.createSmtpSender({host:"127.0.0.1",port:tlsSrv.port,password:PASSWORD});
  await assert.rejects(untrusted.send({to:"a@example.com",subject:"Hi",body:"x"}),e=>e.code==="smtp_tls"||e.code==="smtp_closed");
  assert.ok(!tlsSrv.sessions[0].lines.some(l=>l.startsWith("AUTH")));
 }finally{srv.close();tlsSrv.close();}
});

test("the password never appears in errors, inspect output, JSON or logs",{skip:!CERT&&"openssl not available"},async()=>{
 const srv=await fakeSmtp({mode:"starttls",rejectAuth:true,echoAuth:true});
 const logged=[];const orig={log:console.log,error:console.error,warn:console.warn};
 for(const k of Object.keys(orig))console[k]=(...a)=>logged.push(a.map(String).join(" "));
 try{
  const sender=mail.createSmtpSender({host:"127.0.0.1",port:srv.port,password:PASSWORD,tlsOptions:trust()});
  let err;try{await sender.send({to:"a@example.com",subject:"Hi",body:"x"});}catch(e){err=e;}
  assert.equal(err.code,"smtp_refused");
  const b64=Buffer.from("\0support@infected-nation.com\0"+PASSWORD).toString("base64");
  for(const text of [err.message,String(err.stack),util.inspect(sender),JSON.stringify(sender),util.inspect(err),...logged]){
   assert.ok(!text.includes(PASSWORD)&&!text.includes(b64),"leak in: "+text.slice(0,80));
  }
 }finally{Object.assign(console,orig);srv.close();}
});

test("plaintext is allowed only on loopback when a test asks for it",async()=>{
 const srv=await fakeSmtp({mode:"plain"});
 try{
  const sender=mail.createSmtpSender({host:"127.0.0.1",port:srv.port,password:PASSWORD,allowPlaintextLoopback:true});
  await sender.send({to:"a@example.com",subject:"Hi",body:"x"});
  assert.equal(srv.sessions[0].authed,true);
  assert.throws(()=>mail.createSmtpSender({host:"smtp.example.com",password:""}),/password is required/);
 }finally{srv.close();}
});

test("message rendering blocks header injection and encodes non-ASCII",()=>{
 assert.throws(()=>mail.renderMessage({from:mail.SUPPORT_ADDRESS,to:"a@example.com\r\nBcc: x@example.com",subject:"s",body:"b"}),e=>e.code==="invalid_address");
 const m=mail.renderMessage({from:mail.SUPPORT_ADDRESS,to:"a@example.com",subject:"Bonjour\r\nBcc: x@example.com",body:".\n.."});
 assert.ok(!/\r\nBcc:/.test(m));
 assert.match(mail.renderMessage({from:mail.SUPPORT_ADDRESS,to:"a@example.com",subject:"Grüße",body:"b"}),/Subject: =\?UTF-8\?B\?/);
});

test("senderFromEnv: off by default, needs host and SUPPORT_EMAIL_PASSWORD",()=>{
 assert.equal(mail.senderFromEnv({}),null);
 assert.throws(()=>mail.senderFromEnv({SUPPORT_EMAIL_ENABLED:"true",SUPPORT_SMTP_HOST:"smtp.example.com"}),/SUPPORT_EMAIL_PASSWORD/);
 const s=mail.senderFromEnv({SUPPORT_EMAIL_ENABLED:"true",SUPPORT_SMTP_HOST:"smtp.example.com",SUPPORT_EMAIL_PASSWORD:PASSWORD});
 assert.deepEqual(s.describe(),{host:"smtp.example.com",port:587,secure:"starttls",user:"support@infected-nation.com",from:"support@infected-nation.com"});
 assert.ok(!util.inspect(s).includes(PASSWORD));
});

async function resetRig(users={"josh@example.com":"uid-josh"}){
 const app=express();const sender=mail.recordingSender();const logs=[];let t=1_800_000_000_000;
 const adminAuth={async generatePasswordResetLink(email){if(!users[email])throw Object.assign(Error("no user"),{code:"auth/user-not-found"});return "https://gendragoon.example/reset?oobCode=abc&e="+users[email];}};
 mail.registerPasswordReset({app,adminAuth,sender,now:()=>t,log:(e,f)=>logs.push([e,f])});
 const server=await new Promise(r=>{const s=app.listen(0,"127.0.0.1",()=>r(s));});
 const post=body=>fetch("http://127.0.0.1:"+server.address().port+"/v1/auth/password-reset",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
 const settle=()=>new Promise(r=>setTimeout(r,30));
 return {sender,logs,post,settle,advance:ms=>{t+=ms;},close:()=>server.close()};
}

test("password reset: same 202 for known and unknown addresses; only real accounts get mail",async()=>{
 const r=await resetRig();
 try{
  const a=await r.post({email:"josh@example.com"}),b=await r.post({email:"nobody@example.com"});
  assert.equal(a.status,202);assert.equal(b.status,202);
  assert.deepEqual(await a.json(),await b.json());
  await r.settle();
  assert.equal(r.sender.sent.length,1);
  assert.equal(r.sender.sent[0].to,"josh@example.com");
  assert.match(r.sender.sent[0].body,/https:\/\/gendragoon\.example\/reset\?oobCode=abc/);
  assert.match(r.sender.sent[0].body,/support@infected-nation\.com/);
  assert.ok(!JSON.stringify(r.logs).includes("josh@example.com"),"logs hold a hash, not the address");
  assert.equal((await r.post({email:"not an email"})).status,400);
 }finally{r.close();}
});

test("password reset: per-address throttle is silent, per-IP limit is 429",async()=>{
 const r=await resetRig();
 try{
  for(let i=0;i<5;i++)assert.equal((await r.post({email:"josh@example.com"})).status,202);
  await r.settle();
  assert.equal(r.sender.sent.length,3,"three per address per hour");
  for(let i=0;i<5;i++)await r.post({email:"x"+i+"@example.com"});
  assert.equal((await r.post({email:"y@example.com"})).status,429);
 }finally{r.close();}
});

test("notices resolve the address at send time and never fail the caller",async()=>{
 const sender=mail.recordingSender();
 const adminAuth={async getUser(uid){if(uid==="u1")return {email:"josh@example.com"};throw Error("not found");}};
 const notify=mail.createNotifier({sender,adminAuth});
 assert.deepEqual(await notify("u1","provider.connected",{client:{name:"RedX",host:"studio-mac"}}),{sent:true});
 assert.match(sender.sent[0].subject,/connected/);
 assert.match(sender.sent[0].body,/RedX \(studio-mac\)/);
 assert.deepEqual(await notify("u2","provider.revoked",{}),{sent:false,reason:"no_user"});
 const failing=mail.createNotifier({sender:{send:async()=>{throw Object.assign(Error("down"),{code:"smtp_connect"});}},adminAuth});
 assert.deepEqual(await failing("u1","provider.revoked",{client:{name:"RedX"},dataDeleted:true}),{sent:false,reason:"send_failed"});
});
