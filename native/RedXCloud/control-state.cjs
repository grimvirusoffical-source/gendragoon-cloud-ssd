'use strict';
const {RedXState,CloudError}=require('./redx-state.cjs');

class ControlState {
  constructor(options={}){
    this.receiver=new RedXState(options);
  }
  async get(owner){
    const parent=await this.receiver.get(owner);
    return parent?.control?structuredClone(parent.control):null;
  }
  async ensure(owner,seed){
    let parent=await this.receiver.get(owner);
    if(parent?.accountDeletion)throw new CloudError('account_deleted',410);
    if(!parent)parent=await this.receiver.ensure(owner,1);
    if(parent.control)return structuredClone(parent.control);
    const next=await this.receiver.change(owner,s=>{
      if(s.accountDeletion)throw new CloudError('account_deleted',410);
      if(!s.control)s.control={schema:1,owner,revision:0,createdMs:Date.now(),stripeCustomerId:null,adFree:false,projects:{},...structuredClone(seed)};
    });
    return structuredClone(next.control);
  }
  async change(owner,update){
    const next=await this.receiver.change(owner,s=>{
      if(s.accountDeletion)throw new CloudError('account_deleted',410);
      if(!s.control)throw new CloudError('control_not_found',404);
      const before=s.control.revision||0;
      update(s.control);
      s.control.revision=before+1;
    });
    return structuredClone(next.control);
  }
}
module.exports={ControlState};
