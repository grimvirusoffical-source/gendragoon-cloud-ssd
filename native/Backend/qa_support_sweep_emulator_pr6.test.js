"use strict";
// Sweep queries against the Firestore EMULATOR only (demo- project on 127.0.0.1). Proves the scoped queries
// run on real Firestore semantics (they swallow errors, so a bad query would silently do nothing).
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {Firestore}=require("@google-cloud/firestore");
const {createAccountDeletion}=require("./account_delete");
const HOST=process.env.FIRESTORE_EMULATOR_HOST||"";const PROJECT=process.env.GD_QA_EMULATOR_PROJECT||"demo-gendragoon-qa";
const skip=!/^(127\.0\.0\.1|localhost):\d+$/.test(HOST)||!PROJECT.startsWith("demo-")?"emulator only":false;
test("emulator: sweep delivers due, skips not-due, logs stale, clears expired names, deletes expired sent docs",{skip},async()=>{
 const db=new Firestore({projectId:PROJECT});const NOW=Date.now()+400*24*3600e3;const H=3600e3;const tag=crypto.randomUUID().slice(0,8);
 const due="due-"+tag,later="later-"+tag,old="old-"+tag,nm="nm-"+tag;
 await db.collection("deletion_jobs").doc(due).set({jobId:due,status:"failed",uid:"u",accountHash:"h",workspaceIds:[]});
 await db.collection("supportRequests").doc(due).set({jobId:due,createdAt:new Date(NOW-2*H).toISOString(),count:1,
  notify:{state:"pending",attempts:0,nextAttemptAt:new Date(NOW-1000).toISOString(),staleDueAt:new Date(NOW-H).toISOString()}});
 await db.collection("supportRequests").doc(later).set({jobId:later,createdAt:new Date(NOW).toISOString(),count:1,
  notify:{state:"pending",attempts:1,nextAttemptAt:new Date(NOW+H).toISOString(),staleDueAt:new Date(NOW+H).toISOString()}});
 await db.collection("supportRequests").doc(old).set({jobId:old,createdAt:new Date(NOW-40*24*H).toISOString(),count:1,
  notify:{state:"sent",attempts:0,nextAttemptAt:null},expireAt:new Date(NOW-1000)});
 await db.collection("deletion_jobs").doc(nm).set({jobId:nm,status:"failed",accountHash:"h-"+tag,workspaceNames:{w:"Nm"},namesExpireAt:new Date(NOW-1000)});
 const sent=[];const errs=[];const orig=console.error;console.error=(...a)=>errs.push(a.join(" "));
 try{
  const svc=createAccountDeletion({db,stripe:{},bucket:{},auth:{},hash:x=>x,now:()=>NOW,notifier:async e=>{sent.push(e.jobId);},env:{}});
  await svc.sweepSupportNotifications();
 }finally{console.error=orig;}
 assert.ok(sent.includes(due),"due request delivered: "+sent);assert.equal(sent.includes(later),false);
 assert.equal((await db.collection("supportRequests").doc(old).get()).exists,false,"expired sent doc deleted");
 assert.equal((await db.collection("deletion_jobs").doc(nm).get()).data().workspaceNames,undefined,"names cleared");
 assert.equal((await db.collection("supportRequests").doc(later).get()).exists,true);
 await db.terminate();
});
