"use strict";
// /v1/accounts: Gendragoon sign-up, sign-in second factor and Terms, shaped like the Red-XAI Accounts v1 API
// (same field names, codes and ToS grant flow) so the apps can move to the central service by changing a base URL.
// While Red-XAI Accounts is not live, email sign-up is backed by Firebase Auth (createPasswordUser) and the profile
// lives in Firestore (store.js). Red-XAI tokens are accepted when REDXAI_ISSUER is set (identity.js).
const crypto=require("node:crypto");
const express=require("express");
const R=require("./rules");
const {StoreConflict}=require("./store");
const totpLib=require("./totp");
const {createLimiter}=require("./limiter");

const FALSE_INFO_WARNING="Use your real details. If any of them are false, we won't be able to recover your account.";
const NO_2FA_WARNING="Without two-factor sign-in, anyone who learns your password can get into your account. Red-XAI LLC isn't responsible if your account is compromised while two-factor sign-in is off.";
const SMS_TTL_MS=10*60_000,SMS_MAX_ATTEMPTS=5,SMS_PER_HOUR=5,MFA_REMEMBERED=10;
const MESSAGES={
 account_setup_required:"Finish setting up your account to continue.",
 tos_required:"Read and agree to the Terms of Service to continue.",
 two_factor_setup_required:"Finish setting up two-factor sign-in to continue.",
 two_factor_required:"Enter your two-factor code to continue.",
 username_taken:"That username is taken.",email_taken:"That email is already used by another account.",
 email_domain:"That email domain can't receive mail.",email_disposable:"Disposable email addresses can't be used. Use your own email or a business address.",email_unverifiable:"We couldn't check that email domain. Try again in a moment.",
 under_min_age:"You must be at least 13 to make an account.",sms_unavailable:"Text-message codes aren't available yet.",
 sms_send_failed:"We couldn't send the text message. Try again in a moment.",phone_undeliverable:"We can't send text messages to that number.",
 code_invalid:"That code isn't right.",rate_limited:"Too many tries. Wait a moment and try again.",
 quick_signin_email:"Your sign-in provider hasn't confirmed this email address.",
 managed_by_redxai:"This is managed in your Red-XAI Account.",
};
const httpError=(status,code,field,extra)=>Object.assign(new Error(code),{status,code,field,extra});
const sha=v=>crypto.createHash("sha256").update(String(v)).digest("hex");
const maskPhone=p=>p.slice(0,2)+"*".repeat(Math.max(0,p.length-6))+p.slice(-4);

function registerAccounts({app,store,identify,createPasswordUser,deletePasswordUser,emailChecker,sms,sealer,tosGate,
 minAge=R.MIN_AGE_FLOOR,now=()=>Date.now(),ipOf=req=>req.ip||"unknown"}){
 const terms=tosGate.terms;
 const appMinAge=R.effectiveMinAge(minAge);
 const limits={
  validate:createLimiter({limit:60,windowMs:60_000,now}),
  signup:createLimiter({limit:10,windowMs:10*60_000,now}),
  tos:createLimiter({limit:30,windowMs:60_000,now}),
  code:createLimiter({limit:10,windowMs:5*60_000,now}),
 };
 const router=express.Router();
 router.use(express.json({limit:"16kb"}));
 const wrap=fn=>(req,res)=>Promise.resolve(fn(req,res)).catch(error=>{
  if(res.headersSent)return;
  if(error instanceof StoreConflict)error=httpError(409,error.code,error.code.startsWith("username")?"username":error.code.startsWith("email")?"email":undefined);
  if(!error.status){console.error("accounts_error",String(error?.code||error?.name||"unknown"));return res.status(503).json({error:"unavailable",message:"Accounts are unavailable. Try again."});}
  if(error.code==="rate_limited"&&error.extra?.retryAfterS)res.set("Retry-After",String(error.extra.retryAfterS));
  const body={error:error.code,message:MESSAGES[error.code]||error.code.replace(/_/g," ")};
  if(error.field)body.field=error.field;
  if(error.extra?.errors)body.errors=error.extra.errors;
  if(error.extra?.pending)body.pending=error.extra.pending;
  res.status(error.status).json(body);
 });
 const limit=(name,key)=>{const r=limits[name](name+":"+key);if(!r.ok)throw httpError(429,"rate_limited",undefined,{retryAfterS:r.retryAfterS});};
 async function who(req,{required=true}={}){
  const m=/^Bearer ([A-Za-z0-9._~-]+)$/.exec(req.headers.authorization||"");
  if(!m){if(required)throw httpError(401,"unauthenticated");return null;}
  try{return await identify(m[1]);}catch(_){throw httpError(401,"invalid_token");}
 }
 const nowDate=()=>new Date(now());

 // ---- view and pending state
 function sessionVerified(profile,id){
  if(id.provider==="redxai"&&Array.isArray(id.amr)&&id.amr.some(a=>a==="otp"||a==="sms"||a==="mfa"))return true;
  return Array.isArray(profile.mfaVerified)&&profile.mfaVerified.includes(String(id.authTime));
 }
 function pendingFor(profile,id){
  if(!profile)return ["account_setup"];
  const p=[];
  // Red-XAI accounts accept the Gendragoon Terms centrally; the token's app_tos_version says which version.
  const accepted=id?.provider==="redxai"?id.appTosVersion:profile.tosVersion;
  if(accepted!==terms.version)p.push("tos");
  if(profile.twoFactorState==="pending")p.push("2fa_setup");
  else if(profile.twoFactorState==="active"&&!sessionVerified(profile,id))p.push("2fa");
  return p;
 }
 // Red-XAI Accounts already ran every sign-up rule (username, 13+, false-information warning, 2FA choice, both
 // Terms), so a Red-XAI account gets its Gendragoon profile on first use, built from the access token.
 async function profileFor(id){
  const existing=await store.get(id.uid);
  if(existing||id.provider!=="redxai")return existing;
  if(id.ageBand!=="13to17"&&id.ageBand!=="18plus")throw httpError(403,"under_min_age","dob");
  const t=now();
  return store.provision(id.uid,{uid:id.uid,username:id.username||null,usernameFolded:null,email:id.email?R.normalizeEmail(id.email):null,emailKey:null,
   emailVerified:id.emailVerified===true,dob:null,ageBand:id.ageBand,twoFactor:"central",twoFactorState:"off",tosVersion:id.appTosVersion||null,
   tosAcceptedMs:null,tosApp:"redxai",identity:{provider:"redxai",issuer:id.issuer,sub:id.sub},signupApp:"redxai",mfaVerified:[],createdMs:t,updatedMs:t});
 }
 function view(profile,id){
  const dob=R.birthDateFromIso(profile.dob||"");
  const age=dob?R.ageOn(dob,nowDate()):null;
  return {username:profile.username,email:profile.email,emailVerified:profile.emailVerified===true,
   age,ageBand:age===null?profile.ageBand||null:age>=18?"18plus":"13to17",
   twoFactor:profile.twoFactor,twoFactorState:profile.twoFactorState,phoneMasked:profile.phoneMasked||null,
   tosVersion:id?.provider==="redxai"?id.appTosVersion:profile.tosVersion,tosCurrent:terms.version,tosAcceptedMs:profile.tosAcceptedMs,
   identity:profile.identity?.provider||"firebase",createdMs:profile.createdMs,pending:pendingFor(profile,id)};
 }

 // ---- second factor helpers
 async function sendSmsCode(uid,profile,purpose){
  if(!sms)throw httpError(503,"sms_unavailable","twoFactor");
  const t=now();
  const sent=(profile.smsSent||[]).filter(x=>t-x<3600_000);
  if(sent.length>=SMS_PER_HOUR)throw httpError(429,"rate_limited",undefined,{retryAfterS:Math.ceil((sent[0]+3600_000-t)/1000)});
  const phoneEnc=purpose==="enroll"?profile.phonePendingEnc:profile.phoneEnc;
  const phone=sealer.open(phoneEnc,"phone:"+uid);
  const code=String(crypto.randomInt(0,1_000_000)).padStart(6,"0");
  await store.update(uid,{smsCodeHash:sha(uid+"|"+purpose+"|"+code),smsCodeExpMs:t+SMS_TTL_MS,smsCodePurpose:purpose,smsAttempts:0,smsSent:[...sent,t]});
  try{await sms.send({to:phone,body:"Your Gendragoon code is "+code+". It expires in 10 minutes. Don't share it with anyone."});}
  catch(error){
   // The undelivered code is withdrawn; the attempt still counts toward the hourly limit.
   await store.update(uid,{smsCodeHash:null,smsCodeExpMs:0,smsCodePurpose:null,smsAttempts:0});
   if(error?.code==="sms_bad_number")throw httpError(400,"phone_undeliverable","phone");
   throw httpError(502,"sms_send_failed","twoFactor");
  }
 }
 async function checkSmsCode(uid,profile,purpose,code){
  if(profile.smsCodePurpose!==purpose||!profile.smsCodeHash||profile.smsCodeExpMs<now()||(profile.smsAttempts||0)>=SMS_MAX_ATTEMPTS)return false;
  const good=typeof code==="string"&&/^\d{6}$/.test(code)&&crypto.timingSafeEqual(Buffer.from(sha(uid+"|"+purpose+"|"+code)),Buffer.from(profile.smsCodeHash));
  await store.update(uid,good?{smsCodeHash:null,smsCodeExpMs:0,smsCodePurpose:null,smsAttempts:0}:{smsAttempts:(profile.smsAttempts||0)+1});
  return good;
 }
 // An active method stays in force until the new one is confirmed.
 const methodPatch=(profile,method)=>profile.twoFactorState==="active"?{twoFactorPending:method}:{twoFactor:method,twoFactorPending:method,twoFactorState:"pending"};
 // Starts the chosen method. Returns {totp?} for the response.
 async function beginTwoFactor(uid,profile,{method,phone,acceptNo2faRisk}){
  const t=now();
  if(method==="none"){
   if(acceptNo2faRisk!==true)throw httpError(400,"no2fa_ack_required","twoFactor");
   await store.update(uid,{twoFactor:"none",twoFactorPending:null,twoFactorState:"off",no2faAckMs:t,totpSecretEnc:null,totpPendingEnc:null,phoneEnc:null,phonePendingEnc:null,phoneMasked:null,updatedMs:t});
   return {};
  }
  if(!sealer.ready)throw httpError(503,"unavailable");
  if(method==="app"){
   const secret=totpLib.generateSecret();
   await store.update(uid,{...methodPatch(profile,"app"),totpPendingEnc:sealer.seal(secret,"totp:"+uid),updatedMs:t});
   return {totp:{secret,otpauthUri:totpLib.otpauthUri({secret,account:profile.username})}};
  }
  if(method==="phone"){
   if(!sms)throw httpError(503,"sms_unavailable","twoFactor");
   const check=R.checkPhone(phone);if(!check.ok)throw httpError(400,check.code,"phone");
   const e164=R.normalizePhone(phone);
   const patch={...methodPatch(profile,"phone"),phonePendingEnc:sealer.seal(e164,"phone:"+uid),phonePendingMasked:maskPhone(e164),updatedMs:t};
   await store.update(uid,patch);
   await sendSmsCode(uid,{...profile,...patch},"enroll");
   return {phoneMasked:maskPhone(e164)};
  }
  if(method==="redxai_auth")throw httpError(400,"twofactor_unavailable","twoFactor");
  throw httpError(400,"twofactor_invalid","twoFactor");
 }

 // ---- public: rules, Terms, real-time validation
 router.get("/rules",(req,res)=>res.json({username:{min:R.USERNAME_MIN,max:R.USERNAME_MAX,minLetters:R.USERNAME_MIN_LETTERS,chars:"A-Z a-z 0-9 _ . -",noEdgeSeparators:true},
  password:{min:R.PASSWORD_MIN,max:R.PASSWORD_MAX,special:R.PASSWORD_SYMBOLS},dob:{format:"MM/DD/YYYY",ageMax:R.AGE_MAX},
  minAge:appMinAge,centralMinAge:R.MIN_AGE_FLOOR,tosVersion:terms.version,
  twoFactor:[{method:"app",available:sealer.ready},{method:"phone",available:Boolean(sms)&&sealer.ready},{method:"redxai_auth",available:false,label:"Coming soon"},{method:"none",available:true}]}));
 router.get("/tos",(req,res)=>res.json({version:terms.version,title:terms.title,text:terms.text,falseInfoWarning:FALSE_INFO_WARNING,no2faWarning:NO_2FA_WARNING}));
 router.post("/tos/read",wrap(async(req,res)=>{
  limit("tos",ipOf(req));
  const r=tosGate.read(req.body?.version);if(!r.ok)throw httpError(r.status,r.code);
  res.json({grant:r.grant,stage:r.stage,version:r.version});
 }));
 router.post("/tos/agree",wrap(async(req,res)=>{
  limit("tos",ipOf(req));
  const r=tosGate.agree(req.body?.grant);if(!r.ok)throw httpError(r.status,r.code);
  res.json({grant:r.grant,stage:r.stage,version:r.version});
 }));
 const checks=(list)=>({ok:list.every(c=>c.ok),checks:list,...(list.find(c=>!c.ok)?{error:list.find(c=>!c.ok).code}:{})});
 router.post("/validate/username",wrap(async(req,res)=>{
  limit("validate",ipOf(req));
  const v=req.body?.username;const c=R.checkUsername(v);
  const list=[{id:"rules",ok:c.ok,code:c.ok?undefined:c.code}];
  if(c.ok)list.push({id:"available",ok:!(await store.usernameTaken(R.usernameKey(v))),code:"username_taken"});
  res.json(checks(list.map(x=>x.ok?{id:x.id,ok:true}:x)));
 }));
 router.post("/validate/password",wrap(async(req,res)=>{
  limit("validate",ipOf(req));
  const c=R.checkPassword(req.body?.password);
  res.json(checks([c.ok?{id:"rules",ok:true}:{id:"rules",ok:false,code:c.code}]));
 }));
 router.post("/validate/dob",wrap(async(req,res)=>{
  limit("validate",ipOf(req));
  const c=R.checkBirthDate(req.body?.dob,{now:nowDate(),minAge:appMinAge});
  res.json({...checks([c.ok?{id:"dob",ok:true}:{id:"dob",ok:false,code:c.code}]),minAge:appMinAge});
 }));
 router.post("/validate/email",wrap(async(req,res)=>{
  limit("validate",ipOf(req));
  const v=req.body?.email;const f=R.checkEmailFormat(v);
  if(!f.ok)return res.json(checks([{id:"syntax",ok:false,code:f.code}]));
  const d=await emailChecker.check(v);
  if(!d.ok&&d.code==="email_disposable")return res.json(checks([{id:"syntax",ok:true},{id:"disposable",ok:false,code:d.code}]));
  if(!d.ok)return res.json(checks([{id:"syntax",ok:true},{id:"disposable",ok:true},{id:"domain",ok:false,code:d.code}]));
  const taken=await store.emailTaken(R.emailKey(v));
  res.json(checks([{id:"syntax",ok:true},{id:"disposable",ok:true},{id:"domain",ok:true},taken?{id:"available",ok:false,code:"email_taken"}:{id:"available",ok:true}]));
 }));

 // ---- shared server-side checks for every way in (email sign-up and quick sign-in completion)
 async function enforceSignup(body,{requirePassword}){
  const errors=R.validateSignup(body,{now:nowDate(),minAge:appMinAge,requirePassword});
  const first=Object.keys(errors)[0];
  if(first)throw httpError(errors.dob==="under_min_age"?403:400,errors[first],first,{errors});
  const grant=tosGate.verifyAgreed(body.tosGrant);
  if(!grant.ok)throw httpError(grant.code==="tos_changed"?409:400,grant.code,"tosGrant");
  const deliverable=await emailChecker.check(body.email);
  if(!deliverable.ok)throw httpError(deliverable.code==="email_unverifiable"?503:400,deliverable.code,"email");
  if(await store.usernameTaken(R.usernameKey(body.username)))throw httpError(409,"username_taken","username");
  if(await store.emailTaken(R.emailKey(body.email)))throw httpError(409,"email_taken","email");
  if(body.twoFactor==="phone"&&!sms)throw httpError(503,"sms_unavailable","twoFactor");
  if(body.twoFactor!=="none"&&!sealer.ready)throw httpError(503,"unavailable");
  return grant;
 }
 function newProfile(uid,body,grant,identity){
  const t=now();
  return {uid,username:body.username,usernameFolded:R.usernameKey(body.username),email:R.normalizeEmail(body.email),emailKey:R.emailKey(body.email),
   emailVerified:identity.emailVerified===true,dob:R.birthDateToIso(R.parseBirthDate(body.dob)),
   twoFactor:body.twoFactor,twoFactorState:body.twoFactor==="none"?"off":"pending",no2faAckMs:body.twoFactor==="none"?t:null,
   tosVersion:grant.version,tosAcceptedMs:grant.agreedMs,tosReadMs:grant.readMs,tosApp:"gendragoon",tosHistory:[{version:grant.version,acceptedMs:grant.agreedMs}],
   falseInfoWarnedMs:t,identity:{provider:identity.provider,signInProvider:identity.signInProvider||null,issuer:identity.issuer||null,sub:identity.sub||null},
   signupApp:"gendragoon",mfaVerified:[],createdMs:t,updatedMs:t};
 }
 async function finishSignup(res,uid,profile,body,id){
  let extra={};
  if(body.twoFactor!=="none"){
   // The account already exists here, so a failed text message must not look like a failed sign-up:
   // it is reported alongside the 201 and the app offers to resend or pick another method.
   try{extra=await beginTwoFactor(uid,profile,{method:body.twoFactor,phone:body.phone});}
   catch(error){if(error?.code!=="sms_send_failed"&&error?.code!=="phone_undeliverable")throw error;
    extra={smsError:error.code,smsMessage:MESSAGES[error.code]};}
  }
  const fresh=await store.get(uid);
  res.status(201).json({account:view(fresh,id),pending:pendingFor(fresh,id),...extra});
 }

 // Email sign-up. The account exists only after this call succeeds with an agreed ToS grant.
 router.post("/signup",wrap(async(req,res)=>{
  limit("signup",ipOf(req));
  const body=req.body||{};
  const grant=await enforceSignup(body,{requirePassword:true});
  let uid;
  try{uid=await createPasswordUser(R.normalizeEmail(body.email),body.password);}
  catch(error){if(error?.code==="email_taken"||error?.code==="auth/email-already-exists")throw httpError(409,"email_taken","email");throw error;}
  const id={provider:"firebase",signInProvider:"password",emailVerified:false};
  const profile=newProfile(uid,body,grant,id);
  try{await store.create(uid,profile,{usernameFolded:profile.usernameFolded,emailKey:profile.emailKey,grantId:grant.id,grantExpiresMs:grant.expiresMs});}
  catch(error){await deletePasswordUser(uid).catch(()=>{});throw error;}
  await finishSignup(res,uid,profile,body,{...id,authTime:null});
 }));

 // Quick sign-in completion (Google through Firebase, or a Red-XAI token without a Gendragoon profile yet).
 // Quick paths never skip the username, date of birth, warning, 2FA choice or ToS rules.
 router.post("/complete",wrap(async(req,res)=>{
  const id=await who(req);
  limit("signup",ipOf(req));
  if(id.provider!=="redxai"&&await store.get(id.uid))throw httpError(409,"account_exists");
  const body={...(req.body||{})};
  if(id.provider==="redxai"){
   // Nothing to complete: the profile is made from the token (profileFor). Kept for apps that still call it.
   const profile=await profileFor(id);
   return res.status(200).json({account:view(profile,id),pending:pendingFor(profile,id)});
  }
  if(id.emailVerified!==true||!id.email)throw httpError(403,"quick_signin_email","email");
  if(R.normalizeEmail(body.email||"")!==R.normalizeEmail(id.email))throw httpError(400,"email_mismatch","email");
  const grant=await enforceSignup(body,{requirePassword:false});
  const profile=newProfile(id.uid,body,grant,id);
  await store.create(id.uid,profile,{usernameFolded:profile.usernameFolded,emailKey:profile.emailKey,grantId:grant.id,grantExpiresMs:grant.expiresMs});
  await finishSignup(res,id.uid,profile,body,id);
 }));

 router.get("/me",wrap(async(req,res)=>{
  const id=await who(req);const profile=await profileFor(id);
  if(!profile)return res.status(404).json({error:"account_setup_required",message:MESSAGES.account_setup_required,pending:["account_setup"],
   quick:{email:id.email||null,emailVerified:id.emailVerified===true,provider:id.provider}});
  res.json(view(profile,id));
 }));
 router.post("/me/tos",wrap(async(req,res)=>{
  const id=await who(req);
  if(id.provider==="redxai")throw httpError(409,"managed_by_redxai");
  const grant=tosGate.verifyAgreed(req.body?.grant);if(!grant.ok)throw httpError(grant.code==="tos_changed"?409:400,grant.code,"grant");
  const profile=await store.get(id.uid);if(!profile)throw httpError(403,"account_setup_required");
  await store.acceptTerms(id.uid,{tosVersion:grant.version,tosAcceptedMs:grant.agreedMs,tosReadMs:grant.readMs,
   tosHistory:[...(profile.tosHistory||[]).slice(-19),{version:grant.version,acceptedMs:grant.agreedMs}],updatedMs:now()},{grantId:grant.id,grantExpiresMs:grant.expiresMs});
  res.json(view(await store.get(id.uid),id));
 }));
 router.post("/me/2fa/setup",wrap(async(req,res)=>{
  const id=await who(req);const profile=await store.get(id.uid);
  if(!profile)throw httpError(403,"account_setup_required");
  if(profile.twoFactor==="central")throw httpError(409,"managed_by_redxai");
  // Changing an active method needs this session to have passed the second factor.
  if(profile.twoFactorState==="active"&&!sessionVerified(profile,id))throw httpError(403,"two_factor_required");
  const extra=await beginTwoFactor(id.uid,profile,req.body||{});
  res.json({...extra,account:view(await store.get(id.uid),id)});
 }));
 router.post("/me/2fa/confirm",wrap(async(req,res)=>{
  const id=await who(req);limit("code",id.uid);
  const profile=await store.get(id.uid);if(!profile)throw httpError(403,"account_setup_required");
  const code=String(req.body?.code||"").replace(/\s/g,"");const t=now();
  let patch=null;
  if(profile.totpPendingEnc&&profile.twoFactorPending==="app"){
   const secret=sealer.open(profile.totpPendingEnc,"totp:"+id.uid);
   const step=totpLib.verifyTotp(secret,code,t);
   if(step>=0)patch={totpSecretEnc:profile.totpPendingEnc,totpPendingEnc:null,totpLastStep:step,phoneEnc:null,phoneMasked:null};
  }else if(profile.phonePendingEnc&&profile.twoFactorPending==="phone"){
   if(await checkSmsCode(id.uid,profile,"enroll",code))patch={phoneEnc:profile.phonePendingEnc,phoneMasked:profile.phonePendingMasked,phonePendingEnc:null,phonePendingMasked:null,totpSecretEnc:null};
  }else throw httpError(409,"nothing_to_confirm");
  if(!patch)throw httpError(400,"code_invalid","code");
  // Confirming proves the factor for this session too.
  await store.update(id.uid,{...patch,twoFactor:profile.twoFactorPending,twoFactorPending:null,twoFactorState:"active",no2faAckMs:null,mfaVerified:[...(profile.mfaVerified||[]),String(id.authTime)].slice(-MFA_REMEMBERED),updatedMs:t});
  res.json(view(await store.get(id.uid),id));
 }));
 // Sign-in second factor for the current session (Firebase sessions; Red-XAI sessions carry it in amr).
 router.post("/2fa/sms/send",wrap(async(req,res)=>{
  const id=await who(req);const profile=await store.get(id.uid);
  if(!profile||profile.twoFactor!=="phone"||profile.twoFactorState!=="active")throw httpError(409,"nothing_to_send");
  await sendSmsCode(id.uid,profile,"login");
  res.json({sent:true,phoneMasked:profile.phoneMasked});
 }));
 router.post("/2fa/verify",wrap(async(req,res)=>{
  const id=await who(req);limit("code",id.uid);
  const profile=await store.get(id.uid);
  if(!profile||profile.twoFactorState!=="active")throw httpError(409,"nothing_to_verify");
  const code=String(req.body?.code||"").replace(/\s/g,"");let ok=false;const patch={};
  if(profile.twoFactor==="app"){
   const step=totpLib.verifyTotp(sealer.open(profile.totpSecretEnc,"totp:"+id.uid),code,now(),{lastStep:profile.totpLastStep??-1});
   if(step>=0){ok=true;patch.totpLastStep=step;}
  }else if(profile.twoFactor==="phone")ok=await checkSmsCode(id.uid,profile,"login",code);
  if(!ok)throw httpError(400,"code_invalid","code");
  await store.update(id.uid,{...patch,mfaVerified:[...(profile.mfaVerified||[]),String(id.authTime)].slice(-MFA_REMEMBERED)});
  res.json(view(await store.get(id.uid),id));
 }));
 // Migration: a signed-in Firebase account links its Red-XAI Account, so Red-XAI tokens open the same workspaces.
 router.post("/link/redxai",wrap(async(req,res)=>{
  const id=await who(req);
  if(id.provider!=="firebase")throw httpError(400,"link_requires_firebase_session");
  let rx;try{rx=await identify(String(req.body?.redxaiToken||""),{linking:true});}catch(_){throw httpError(401,"invalid_token","redxaiToken");}
  if(!rx||rx.provider!=="redxai")throw httpError(400,"invalid_token","redxaiToken");
  await store.link(rx.issuer,rx.sub,id.uid,now());
  await store.update(id.uid,{identity:{provider:"redxai",issuer:rx.issuer,sub:rx.sub,migratedFrom:"firebase"},updatedMs:now()});
  res.json({linked:true});
 }));
 app.use("/v1/accounts",router);

 // Gate for every other signed-in route: the profile must exist, carry the current Terms, and have its second
 // factor set up and passed for this session.
 async function gate(user){
  const id=user.__identity||{provider:"firebase",authTime:user.auth_time};
  const profile=await profileFor({...id,uid:user.uid});
  const pending=pendingFor(profile,id);
  if(pending.length===0)return profile;
  const code={account_setup:"account_setup_required",tos:"tos_required","2fa_setup":"two_factor_setup_required","2fa":"two_factor_required"}[pending[0]];
  throw Object.assign(Error(code),{status:403,expose:MESSAGES[code],code,pending});
 }
 return {gate,view,pendingFor};
}
module.exports={registerAccounts,FALSE_INFO_WARNING,NO_2FA_WARNING};
