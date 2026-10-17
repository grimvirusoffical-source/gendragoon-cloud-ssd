"use strict";
class TransferGovernor{
 constructor(){this.states=new Map()}
 async run(id,workspace,operation){
  if(workspace.kind!=="free"||workspace.provisioned!==true)throw Error("Not provisioned");
  let state=this.states.get(id);
  if(!state){state={active:0,queue:[]};this.states.set(id,state)}
  if(state.queue.length>=20)throw Error("Too many transfers");
  return new Promise((resolve,reject)=>{
   state.queue.push({operation,resolve,reject});
   this.drain(id);
  });
 }
 drain(id){
  const state=this.states.get(id);if(!state||state.active>0||!state.queue.length)return;
  const task=state.queue.shift();state.active=1;
  Promise.resolve().then(task.operation).then(task.resolve,task.reject).finally(()=>{
    state.active=0;if(state.queue.length)this.drain(id);else this.states.delete(id);
  });
 }
}
module.exports={TransferGovernor};
