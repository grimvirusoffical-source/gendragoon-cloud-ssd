"use strict";
// Gendragoon accounts: shared rule vectors, TOTP, sealing, the ToS gate, email deliverability, the sign-up API
// (uniqueness, quick paths, 2FA choices), the login gate, Red-XAI OIDC verification and deletion cleanup.
const test=require("node:test"),assert=require("node:assert/strict");
const crypto=require("node:crypto");
const express=require("express");
const R=require("./accounts/rules");
const totp=require("./accounts/totp");
const {createSealer}=require("./accounts/seal");
const {createTosGate,loadTerms}=require("./accounts/tos");
const {createEmailChecker}=require("./accounts/email_check");
const {MockSmsProvider,smsProviderFromEnv}=require("./accounts/sms");
const {createAccountStore,deleteProfileByHash}=require("./accounts/store");
const {registerAccounts}=require("./accounts/routes");
const {createOidcVerifier}=require("./accounts/oidc");
const {createIdentity}=require("./accounts/identity");
const {createLoginGate}=require("./login_gate");
const {memoryFirestore}=require("./test_firestore");
const vectors=require("./contract/account_rules_vectors.json");

const NOW=Date.parse(vectors.now);
const accountKey=uid=>crypto.createHash("sha256").update("gd-v1:"+uid).digest("hex");

test("shared rule vectors (same file as gendragoon-apps core)",()=>{
 const now=new Date(NOW);
 const code=c=>c.ok?"ok":c.code;
 for(const [v,want] of vectors.username)assert.equal(code(R.checkUsername(v)),want,"username "+v);
 for(const [v,want] of vectors.usernameKey)assert.equal(R.usernameKey(v),want);
 for(const [v,want] of vectors.password)assert.equal(code(R.checkPassword(v)),want,"password "+JSON.stringify(v));
 for(const [n,want] of vectors.passwordLong)assert.equal(code(R.checkPassword("Aa1!"+"a".repeat(n-4))),want,"length "+n);
 for(const [v,want] of vectors.email)assert.equal(code(R.checkEmailFormat(v)),want,"email "+v);
 for(const [v,want] of vectors.emailKey)assert.equal(R.emailKey(v),want);
 for(const [v,want] of vectors.dob)assert.equal(code(R.checkBirthDate(v,{now})),want,"dob "+v);
 for(const [v,want] of vectors.minAge)assert.equal(R.effectiveMinAge(v),want);
 for(const [v,want] of vectors.phone)assert.equal(code(R.checkPhone(v)),want);
 for(const c of vectors.signup)assert.deepEqual(R.validateSignup(c.fields,{now,requirePassword:c.requirePassword}),c.errors);
});

test("minimum age: 13 is the floor even when configured lower",()=>{
 const now=new Date(NOW);
 assert.equal(R.checkBirthDate("10/20/2013",{now,minAge:0}).code,"under_min_age");
 assert.equal(R.checkBirthDate("10/20/2013",{now,minAge:5}).code,"under_min_age");
 assert.equal(R.checkBirthDate("10/19/2010",{now,minAge:18}).code,"under_min_age");
});

test("TOTP matches RFC 6238 (SHA-1) and refuses replays",()=>{
 const secret=totp.base32Encode(Buffer.from("12345678901234567890"));
 assert.equal(secret,"GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
 assert.equal(totp.totp(secret,59_000),"287082");
 assert.equal(totp.totp(secret,1111111109_000),"081804");
 assert.equal(totp.totp(secret,1234567890_000),"005924");
 assert.equal(totp.totp(secret,2000000000_000),"279037");
 const t=1234567890_000;
 const step=totp.verifyTotp(secret,"005924",t);
 assert.ok(step>0);
 assert.equal(totp.verifyTotp(secret,"005924",t,{lastStep:step}),-1,"same code twice");
 assert.ok(totp.verifyTotp(secret,totp.totp(secret,t-30_000),t)>0,"one step of clock drift");
 assert.equal(totp.verifyTotp(secret,totp.totp(secret,t-90_000),t),-1);
 assert.equal(totp.verifyTotp(secret,"12345",t),-1);
 assert.deepEqual(totp.base32Decode(secret),Buffer.from("12345678901234567890"));
 const uri=totp.otpauthUri({secret,account:"dragon_rider"});
 assert.match(uri,/^otpauth:\/\/totp\/Gendragoon:dragon_rider\?secret=GEZDGNBV.*&issuer=Gendragoon&algorithm=SHA1&digits=6&period=30$/);
 assert.equal(totp.generateSecret().length,32);
});

test("sealed secrets round-trip, are bound to their context and detect tampering",()=>{
 const s=createSealer(crypto.randomBytes(32).toString("base64"));
 const sealed=s.seal("+15555550123","phone:u1");
 assert.equal(s.open(sealed,"phone:u1"),"+15555550123");
 assert.throws(()=>s.open(sealed,"phone:u2"));
 assert.throws(()=>s.open(sealed.slice(0,-2)+"AA","phone:u1"));
 assert.equal(createSealer(undefined).ready,false);
});

test("Terms: the file is versioned, the attorney-review marker never reaches the app",()=>{
 const terms=loadTerms();
 assert.equal(terms.version,"gendragoon-tos-2026-10-19");
 assert.doesNotMatch(terms.text,/attorney review/i);
 assert.match(require("node:fs").readFileSync(require("./accounts/tos").TOS_FILE,"utf8").split("\n").slice(0,3).join("\n"),/Draft: requires attorney review before launch\./);
 for(const topic of ["Acceptable use","Your content","backups","auto-renewal","refunds","Team chat conduct","Moderation","Termination","Disclaimer of warranties",
  "Limitation of liability","Indemnity","arbitration","class-action waiver","Governing law","DMCA","Privacy","at least 13","Changes to these Terms","support@infected-nation.com","Red-XAI LLC"])
  assert.ok(terms.text.toLowerCase().includes(topic.toLowerCase()),topic);
});

test("Terms gate: read before agree, current version, single grant format, 30 minute life",()=>{
 let t=NOW;const gate=createTosGate({key:crypto.randomBytes(32),now:()=>t});
 const v=gate.terms.version;
 assert.equal(gate.read("old-version").code,"tos_changed");
 const read=gate.read(v);assert.equal(read.stage,"read");
 assert.equal(gate.verifyAgreed(read.grant).code,"tos_required","a read grant is not an agreement");
 assert.equal(gate.verifyAgreed(undefined).code,"tos_required");
 assert.equal(gate.agree("garbage").code,"tos_grant_invalid");
 const tampered=read.grant.replace(".read.",".agreed.");
 assert.equal(gate.agree(tampered).code,"tos_grant_invalid");
 assert.equal(gate.verifyAgreed(tampered).code,"tos_grant_invalid");
 t+=5000;
 const agreed=gate.agree(read.grant);assert.equal(agreed.stage,"agreed");
 assert.equal(gate.agree(agreed.grant).code,"tos_grant_invalid","agreeing twice");
 const ok=gate.verifyAgreed(agreed.grant);
 assert.equal(ok.ok,true);assert.equal(ok.readMs,NOW);assert.equal(ok.agreedMs,NOW+5000);
 const other=createTosGate({key:crypto.randomBytes(32),now:()=>t});
 assert.equal(other.verifyAgreed(agreed.grant).code,"tos_grant_invalid","another key");
 t+=31*60_000;
 assert.equal(gate.verifyAgreed(agreed.grant).code,"tos_grant_invalid","expired");
});

function fakeResolver(table){
 const lookup=kind=>async domain=>{
  const entry=table[domain];
  if(!entry)throw Object.assign(Error("nx"),{code:"ENOTFOUND"});
  if(entry==="servfail")throw Object.assign(Error("servfail"),{code:"ESERVFAIL"});
  const v=entry[kind];if(!v)throw Object.assign(Error("nodata"),{code:"ENODATA"});return v;
 };
 return {resolveMx:lookup("mx"),resolve4:lookup("a"),resolve6:lookup("aaaa")};
}
const DNS={"example.com":{mx:[{exchange:"mx.example.com",priority:10}]},"gmail.com":{mx:[{exchange:"gmail-smtp-in.l.google.com",priority:5}]},"googlemail.com":{mx:[{exchange:"gmail-smtp-in.l.google.com",priority:5}]},
 "infected-nation.com":{mx:[{exchange:"mx.infected-nation.com",priority:10}]},"business.dev":{a:["203.0.113.5"]},
 "nullmx.com":{mx:[{exchange:"",priority:0}]},"flaky.com":"servfail"};

test("email deliverability: MX, implicit MX (A record), null MX, missing domain, DNS failure",async()=>{
 const c=createEmailChecker({resolver:fakeResolver(DNS)});
 assert.deepEqual(await c.check("josh@example.com"),{ok:true});
 assert.deepEqual(await c.check("owner@business.dev"),{ok:true},"custom business domain");
 assert.equal((await c.check("a@nullmx.com")).code,"email_domain");
 assert.equal((await c.check("a@nowhere-at-all.com")).code,"email_domain");
 assert.equal((await c.check("a@flaky.com")).code,"email_unverifiable");
 assert.equal((await c.check("not-an-email")).code,"email_syntax");
});

test("SMS: only the mock exists, and production refuses it unless staging opts in",()=>{
 assert.equal(smsProviderFromEnv({}),null);
 assert.ok(smsProviderFromEnv({SMS_PROVIDER:"mock"}) instanceof MockSmsProvider);
 assert.equal(smsProviderFromEnv({SMS_PROVIDER:"mock",NODE_ENV:"production"}),null);
 assert.ok(smsProviderFromEnv({SMS_PROVIDER:"mock",NODE_ENV:"production",ACCOUNTS_ALLOW_MOCK_SMS:"true"}));
});

// ---- HTTP harness: Firestore fake, fake identity tokens (see tok), mock SMS.
const tok=(uid,authTime,provider="password",email)=>["fb",uid,authTime,provider,...(email?[Buffer.from(email).toString("base64url")]:[])].join("~");
async function harness({sms=new MockSmsProvider(),minAge}={}){
 let t=NOW;const now=()=>t;
 const db=memoryFirestore();
 const store=createAccountStore({db,accountKey});
 const firebaseUsers=new Map();let nextUid=1;
 const identify=async token=>{
  const [kind,uid,authTime,provider,email]=token.split("~");
  if(kind!=="fb")throw Error("bad");
  return {uid,provider:"firebase",signInProvider:provider,email:email?Buffer.from(email,"base64url").toString():null,emailVerified:provider==="google.com",authTime:Number(authTime),amr:[]};
 };
 const app=express();
 const accounts=registerAccounts({app,store,identify,
  async createPasswordUser(email){for(const u of firebaseUsers.values())if(u.email===email)throw Object.assign(Error("x"),{code:"auth/email-already-exists"});const uid="u"+nextUid++;firebaseUsers.set(uid,{email});return uid;},
  async deletePasswordUser(uid){firebaseUsers.delete(uid);},
  emailChecker:createEmailChecker({resolver:fakeResolver(DNS),now}),sms,sealer:createSealer(crypto.randomBytes(32).toString("base64")),
  tosGate:createTosGate({key:crypto.randomBytes(32),now}),minAge,now,ipOf:()=>"203.0.113.9"});
 const gate=createLoginGate({verifyIdToken:async token=>{const id=await identify(token);return {uid:id.uid,auth_time:id.authTime,firebase:{sign_in_provider:id.signInProvider},__identity:id};},
  accountsGate:user=>accounts.gate(user)});
 app.get("/v1/protected",gate.firebaseAuth,(req,res)=>res.json({ok:true}));
 app.get("/v1/deletion-path",gate.firebaseAuthWithoutTerms,(req,res)=>res.json({ok:true}));
 const server=await new Promise(r=>{const s=app.listen(0,"127.0.0.1",()=>r(s));});
 const base="http://127.0.0.1:"+server.address().port;
 async function call(method,path,body,token){
  const res=await fetch(base+path,{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  let json=null;try{json=await res.json();}catch(_){}
  return {status:res.status,body:json};
 }
 async function agreedGrant(){
  const tos=await call("GET","/v1/accounts/tos");
  const read=await call("POST","/v1/accounts/tos/read",{version:tos.body.version});
  const agreed=await call("POST","/v1/accounts/tos/agree",{grant:read.body.grant});
  return agreed.body.grant;
 }
 return {db,store,sms,firebaseUsers,call,agreedGrant,close:()=>server.close(),advance:ms=>{t+=ms;},now};
}
const form=(over={})=>({username:"dragon_rider",email:"josh@example.com",emailConfirm:"josh@example.com",password:"Correct-Horse9",passwordConfirm:"Correct-Horse9",
 dob:"07/04/2001",twoFactor:"app",acknowledgeFalseInfo:true,...over});

test("sign-up: created only after an agreed ToS grant; stores the DOB and Terms, never the age",async()=>{
 const h=await harness();
 try{
  const read=await h.call("POST","/v1/accounts/tos/read",{version:(await h.call("GET","/v1/accounts/tos")).body.version});
  let r=await h.call("POST","/v1/accounts/signup",form({tosGrant:read.body.grant}));
  assert.equal(r.status,400);assert.equal(r.body.error,"tos_required");
  r=await h.call("POST","/v1/accounts/signup",form());
  assert.equal(r.body.error,"tos_required");
  r=await h.call("POST","/v1/accounts/tos/agree",{grant:"gdt1.read.x.y.1.0.zz"});
  assert.equal(r.body.error,"tos_grant_invalid");
  assert.equal(h.firebaseUsers.size,0,"no sign-in account without agreement");
  const grant=await h.agreedGrant();
  r=await h.call("POST","/v1/accounts/signup",form({tosGrant:grant}));
  assert.equal(r.status,201,JSON.stringify(r.body));
  assert.deepEqual(r.body.pending,["2fa_setup"]);
  assert.match(r.body.totp.otpauthUri,/^otpauth:\/\/totp\/Gendragoon:dragon_rider\?/);
  assert.equal(r.body.account.age,25);
  const profile=await h.store.get("u1");
  assert.equal(profile.dob,"2001-07-04");
  assert.equal(profile.tosVersion,"gendragoon-tos-2026-10-19");
  assert.equal(profile.tosAcceptedMs,NOW);assert.equal(typeof profile.falseInfoWarnedMs,"number");
  assert.ok(!("age" in profile));
  assert.ok(!JSON.stringify(profile).includes(r.body.totp.secret),"TOTP secret is sealed");
  assert.ok(!JSON.stringify(profile).includes("Correct-Horse9"),"password is never stored here");
  r=await h.call("POST","/v1/accounts/signup",form({username:"another_rider",email:"other@example.com",emailConfirm:"other@example.com",tosGrant:grant}));
  assert.equal(r.body.error,"tos_grant_invalid","a grant is single use");
 }finally{h.close();}
});

test("sign-up enforces every rule on the server, whatever the client sends",async()=>{
 const h=await harness();
 try{
  const cases=[[{username:"ab_12345"},"username_letters"],[{username:"_dragonrider"},"username_edges"],[{password:"weakpassword",passwordConfirm:"weakpassword"},"password_upper"],
   [{passwordConfirm:"Correct-Horse8"},"password_mismatch"],[{emailConfirm:"josh@example.org"},"email_mismatch"],[{email:"josh@nullmx.com",emailConfirm:"josh@nullmx.com"},"email_domain"],
   [{dob:"2001-07-04"},"dob_format"],[{dob:"10/20/2013"},"under_min_age"],[{twoFactor:"redxai_auth"},"twofactor_unavailable"],[{twoFactor:"none"},"no2fa_ack_required"],
   [{twoFactor:"phone",phone:"12"},"phone_invalid"],[{acknowledgeFalseInfo:false},"false_info_ack_required"]];
  for(const [over,want] of cases){
   h.advance(601_000);
   const r=await h.call("POST","/v1/accounts/signup",form({...over,tosGrant:await h.agreedGrant()}));
   assert.equal(r.body.error,want,JSON.stringify(over));
   assert.ok(r.status===400||r.status===403);
  }
  assert.equal(h.firebaseUsers.size,0);
 }finally{h.close();}
});

test("usernames are unique ignoring case; emails are unique after normalizing (Gmail dots and +tags too)",async()=>{
 const h=await harness();
 try{
  let r=await h.call("POST","/v1/accounts/signup",form({email:"Josh.Gamer@gmail.com",emailConfirm:"josh.gamer@gmail.com",tosGrant:await h.agreedGrant()}));
  assert.equal(r.status,201);
  r=await h.call("POST","/v1/accounts/validate/username",{username:"DRAGON_RIDER"});
  assert.equal(r.body.ok,false);assert.equal(r.body.error,"username_taken");
  r=await h.call("POST","/v1/accounts/signup",form({username:"Dragon_Rider",email:"new@example.com",emailConfirm:"new@example.com",tosGrant:await h.agreedGrant()}));
  assert.equal(r.status,409);assert.equal(r.body.error,"username_taken");
  r=await h.call("POST","/v1/accounts/validate/email",{email:"joshgamer+x@googlemail.com"});
  assert.equal(r.body.error,"email_taken");
  r=await h.call("POST","/v1/accounts/signup",form({username:"other_rider",email:"JOSHGAMER+x@gmail.com",emailConfirm:"joshgamer+x@gmail.com",tosGrant:await h.agreedGrant()}));
  assert.equal(r.status,409);assert.equal(r.body.error,"email_taken");
  r=await h.call("POST","/v1/accounts/validate/email",{email:"fresh@business.dev"});
  assert.equal(r.body.ok,true);
  r=await h.call("POST","/v1/accounts/validate/username",{username:"free_name_1"});
  assert.equal(r.body.ok,true);
  assert.equal(h.firebaseUsers.size,1,"failed sign-ups leave no sign-in account");
 }finally{h.close();}
});

test("2FA choices: authenticator app (QR secret, confirm, per-session code), phone (mocked SMS), none (warning acknowledged), Red-XAI Auth refused",async()=>{
 const h=await harness();
 try{
  // Authenticator app
  let r=await h.call("POST","/v1/accounts/signup",form({tosGrant:await h.agreedGrant()}));
  const secret=r.body.totp.secret;
  const s1=tok("u1",1000);
  r=await h.call("GET","/v1/protected",undefined,s1);
  assert.equal(r.status,403);assert.equal(r.body.code,"two_factor_setup_required");
  r=await h.call("POST","/v1/accounts/me/2fa/confirm",{code:"000000"},s1);
  assert.equal(r.body.error,"code_invalid");
  r=await h.call("POST","/v1/accounts/me/2fa/confirm",{code:totp.totp(secret,h.now())},s1);
  assert.equal(r.status,200);assert.equal(r.body.twoFactorState,"active");assert.deepEqual(r.body.pending,[]);
  assert.equal((await h.call("GET","/v1/protected",undefined,s1)).status,200,"the confirming session is verified");
  const s2=tok("u1",2000);
  r=await h.call("GET","/v1/protected",undefined,s2);
  assert.equal(r.status,403);assert.equal(r.body.code,"two_factor_required");
  h.advance(30_000);
  const code=totp.totp(secret,h.now());
  assert.equal((await h.call("POST","/v1/accounts/2fa/verify",{code},s2)).status,200);
  assert.equal((await h.call("GET","/v1/protected",undefined,s2)).status,200);
  r=await h.call("POST","/v1/accounts/2fa/verify",{code},tok("u1",3000));
  assert.equal(r.body.error,"code_invalid","a used code can't be replayed");
  assert.equal((await h.call("GET","/v1/deletion-path",undefined,tok("u1",3000))).status,200,"deletion never needs the second factor");

  // Phone
  r=await h.call("POST","/v1/accounts/signup",form({username:"phone_rider",email:"p@example.com",emailConfirm:"p@example.com",twoFactor:"phone",phone:"+1 555 123 4567",tosGrant:await h.agreedGrant()}));
  assert.equal(r.status,201);assert.deepEqual(r.body.pending,["2fa_setup"]);assert.equal(r.body.phoneMasked,"+1******4567");
  const sent=h.sms.lastTo("+15551234567");assert.ok(sent,"mock SMS recorded, nothing sent");
  const smsCode=/(\d{6})/.exec(sent.body)[1];
  const p1=tok("u2",1000);
  r=await h.call("POST","/v1/accounts/me/2fa/confirm",{code:smsCode},p1);
  assert.equal(r.body.twoFactorState,"active");
  const p2=tok("u2",2000);
  assert.equal((await h.call("POST","/v1/accounts/2fa/sms/send",{},p2)).status,200);
  const login=/(\d{6})/.exec(h.sms.lastTo("+15551234567").body)[1];
  assert.equal((await h.call("POST","/v1/accounts/2fa/verify",{code:login},p2)).status,200);
  assert.equal((await h.call("GET","/v1/protected",undefined,p2)).status,200);
  const stored=JSON.stringify(await h.store.get("u2"));
  assert.ok(!stored.includes("5551234567"),"phone number sealed");

  // None
  r=await h.call("POST","/v1/accounts/signup",form({username:"risky_rider",email:"r@example.com",emailConfirm:"r@example.com",twoFactor:"none",acceptNo2faRisk:true,tosGrant:await h.agreedGrant()}));
  assert.equal(r.status,201);assert.deepEqual(r.body.pending,[]);
  assert.equal((await h.store.get("u3")).no2faAckMs,h.now());
  assert.equal((await h.call("GET","/v1/protected",undefined,tok("u3",1))).status,200);
  r=await h.call("POST","/v1/accounts/me/2fa/setup",{method:"redxai_auth"},tok("u3",1));
  assert.equal(r.body.error,"twofactor_unavailable");
 }finally{h.close();}
});

test("phone 2FA is refused cleanly when no SMS provider is configured",async()=>{
 const h=await harness({sms:null});
 try{
  const rules=await h.call("GET","/v1/accounts/rules");
  assert.equal(rules.body.twoFactor.find(m=>m.method==="phone").available,false);
  assert.equal(rules.body.twoFactor.find(m=>m.method==="redxai_auth").available,false);
  assert.equal(rules.body.minAge,13);assert.equal(rules.body.centralMinAge,13);
  const r=await h.call("POST","/v1/accounts/signup",form({twoFactor:"phone",phone:"+15551234567",tosGrant:await h.agreedGrant()}));
  assert.equal(r.status,503);assert.equal(r.body.error,"sms_unavailable");
 }finally{h.close();}
});

test("quick sign-in (Google) can't skip the username, date of birth, warning, 2FA choice or Terms",async()=>{
 const h=await harness();
 try{
  const g=tok("g1",1000,"google.com","Quick@Example.com");
  let r=await h.call("GET","/v1/protected",undefined,g);
  assert.equal(r.status,403);assert.equal(r.body.code,"account_setup_required");
  r=await h.call("GET","/v1/accounts/me",undefined,g);
  assert.equal(r.status,404);assert.equal(r.body.quick.email,"Quick@Example.com");
  const base={username:"quick_rider",email:"quick@example.com",emailConfirm:"quick@example.com",dob:"01/02/1990",twoFactor:"none",acceptNo2faRisk:true,acknowledgeFalseInfo:true};
  for(const [over,want] of [[{tosGrant:undefined},"tos_required"],[{username:"quick"},"username_short"],[{dob:""},"dob_required"],[{dob:"01/02/2015"},"under_min_age"],
   [{acknowledgeFalseInfo:false},"false_info_ack_required"],[{twoFactor:""},"twofactor_invalid"],[{email:"other@example.com",emailConfirm:"other@example.com"},"email_mismatch"]]){
   r=await h.call("POST","/v1/accounts/complete",{...base,tosGrant:await h.agreedGrant(),...over},g);
   assert.equal(r.body.error,want,JSON.stringify(over));
  }
  r=await h.call("POST","/v1/accounts/complete",{...base,tosGrant:await h.agreedGrant()},g);
  assert.equal(r.status,201,JSON.stringify(r.body));
  assert.equal((await h.call("GET","/v1/protected",undefined,g)).status,200);
  r=await h.call("POST","/v1/accounts/complete",{...base,tosGrant:await h.agreedGrant()},g);
  assert.equal(r.body.error,"account_exists");
  const unverified=tok("g2",1,"github.com","x@example.com");
  r=await h.call("POST","/v1/accounts/complete",{...base,username:"other_rider",tosGrant:await h.agreedGrant()},unverified);
  assert.equal(r.body.error,"quick_signin_email");
 }finally{h.close();}
});

test("a new Terms version is required before the account is usable again",async()=>{
 const h=await harness();
 try{
  await h.call("POST","/v1/accounts/signup",form({twoFactor:"none",acceptNo2faRisk:true,tosGrant:await h.agreedGrant()}));
  await h.store.update("u1",{tosVersion:"gendragoon-tos-2026-01-01"});
  let r=await h.call("GET","/v1/protected",undefined,tok("u1",1));
  assert.equal(r.body.code,"tos_required");
  r=await h.call("POST","/v1/accounts/me/tos",{grant:await h.agreedGrant()},tok("u1",1));
  assert.equal(r.status,200);assert.equal(r.body.tosVersion,"gendragoon-tos-2026-10-19");
  assert.equal((await h.store.get("u1")).tosHistory.length,2);
  assert.equal((await h.call("GET","/v1/protected",undefined,tok("u1",1))).status,200);
 }finally{h.close();}
});

test("public checks are rate limited",async()=>{
 const h=await harness();
 try{
  let last;
  for(let i=0;i<61;i++)last=await h.call("POST","/v1/accounts/validate/username",{username:"probe_name_"+i});
  assert.equal(last.status,429);assert.equal(last.body.error,"rate_limited");
 }finally{h.close();}
});

test("account deletion removes the profile and frees the username and email",async()=>{
 const h=await harness();
 try{
  await h.call("POST","/v1/accounts/signup",form({twoFactor:"none",acceptNo2faRisk:true,tosGrant:await h.agreedGrant()}));
  assert.equal(await deleteProfileByHash(h.db,accountKey("u1")),true);
  assert.equal(await h.store.get("u1"),null);
  assert.equal(await h.store.usernameTaken("dragon_rider"),false);
  assert.equal(await h.store.emailTaken(R.emailKey("josh@example.com")),false);
  assert.equal(await deleteProfileByHash(h.db,accountKey("u1")),false);
 }finally{h.close();}
});

// ---- Red-XAI Accounts (OIDC)
function issuerFixture(){
 const ISS="https://accounts.red-xai.test";
 const {publicKey,privateKey}=crypto.generateKeyPairSync("ec",{namedCurve:"P-256"});
 const jwk={...publicKey.export({format:"jwk"}),kid:"k1",alg:"ES256",use:"sig"};
 const keys=[jwk];let jwksFetches=0;let userinfo={};
 const fetchImpl=async(url,opts)=>{
  const json=v=>({ok:true,json:async()=>v});
  if(url===ISS+"/.well-known/openid-configuration")return json({issuer:ISS,jwks_uri:ISS+"/oauth2/jwks"});
  if(url===ISS+"/oauth2/jwks"){jwksFetches++;return json({keys});}
  if(url===ISS+"/oauth2/userinfo")return json(userinfo[opts.headers.authorization.slice(7)]||{});
  return {ok:false,json:async()=>({})};
 };
 function sign(payload,{kid="k1",key=privateKey,alg="ES256"}={}){
  const enc=v=>Buffer.from(JSON.stringify(v)).toString("base64url");
  const head=enc({alg,kid,typ:"JWT"}),body=enc(payload);
  const sig=alg==="none"?"":crypto.sign("sha256",Buffer.from(head+"."+body),{key,dsaEncoding:"ieee-p1363"}).toString("base64url");
  return head+"."+body+"."+sig;
 }
 const claims=(over={})=>({iss:ISS,aud:"gendragoon",sub:"rxa_ABC",exp:Math.floor(NOW/1000)+600,iat:Math.floor(NOW/1000),scope:"openid profile email",sid:"s1",...over});
 return {ISS,fetchImpl,sign,claims,keys,setUserinfo:(token,v)=>{userinfo[token]=v;},fetches:()=>jwksFetches};
}

test("Red-XAI tokens: ES256 signature, issuer, audience, expiry, key rotation and unsigned tokens",async()=>{
 const f=issuerFixture();
 const v=createOidcVerifier({issuer:f.ISS,audience:"gendragoon",fetchImpl:f.fetchImpl,now:()=>NOW});
 assert.equal((await v.verify(f.sign(f.claims()))).sub,"rxa_ABC");
 const fails=async(token,code)=>{await assert.rejects(v.verify(token),e=>e.code===code,code);};
 await fails(f.sign(f.claims({aud:"rotten-apple"})),"token_audience");
 await fails(f.sign(f.claims({iss:"https://evil.test"})),"token_issuer");
 await fails(f.sign(f.claims({exp:Math.floor(NOW/1000)-120})),"token_expired");
 await fails(f.sign(f.claims(),{alg:"none"}),"token_alg");
 const other=crypto.generateKeyPairSync("ec",{namedCurve:"P-256"});
 await fails(f.sign(f.claims(),{key:other.privateKey}),"token_signature");
 await fails("not.a.jwt","token_malformed");
 const nonceToken=f.sign(f.claims({nonce:"n1"}));
 assert.equal((await v.verify(nonceToken,{nonce:"n1"})).nonce,"n1");
 await assert.rejects(v.verify(f.sign(f.claims({nonce:"n2"})),{nonce:"n1"}),e=>e.code==="token_nonce");
});

test("Red-XAI tokens: a new signing key is picked up after rotation",async()=>{
 const f=issuerFixture();let t=NOW;
 const v=createOidcVerifier({issuer:f.ISS,audience:"gendragoon",fetchImpl:f.fetchImpl,now:()=>t});
 await v.verify(f.sign(f.claims()));
 const rotated=crypto.generateKeyPairSync("ec",{namedCurve:"P-256"});
 f.keys.push({...rotated.publicKey.export({format:"jwk"}),kid:"k2",alg:"ES256",use:"sig"});
 const token=f.sign(f.claims(),{kid:"k2",key:rotated.privateKey});
 await assert.rejects(v.verify(token),e=>e.code==="token_key","refetch is rate limited to once a minute");
 t+=61_000;
 assert.equal((await v.verify(token)).sub,"rxa_ABC");
});

test("Red-XAI sign-in: Gendragoon re-checks the claims, needs its own Terms, honors amr, and links existing Firebase accounts",async()=>{
 const f=issuerFixture();
 const db=memoryFirestore();const store=createAccountStore({db,accountKey});
 const identity=createIdentity({firebaseVerify:async token=>{const [,uid]=token.split(".");return {uid,auth_time:1,email:"old@example.com",email_verified:true,firebase:{sign_in_provider:"google.com"}};},
  store,issuer:f.ISS,audience:"gendragoon",fetchImpl:f.fetchImpl,now:()=>NOW});
 const app=express();
 const accounts=registerAccounts({app,store,identify:identity.identify,createPasswordUser:async()=>{throw Error("unused");},deletePasswordUser:async()=>{},
  emailChecker:createEmailChecker({resolver:fakeResolver(DNS)}),sms:null,sealer:createSealer(crypto.randomBytes(32).toString("base64")),
  tosGate:createTosGate({key:crypto.randomBytes(32),now:()=>NOW}),now:()=>NOW,ipOf:()=>"x"});
 const gate=createLoginGate({verifyIdToken:identity.verifyForGate,accountsGate:user=>accounts.gate(user)});
 app.get("/v1/protected",gate.firebaseAuth,(req,res)=>res.json({uid:req.user.uid}));
 const server=await new Promise(r=>{const s=app.listen(0,"127.0.0.1",()=>r(s));});
 const base="http://127.0.0.1:"+server.address().port;
 const call=async(method,path,body,token)=>{const res=await fetch(base+path,{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},body:body&&JSON.stringify(body)});return {status:res.status,body:await res.json()};};
 const grant=async()=>{const tos=await call("GET","/v1/accounts/tos");const read=await call("POST","/v1/accounts/tos/read",{version:tos.body.version});return (await call("POST","/v1/accounts/tos/agree",{grant:read.body.grant})).body.grant;};
 try{
  // The v1 access token has no profile claims; they come from userinfo.
  const access=f.sign(f.claims());
  f.setUserinfo(access,{sub:"rxa_ABC",preferred_username:"dragon_rider",email:"josh@example.com",email_verified:true,age_band:"18plus"});
  let r=await call("GET","/v1/protected",undefined,access);
  assert.equal(r.status,403);assert.equal(r.body.code,"account_setup_required");
  r=await call("POST","/v1/accounts/complete",{acknowledgeFalseInfo:true},access);
  assert.equal(r.body.error,"tos_required");
  r=await call("POST","/v1/accounts/complete",{acknowledgeFalseInfo:true,tosGrant:await grant()},access);
  assert.equal(r.status,201,JSON.stringify(r.body));
  r=await call("GET","/v1/protected",undefined,access);
  assert.equal(r.status,200);assert.equal(r.body.uid,"rxa:rxa_ABC");
  const profile=await store.get("rxa:rxa_ABC");
  assert.equal(profile.identity.provider,"redxai");assert.equal(profile.ageBand,"18plus");assert.equal(profile.dob,null);

  // A token whose username breaks Gendragoon's rules, or with no age band, is refused.
  const bad=f.sign(f.claims({sub:"rxa_BAD",sid:"s2"}));
  f.setUserinfo(bad,{sub:"rxa_BAD",preferred_username:"_bad_name_",email:"b@example.com",email_verified:true,age_band:"18plus"});
  assert.equal((await call("POST","/v1/accounts/complete",{acknowledgeFalseInfo:true,tosGrant:await grant()},bad)).body.error,"username_edges");
  const young=f.sign(f.claims({sub:"rxa_KID",sid:"s3"}));
  f.setUserinfo(young,{sub:"rxa_KID",preferred_username:"young_player",email:"k@example.com",email_verified:true});
  assert.equal((await call("POST","/v1/accounts/complete",{acknowledgeFalseInfo:true,tosGrant:await grant()},young)).body.error,"under_min_age");

  // Migration: an existing Firebase account links its Red-XAI Account and keeps its uid (and workspaces).
  await store.create("legacyUid",{uid:"legacyUid",username:"legacy_user",usernameFolded:"legacy_user",email:"old@example.com",emailKey:"old@example.com",
   twoFactor:"none",twoFactorState:"off",tosVersion:"gendragoon-tos-2026-10-19",identity:{provider:"firebase"}},{usernameFolded:"legacy_user",emailKey:"old@example.com",grantId:"g-legacy",grantExpiresMs:1});
  const rxLegacy=f.sign(f.claims({sub:"rxa_OLD",sid:"s4",amr:["pwd","otp"]}));
  f.setUserinfo(rxLegacy,{sub:"rxa_OLD",preferred_username:"legacy_user",email:"old@example.com",email_verified:true,age_band:"18plus"});
  r=await call("POST","/v1/accounts/link/redxai",{redxaiToken:rxLegacy},"fb.legacyUid");
  assert.equal(r.status,200,JSON.stringify(r.body));
  r=await call("GET","/v1/protected",undefined,rxLegacy);
  assert.equal(r.body.uid,"legacyUid","Red-XAI token opens the old account");
  r=await call("POST","/v1/accounts/link/redxai",{redxaiToken:rxLegacy},"fb.someoneElse");
  assert.equal(r.body.error,"identity_linked_elsewhere");

  // Accounts with Gendragoon-managed 2FA accept the second factor proven at Red-XAI (amr).
  await store.update("legacyUid",{twoFactor:"app",twoFactorState:"active"});
  assert.equal((await call("GET","/v1/protected",undefined,rxLegacy)).status,200);
  const noMfa=f.sign(f.claims({sub:"rxa_OLD",sid:"s5",amr:["pwd"]}));
  f.setUserinfo(noMfa,{sub:"rxa_OLD",preferred_username:"legacy_user",email:"old@example.com",email_verified:true,age_band:"18plus"});
  assert.equal((await call("GET","/v1/protected",undefined,noMfa)).body.code,"two_factor_required");
 }finally{server.close();}
});

test("login gate without accounts keeps the old Google-only behavior",async()=>{
 const gate=createLoginGate({verifyIdToken:async()=>({uid:"u",firebase:{sign_in_provider:"password"}})});
 await assert.rejects(gate.readUser({headers:{authorization:"Bearer t"}},{terms:false}),e=>e.status===403);
});
