"use strict";
// Wires Gendragoon accounts into the server from the environment.
//   ACCOUNTS_SEAL_KEY   32 random bytes, base64 (seals 2FA secrets and phone numbers, signs ToS grants). Required in production.
//   ACCOUNTS_MIN_AGE    optional; values below 13 are raised to 13.
//   REDXAI_ISSUER       optional; Red-XAI Accounts issuer URL. When set, Red-XAI tokens are accepted.
//   REDXAI_AUDIENCES    comma-separated client ids whose access tokens are accepted (default "gendragoon", the public
//                       client the apps sign in with). REDXAI_CLIENT_ID is the older single-value name.
//   REDXAI_BACKEND_CLIENT_ID / REDXAI_BACKEND_CLIENT_SECRET  the confidential "gendragoon-backend" client used for the
//                       back-channel (account status, event feed); see backchannel.js.
//   TWILIO_*            optional; turns on phone 2FA codes through Twilio (see sms.js). Unset keeps Phone unavailable.
//   SMS_PROVIDER=mock   staging only (see sms.js).
const crypto=require("node:crypto");
const {createSealer}=require("./seal");
const {createTosGate}=require("./tos");
const {createEmailChecker}=require("./email_check");
const {smsProviderFromEnv,smsConfigProblem}=require("./sms");
const {createAccountStore}=require("./store");
const {createIdentity}=require("./identity");
const {registerAccounts}=require("./routes");

function deriveKey(sealKey,label){return crypto.createHmac("sha256",sealKey).update("gendragoon-accounts:"+label).digest();}

function redxaiAudiences(env){
 const list=String(env.REDXAI_AUDIENCES||env.REDXAI_CLIENT_ID||"gendragoon").split(",").map(v=>v.trim()).filter(Boolean);
 return list.length?list:["gendragoon"];
}
function installAccounts({app,db,accountKey,firebaseAuth,env=process.env,now=()=>Date.now(),emailChecker,sms,fetchImpl}){
 const raw=env.ACCOUNTS_SEAL_KEY?Buffer.from(env.ACCOUNTS_SEAL_KEY,"base64"):null;
 const configured=Boolean(raw&&raw.length===32);
 // Without the key (local runs, tests) a per-process key keeps everything working; start() refuses this in production.
 const sealKey=configured?raw:crypto.randomBytes(32);
 const store=createAccountStore({db,accountKey});
 const identity=createIdentity({firebaseVerify:token=>firebaseAuth().verifyIdToken(token),store,
  issuer:env.REDXAI_ISSUER||null,audience:redxaiAudiences(env),fetchImpl,now});
 const accounts=registerAccounts({app,store,identify:identity.identify,
  async createPasswordUser(email,password){
   try{return (await firebaseAuth().createUser({email,password,emailVerified:false})).uid;}
   catch(error){if(error?.code==="auth/email-already-exists")throw Object.assign(Error("email_taken"),{code:"email_taken"});throw error;}
  },
  deletePasswordUser:uid=>firebaseAuth().deleteUser(uid),
  emailChecker:emailChecker||createEmailChecker({now}),
  sms:sms===undefined?smsProviderFromEnv(env,{fetchImpl}):sms,
  sealer:createSealer(sealKey.toString("base64")),
  tosGate:createTosGate({key:deriveKey(sealKey,"tos"),now}),
  minAge:env.ACCOUNTS_MIN_AGE?Number(env.ACCOUNTS_MIN_AGE):undefined,now});
 return {configured,store,identity,gate:accounts.gate,view:accounts.view};
}
function accountsStartup(env=process.env){
 const production=env.NODE_ENV==="production"||Boolean(env.K_SERVICE);
 const raw=env.ACCOUNTS_SEAL_KEY?Buffer.from(env.ACCOUNTS_SEAL_KEY,"base64"):null;
 if(production&&!(raw&&raw.length===32))return {exit:true,message:"ACCOUNTS_SEAL_KEY (32 bytes, base64) is required"};
 // Phone 2FA is optional: a broken Twilio setup only switches Phone off, so it warns instead of stopping the server.
 const smsProblem=smsConfigProblem(env);
 if(smsProblem)return {exit:false,warn:true,message:"Phone two-factor codes are off: "+smsProblem};
 return {exit:false};
}
module.exports={installAccounts,accountsStartup,redxaiAudiences};
