"use strict";
// Wires Gendragoon accounts into the server from the environment.
//   ACCOUNTS_SEAL_KEY   32 random bytes, base64 (seals 2FA secrets and phone numbers, signs ToS grants). Required in production.
//   ACCOUNTS_MIN_AGE    optional; values below 13 are raised to 13.
//   REDXAI_ISSUER       optional; Red-XAI Accounts issuer URL. When set, Red-XAI tokens are accepted.
//   REDXAI_CLIENT_ID    the OAuth client id Gendragoon is registered under (default "gendragoon").
//   SMS_PROVIDER=mock   staging only (see sms.js).
const crypto=require("node:crypto");
const {createSealer}=require("./seal");
const {createTosGate}=require("./tos");
const {createEmailChecker}=require("./email_check");
const {smsProviderFromEnv}=require("./sms");
const {createAccountStore}=require("./store");
const {createIdentity}=require("./identity");
const {registerAccounts}=require("./routes");

function deriveKey(sealKey,label){return crypto.createHmac("sha256",sealKey).update("gendragoon-accounts:"+label).digest();}

function installAccounts({app,db,accountKey,firebaseAuth,env=process.env,now=()=>Date.now(),emailChecker,sms,fetchImpl}){
 const raw=env.ACCOUNTS_SEAL_KEY?Buffer.from(env.ACCOUNTS_SEAL_KEY,"base64"):null;
 const configured=Boolean(raw&&raw.length===32);
 // Without the key (local runs, tests) a per-process key keeps everything working; start() refuses this in production.
 const sealKey=configured?raw:crypto.randomBytes(32);
 const store=createAccountStore({db,accountKey});
 const identity=createIdentity({firebaseVerify:token=>firebaseAuth().verifyIdToken(token),store,
  issuer:env.REDXAI_ISSUER||null,audience:env.REDXAI_CLIENT_ID||"gendragoon",fetchImpl,now});
 const accounts=registerAccounts({app,store,identify:identity.identify,
  async createPasswordUser(email,password){
   try{return (await firebaseAuth().createUser({email,password,emailVerified:false})).uid;}
   catch(error){if(error?.code==="auth/email-already-exists")throw Object.assign(Error("email_taken"),{code:"email_taken"});throw error;}
  },
  deletePasswordUser:uid=>firebaseAuth().deleteUser(uid),
  emailChecker:emailChecker||createEmailChecker({now}),
  sms:sms===undefined?smsProviderFromEnv(env):sms,
  sealer:createSealer(sealKey.toString("base64")),
  tosGate:createTosGate({key:deriveKey(sealKey,"tos"),now}),
  minAge:env.ACCOUNTS_MIN_AGE?Number(env.ACCOUNTS_MIN_AGE):undefined,now});
 return {configured,store,identity,gate:accounts.gate,view:accounts.view};
}
function accountsStartup(env=process.env){
 const production=env.NODE_ENV==="production"||Boolean(env.K_SERVICE);
 const raw=env.ACCOUNTS_SEAL_KEY?Buffer.from(env.ACCOUNTS_SEAL_KEY,"base64"):null;
 if(production&&!(raw&&raw.length===32))return {exit:true,message:"ACCOUNTS_SEAL_KEY (32 bytes, base64) is required"};
 return {exit:false};
}
module.exports={installAccounts,accountsStartup};
