"use strict";
// Text-message provider interface: send({to,body}) -> Promise<{id}>. No real provider is connected yet.
// The mock records messages in memory and never sends anything; it is refused in production unless
// ACCOUNTS_ALLOW_MOCK_SMS=true (for staging), so production shows Phone as unavailable until a vendor is chosen.
class MockSmsProvider{
 constructor(){this.sent=[];this.mock=true;}
 async send({to,body}){
  const id="mock-"+(this.sent.length+1);
  this.sent.push({id,to,body,at:Date.now()});
  return {id};
 }
 lastTo(to){for(let i=this.sent.length-1;i>=0;i--)if(this.sent[i].to===to)return this.sent[i];return null;}
}
function smsProviderFromEnv(env=process.env){
 const kind=env.SMS_PROVIDER||"";
 if(kind==="mock"&&(env.NODE_ENV!=="production"||env.ACCOUNTS_ALLOW_MOCK_SMS==="true"))return new MockSmsProvider();
 return null;
}
module.exports={MockSmsProvider,smsProviderFromEnv};
