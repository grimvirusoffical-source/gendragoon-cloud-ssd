'use strict';
(function(){
 const runtime=globalThis.browser?.runtime||globalThis.chrome?.runtime,rpc=globalThis.GDCompanionRPC;
 class Client{
  constructor(){this.port=null;this.pending=new Map();}
  connect(){if(this.port)return;if(!runtime?.connectNative)throw new Error('Native messaging is unavailable in this browser.');const port=runtime.connectNative(rpc.HOST);this.port=port;port.onMessage.addListener(response=>{const p=this.pending.get(response?.id);if(!p)return;this.pending.delete(response.id);clearTimeout(p.timer);try{p.resolve(rpc.result(response,response.id));}catch(error){p.reject(error);}});port.onDisconnect.addListener(()=>{void runtime.lastError;this.port=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('The native companion disconnected. Open GenDragoon and install/approve this browser client.'));}this.pending.clear();});}
  call(method,params={}){const value=rpc.request(method,params);if(new TextEncoder().encode(JSON.stringify(value)).length>rpc.MAX_FRAME)return Promise.reject(new Error('The companion request exceeds the message limit.'));if(this.pending.size>=32)return Promise.reject(new Error('Wait for the current companion requests to finish.'));return new Promise((resolve,reject)=>{try{this.connect();const timer=setTimeout(()=>{this.pending.delete(value.id);reject(new Error('The companion request timed out. Check the GenDragoon approval window before retrying.'));},40000);this.pending.set(value.id,{resolve,reject,timer});this.port.postMessage(value);}catch(error){const p=this.pending.get(value.id);if(p)clearTimeout(p.timer);this.pending.delete(value.id);reject(error);}});}
  close(){this.port?.disconnect();}
 }
 globalThis.GDCompanion=new Client();
 addEventListener('unload',()=>globalThis.GDCompanion.close());
})();
