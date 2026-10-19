"use strict";
// Support email (Node port of rottenapple/mailer): SMTP against an in-process fake server on 127.0.0.1 with a
// throwaway certificate (no real mail is sent), templates, the password-reset route and notices.
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

const PASSWORD="s3cret-App-Pa55word";
const ENV={SUPPORT_EMAIL_PASSWORD:PASSWORD};

function selfSigned(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gd-smtp-"));
 try{execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",path.join(dir,"k.pem"),"-out",path.join(dir,"c.pem"),
  "-days","1","-subj","/CN=127.0.0.1","-addext","subjectAltName=IP:127.0.0.1"],{stdio:"ignore"});}catch(_){return null;}
 return {key:fs.readFileSync(path.join(dir,"k.pem")),cert:fs.readFileSync(path.join(dir,"c.pem"))};
}
const CERT=selfSigned();
const skip=!CERT&&"openssl not available";

// mode: "starttls" | "nostarttls" | "tls"; rcpt: reply code for RCPT TO
function fakeSmtp({mode="starttls",rcpt=250,auth=235}={}){
 const sessions=[];
 function start(socket,secure){
  const s={lines:[],data:"",secure,tlsAtAuth:null};sessions.push(s);
  let inData=false,buf="",sock=socket;
  const say=l=>sock.write(l+"\r\n");
  function onData(d){
   buf+=d.toString();let i;
   while((i=buf.indexOf("\r\n"))>=0){
    const line=buf.slice(0,i);buf=buf.slice(i+2);
    if(inData){if(line==="."){inData=false;say("250 queued");}else s.data+=line+"\r\n";continue;}
    s.lines.push(line);
    if(/^EHLO/.test(line)){say("250-fake.test");if(mode==="starttls"&&!s.secure)say("250-STARTTLS");say("250 AUTH PLAIN LOGIN");}
    else if(line==="STARTTLS"){say("220 go");sock.off("data",onData);
     const t=new tls.TLSSocket(sock,{isServer:true,key:CERT.key,cert:CERT.cert});t.on("secure",()=>{s.secure=true;});t.on("data",onData);t.on("error",()=>{});sock=t;return;}
    else if(/^AUTH PLAIN /.test(line)){s.tlsAtAuth=s.secure;say(auth===235?"235 ok":auth+" bad credentials "+line);}
    else if(/^MAIL FROM/.test(line))say("250 ok");
    else if(/^RCPT TO/.test(line))say(rcpt===250?"250 ok":rcpt+" 5.1.1 no such user");
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
const cfg=(port,extra={})=>({...mail.defaultInfectedNation(),host:"127.0.0.1",port,...extra});
const trust={tlsOptions:{ca:CERT?.cert}};
const qpDecode=s=>Buffer.from(s.replace(/=\r\n/g,"").replace(/=([0-9A-F]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16))),"latin1").toString("utf8");

test("same defaults as mailer.DefaultInfectedNation; no password field",()=>{
 assert.deepEqual(mail.defaultInfectedNation(),{host:"smtp.gmail.com",port:587,security:"starttls",username:"support@infected-nation.com",
  from:"support@infected-nation.com",fromName:"Infected Nation Support"});
 assert.throws(()=>mail.createMailer({...mail.defaultInfectedNation(),password:"x"}),/no password field/);
 assert.throws(()=>mail.createMailer({...mail.defaultInfectedNation(),security:"none"}),/no plaintext mode/);
});

test("STARTTLS: authenticates only after TLS; message matches the Go mailer's format",{skip},async()=>{
 const srv=await fakeSmtp();const log=mail.memLog();
 try{
  const m=mail.createMailer(cfg(srv.port),{log,env:ENV,...trust});
  await m.send({to:"josh@example.com",subject:"Grüße from GenDragoon",body:"line one\nline two = done",template:"test"});
  const s=srv.sessions[0];
  assert.equal(s.tlsAtAuth,true);
  const plain=s.lines.find(l=>l.startsWith("AUTH PLAIN "));
  assert.equal(Buffer.from(plain.slice(11),"base64").toString(),"\0support@infected-nation.com\0"+PASSWORD);
  assert.ok(s.lines.includes("MAIL FROM:<support@infected-nation.com>")&&s.lines.includes("RCPT TO:<josh@example.com>"));
  assert.match(s.data,/^From: "Infected Nation Support" <support@infected-nation\.com>\r\n/);
  assert.match(s.data,/\r\nSubject: =\?utf-8\?q\?/);
  assert.match(s.data,/\r\nContent-Transfer-Encoding: quoted-printable\r\nAuto-Submitted: auto-generated\r\n/);
  assert.equal(qpDecode(s.data.split("\r\n\r\n").slice(1).join("\r\n\r\n")).trimEnd(),"line one\r\nline two = done");
  assert.deepEqual(log.events().map(e=>[e.status,e.to,e.template]),[["sent","j***@example.com","test"]]);
  assert.equal(log.events()[0].toHash.length,16);
 }finally{srv.close();}
});

test("implicit TLS (465)",{skip},async()=>{
 const srv=await fakeSmtp({mode:"tls"});
 try{
  await mail.createMailer(cfg(srv.port,{security:"tls"}),{env:ENV,...trust}).send({to:"a@example.com",subject:"Hi",body:"x"});
  assert.equal(srv.sessions[0].tlsAtAuth,true);
 }finally{srv.close();}
});

test("refuses a server without STARTTLS and an untrusted certificate before any credential",{skip},async()=>{
 const plain=await fakeSmtp({mode:"nostarttls"}),good=await fakeSmtp();const log=mail.memLog();
 try{
  await assert.rejects(mail.createMailer(cfg(plain.port),{env:ENV,log}).send({to:"a@example.com",subject:"Hi",body:"x"}),e=>e.code==="ErrNoTLS");
  await assert.rejects(mail.createMailer(cfg(good.port),{env:ENV}).send({to:"a@example.com",subject:"Hi",body:"x"}),/STARTTLS/);
  for(const s of [...plain.sessions,...good.sessions])assert.ok(!s.lines.some(l=>l.startsWith("AUTH")));
  assert.equal(log.events()[0].status,"error");
 }finally{plain.close();good.close();}
});

test("a permanent 5xx is a bounce and is logged as bounced",{skip},async()=>{
 const srv=await fakeSmtp({rcpt:550});const log=mail.memLog();
 try{
  await assert.rejects(mail.createMailer(cfg(srv.port),{env:ENV,log,...trust}).send({to:"gone@example.com",subject:"Hi",body:"x"}),
   e=>e instanceof mail.Bounce&&e.smtpCode===550);
  assert.deepEqual(log.events().map(e=>[e.status,e.code]),[["bounced",550]]);
 }finally{srv.close();}
});

test("the password is read at send time, required, and never appears in errors, logs or inspect output",{skip},async()=>{
 const srv=await fakeSmtp({auth:535});const log=mail.memLog();const printed=[];
 const orig={log:console.log,error:console.error,warn:console.warn};
 for(const k of Object.keys(orig))console[k]=(...a)=>printed.push(a.map(String).join(" "));
 try{
  const env={};
  const m=mail.createMailer(cfg(srv.port),{env,log,...trust});
  await assert.rejects(m.send({to:"a@example.com",subject:"Hi",body:"x"}),e=>e.code==="ErrNoPassword");
  env.SUPPORT_EMAIL_PASSWORD=PASSWORD;
  let err;try{await m.send({to:"a@example.com",subject:"Hi",body:"x"});}catch(e){err=e;}
  assert.match(err.message,/sign-in to the SMTP server failed/);
  const b64=Buffer.from("\0support@infected-nation.com\0"+PASSWORD).toString("base64");
  for(const t of [err.message,String(err.stack),util.inspect(m),JSON.stringify(m.config()),JSON.stringify(log.events()),...printed])
   assert.ok(!t.includes(PASSWORD)&&!t.includes(b64),"leak: "+t.slice(0,80));
 }finally{Object.assign(console,orig);srv.close();}
});

test("refuses injection and several recipients; rate limits per recipient and overall",async()=>{
 const log=mail.memLog();let t=1_800_000_000_000;
 const m=mail.createMailer({...mail.defaultInfectedNation(),host:"127.0.0.1",port:1},{env:{},log,now:()=>t});
 for(const to of ["a@example.com\r\nBcc: x@example.com","a@example.com, b@example.com","Josh <a@example.com>"])
  await assert.rejects(m.send({to,subject:"s",body:"b"}),e=>e.code==="ErrBadMessage");
 await assert.rejects(m.send({to:"a@example.com",subject:"s\r\nBcc: x@example.com",body:"b"}),e=>e.code==="ErrBadMessage");
 for(let i=0;i<5;i++)await assert.rejects(m.send({to:"a@example.com",subject:"s",body:"b"}),e=>e.code==="ErrNoPassword");
 await assert.rejects(m.send({to:"a@example.com",subject:"s",body:"b"}),e=>e.code==="ErrRateLimited");
 t+=3_600_000;
 await assert.rejects(m.send({to:"a@example.com",subject:"s",body:"b"}),e=>e.code==="ErrNoPassword");
 assert.deepEqual([...new Set(log.events().map(e=>e.status))].sort(),["error","rate_limited","refused"]);
});

test("templates: the shared built-ins, GenDragoon's replacement and additions, missing fields are errors",()=>{
 const base=mail.templates(),gd=mail.gendragoonTemplates();
 assert.deepEqual(base.names(),["appeal_update","email_verify","moderation_notice","password_reset","test","twofa_setup_link"]);
 assert.match(base.render("password_reset","a@example.com",{Product:"X",Code:"123",MinutesValid:10,Support:"s@x.com"}).body,/Your code: 123/);
 assert.throws(()=>base.render("password_reset","a@example.com",{Product:"X"}),/missing template field/);
 const m=gd.render("password_reset","a@example.com",{Product:"GenDragoon",Link:"https://l",MinutesValid:60,Support:"support@infected-nation.com"});
 assert.equal(m.template,"password_reset");assert.match(m.body,/https:\/\/l/);
 assert.throws(()=>gd.render("nope","a@example.com",{}),/no template/);
});

test("senderFromEnv: off by default; refuses to start without the password variable",()=>{
 assert.equal(mail.senderFromEnv({}),null);
 assert.throws(()=>mail.senderFromEnv({SUPPORT_EMAIL_ENABLED:"true"}),/SUPPORT_EMAIL_PASSWORD/);
 const s=mail.senderFromEnv({SUPPORT_EMAIL_ENABLED:"true",SUPPORT_EMAIL_PASSWORD:PASSWORD});
 assert.equal(s.config().host,"smtp.gmail.com");assert.ok(!JSON.stringify(s.config()).includes(PASSWORD));
});

test("subjects and names encode exactly as Go's mime.QEncoding, mime.BEncoding and mail.Address",()=>{
 const vectors=JSON.parse(fs.readFileSync(path.join(__dirname,"test_helpers/rfc2047_go_vectors.json"),"utf8"));
 assert.ok(vectors.length>=10);
 for(const v of vectors){
  assert.equal(mail.qEncode(v.In),v.Q,"Q "+v.In);
  assert.equal(mail.bEncode(v.In),v.B,"B "+v.In);
  assert.equal(mail.formatAddress(v.In,"support@infected-nation.com"),v.Addr,"address "+v.In);
  for(const w of v.Q.split(" ").filter(w=>w.startsWith("=?")))assert.ok(w.length<=75,"encoded-word over 75: "+w);
 }
});

test("long encoded subjects are split into words of at most 75 characters and folded",()=>{
 const m=mail.createMailer({...mail.defaultInfectedNation(),host:"127.0.0.1",port:1},{env:{}});
 const subject="Grüße ".repeat(40).trim();
 const raw=m.build({to:"a@example.com",subject,body:"b"});
 const header=raw.split("\r\n\r\n")[0];
 const lines=header.split("\r\n");
 assert.ok(lines.every(l=>l.length<=(l.startsWith("Subject: ")?9+75:78)),"header lines are at most 78 characters (the Subject line holds its first word)");
 assert.match(header,/\r\nSubject: =\?utf-8\?q\?/);
 const subj=header.match(/\r\nSubject: ([\s\S]*?)\r\n(?! )/)[1].replace(/\r\n /g," ");
 assert.equal(subj,mail.qEncode(subject));
 const words=subj.split(" ");
 assert.ok(words.length>1&&words.every(w=>w.length<=75&&/^=\?utf-8\?q\?[^?]*\?=$/.test(w)));
 const qDecode=w=>{const bytes=[];const t=w.slice(10,-2);
  for(let k=0;k<t.length;k++){if(t[k]==="="){bytes.push(parseInt(t.slice(k+1,k+3),16));k+=2;}else bytes.push(t[k]==="_"?0x20:t.charCodeAt(k));}
  return Buffer.from(bytes);};
 assert.equal(Buffer.concat(words.map(qDecode)).toString("utf8"),subject);
});

test("the per-recipient limit folds case, Gmail dots and +tags",async()=>{
 assert.equal(mail.recipientKey("V.Ictim+promo@GoogleMail.com"),"victim@gmail.com");
 assert.equal(mail.recipientKey("victim@gmail.com"),"victim@gmail.com");
 assert.equal(mail.recipientKey("first.last+x@example.com"),"first.last@example.com");
 assert.equal(mail.recipientKey("first.last@example.com"),"first.last@example.com");
 let t=1_800_000_000_000;
 const m=mail.createMailer({...mail.defaultInfectedNation(),host:"127.0.0.1",port:1},{env:{},now:()=>t});
 const variants=["victim@gmail.com","v.ictim@gmail.com","victim+1@gmail.com","VICTIM@googlemail.com","vic.tim+2@gmail.com"];
 for(const to of variants)await assert.rejects(m.send({to,subject:"s",body:"b"}),e=>e.code==="ErrNoPassword");
 await assert.rejects(m.send({to:"v.i.c.t.i.m+3@gmail.com",subject:"s",body:"b"}),e=>e.code==="ErrRateLimited");
 await assert.rejects(m.send({to:"other@gmail.com",subject:"s",body:"b"}),e=>e.code==="ErrNoPassword");
 for(let i=0;i<5;i++)await assert.rejects(m.send({to:"user+"+i+"@example.com",subject:"s",body:"b"}),e=>e.code!=="ErrBadMessage");
 await assert.rejects(m.send({to:"user@example.com",subject:"s",body:"b"}),e=>e.code==="ErrRateLimited");
});

async function resetRig(users={"josh@example.com":"uid-josh"},{trustProxy=false,limits}={}){
 const app=express();const sender=mail.recordingSender();const logs=[];
 if(trustProxy!==false)app.set("trust proxy",trustProxy);
 let links=0;
 const adminAuth={async generatePasswordResetLink(email){links++;if(!users[email])throw Object.assign(Error("no user"),{code:"auth/user-not-found"});return "https://gendragoon.example/reset?oobCode=abc";}};
 mail.registerPasswordReset({app,adminAuth,sender,log:(e,f)=>logs.push([e,f]),limits});
 const server=await new Promise(r=>{const s=app.listen(0,"127.0.0.1",()=>r(s));});
 const post=(body,headers={})=>fetch("http://127.0.0.1:"+server.address().port+"/v1/auth/password-reset",{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body)});
 return {sender,logs,post,links:()=>links,settle:()=>new Promise(r=>setTimeout(r,30)),close:()=>server.close()};
}

test("password reset: per-IP limit uses the proxy-appended client address, not a forged one",async()=>{
 const r=await resetRig({},{trustProxy:1});
 try{
  // The client rotates its own X-Forwarded-For; the proxy appends the same real address each time.
  for(let i=0;i<10;i++)assert.equal((await r.post({email:"x"+i+"@example.com"},{"X-Forwarded-For":"10.9.9."+i+", 203.0.113.7"})).status,202);
  assert.equal((await r.post({email:"y@example.com"},{"X-Forwarded-For":"10.9.9.99, 203.0.113.7"})).status,429);
  assert.equal((await r.post({email:"y@example.com"},{"X-Forwarded-For":"198.51.100.20"})).status,202,"another client is not limited");
 }finally{r.close();}
});

test("password reset: per-address limit across IPs and address variants, with the same 202",async()=>{
 const r=await resetRig({"victim@gmail.com":"uid-v"},{trustProxy:1});
 try{
  const variants=["victim@gmail.com","v.ictim@gmail.com","victim+a@gmail.com","VICTIM@googlemail.com","vi.ctim+b@gmail.com","victim@gmail.com","v.i.ctim@gmail.com"];
  const bodies=[];
  for(const [i,email] of variants.entries()){
   const res=await r.post({email},{"X-Forwarded-For":"198.51.100."+i});
   assert.equal(res.status,202);bodies.push(JSON.stringify(await res.json()));
  }
  await r.settle();
  assert.equal(new Set(bodies).size,1,"limited and unlimited answers are identical");
  assert.equal(r.links(),5,"no reset link is generated over the per-address limit");
  assert.equal(r.logs.filter(([e])=>e==="password_reset.limited").length,2);
  assert.ok(!JSON.stringify(r.logs).includes("victim"));
 }finally{r.close();}
});

test("password reset: same 202 for known and unknown addresses; only real accounts get mail",async()=>{
 const r=await resetRig();
 try{
  const a=await r.post({email:"josh@example.com"}),b=await r.post({email:"nobody@example.com"});
  assert.equal(a.status,202);assert.equal(b.status,202);assert.deepEqual(await a.json(),await b.json());
  await r.settle();
  assert.equal(r.sender.sent.length,1);
  assert.equal(r.sender.sent[0].template,"password_reset");
  assert.match(r.sender.sent[0].body,/oobCode=abc/);assert.match(r.sender.sent[0].body,/support@infected-nation\.com/);
  assert.ok(!JSON.stringify(r.logs).includes("josh@example.com"));
  assert.equal((await r.post({email:"not an email"})).status,400);
  for(let i=0;i<10;i++)await r.post({email:"x"+i+"@example.com"});
  assert.equal((await r.post({email:"y@example.com"})).status,429);
 }finally{r.close();}
});

test("notices render through the shared templates and never fail the caller",async()=>{
 const sender=mail.recordingSender();
 const adminAuth={async getUser(uid){if(uid==="u1")return {email:"josh@example.com"};throw Error("not found");}};
 const notify=mail.createNotifier({sender,adminAuth});
 assert.deepEqual(await notify("u1","provider.connected",{client:{name:"RedX",host:"studio-mac"}}),{sent:true});
 assert.equal(sender.sent[0].template,"provider_connected");assert.match(sender.sent[0].body,/RedX \(studio-mac\)/);
 assert.deepEqual(await notify("u2","provider.revoked",{}),{sent:false,reason:"no_user"});
 const failing=mail.createNotifier({sender:{send:async()=>{throw Object.assign(Error("down"),{code:"error"});}},adminAuth});
 assert.deepEqual(await failing("u1","provider.revoked",{client:{name:"RedX"},dataDeleted:true}),{sent:false,reason:"send_failed"});
});
