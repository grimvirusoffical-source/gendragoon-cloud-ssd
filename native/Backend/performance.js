"use strict";
const {effectiveWorkers}=require("./billing_v2");
// Queue transfers per workspace and enforce a server-verified worker cap.
// The caller must pass a workspace record fetched from Firestore *after*
// verifying Firebase identity, account ownership, and Stripe entitlements.
class TransferGovernor {
 constructor(){this.states=new Map()}
 async run(workspaceId,workspace,operation){
   if(typeof operation!=="function")throw new TypeError("operation must be callable");
   const limit=effectiveWorkers(workspace);
   if(!Number.isInteger(limit)||limit<1||limit>24)throw Error("Storage not active");
   if(workspace.provisioned!==true)throw Error("Workspace storage not provisioned");
   let state=this.states.get(workspaceId);
   if(!state){state={active:0,queue:[],limit};this.states.set(workspaceId,state)}
   // Cap pending tasks so a user cannot exhaust server memory.
   state.limit=limit;
   if(state.queue.length>=100)throw Error("Too many queued transfers");
   return new Promise((resolve,reject)=>{
     state.queue.push({operation,resolve,reject,workspace,limit});
     this.drain(workspaceId);
   });
 }
 drain(id){
   const state=this.states.get(id);
   if(!state)return;
   // The pending task's snapshot reflects a verified subscription state.
   // Always recalculate for each task; a reduction takes effect for new starts.
   while(state.queue.length&&state.active<state.limit){
     const task=state.queue.shift();
     state.active++;
     Promise.resolve().then(task.operation).then(task.resolve,task.reject).finally(()=>{
       state.active--;this.drain(id);
       if(state.active===0&&state.queue.length===0)this.states.delete(id);
     });
   }
 }
}
function rcloneLimits(workspace){
 const workers=effectiveWorkers(workspace);
 if(workers===0)throw Error("Storage not active");
 // Fixed bounded arguments, never user-supplied CLI option text.
 return ["--transfers",String(workers),"--checkers",String(Math.max(1,Math.min(8,workers))),
  "--multi-thread-streams",String(Math.max(1,Math.min(8,workers)))];
}
module.exports={TransferGovernor,rcloneLimits};
