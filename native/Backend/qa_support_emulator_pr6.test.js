"use strict";
// Real-contention repeat-send test against the Firestore EMULATOR only (demo- project, 127.0.0.1). Skips otherwise.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {Firestore}=require("@google-cloud/firestore");
const {createAccountDeletion,whenSupportSettled}=require("./account_delete");
const HOST=process.env.FIRESTORE_EMULATOR_HOST||"";const PROJECT=process.env.GD_QA_EMULATOR_PROJECT||"demo-gendragoon-qa";
const skip=!/^(127\.0\.0\.1|localhost):\d+$/.test(HOST)||!PROJECT.startsWith("demo-")?"emulator only":false;
const ROUNDS=Number(process.env.GD_QA_ROUNDS||10);
test("emulator: 8 instances send the same support request at once -> one alert, <=5 accepted, same requestId",{skip},async()=>{
 for(let round=0;round<ROUNDS;round++){
  const jobId=crypto.randomUUID();const token=crypto.randomBytes(32).toString("base64url");
  const seed=new Firestore({projectId:PROJECT});
  await seed.collection("deletion_jobs").doc(jobId).set({jobId,status:"failed",accountHash:"h"+round,uid:"u",failureReason:"stripe_authentication_error",
   attempts:1,workspaceIds:["w1"],statusTokens:[{hash:crypto.createHash("sha256").update(token).digest("hex"),expiresAtMs:Date.now()+3600e3}]});
  const alerts=[];
  const insts=Array.from({length:8},()=>{const db=new Firestore({projectId:PROJECT});
   return {db,svc:createAccountDeletion({db,stripe:{},bucket:{},auth:{},hash:x=>x,notifier:async e=>{alerts.push(e.jobId);await new Promise(r=>setTimeout(r,20));},env:{}})};});
  const res=await Promise.allSettled(insts.map(i=>i.svc.requestSupport({params:{jobId},headers:{authorization:"Bearer "+token}})));
  await whenSupportSettled();
  const ok=res.filter(r=>r.status==="fulfilled"),lim=res.filter(r=>r.status==="rejected"&&r.reason?.status===429);
  assert.equal(ok.length+lim.length,8,res.filter(r=>r.status==="rejected"&&r.reason?.status!==429).map(r=>String(r.reason?.code||r.reason)).join());
  assert.equal(ok.length,5,"round "+round);assert.equal(new Set(ok.map(r=>r.value.requestId)).size,1);
  assert.equal(alerts.length,1,"round "+round+" alerts "+alerts.length);
  const doc=(await seed.collection("supportRequests").doc(jobId).get()).data();assert.equal(doc.count,5);assert.equal(doc.notify.state,"sent");
  await Promise.all([seed,...insts.map(i=>i.db)].map(d=>d.terminate()));
 }
});
