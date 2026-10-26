'use strict';
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GDCompanionRPC=api;})(typeof globalThis==='object'?globalThis:this,()=>{
 const HOST='com.redxai.gendragoon',MAX_FRAME=256*1024;
 function id(){if(globalThis.crypto?.randomUUID)return globalThis.crypto.randomUUID().replaceAll('-','');if(typeof require==='function')return require('node:crypto').randomBytes(16).toString('hex');throw new Error('Secure request IDs are unavailable.');}
 function request(method,params={}){if(!['status','request','selectUpload','uploadSelection'].includes(method)||!params||typeof params!=='object'||Array.isArray(params))throw new Error('Unsupported companion request.');return {id:id(),method,params};}
 function result(response,requestID){if(!response||response.id!==requestID||typeof response.ok!=='boolean')throw new Error('The native companion returned an invalid response.');if(!response.ok){const error=new Error(typeof response.error?.message==='string'?response.error.message:'The native companion could not complete this request.');error.code=response.error?.code||'companion_error';throw error;}if(!Object.hasOwn(response,'result'))throw new Error('The native companion response is incomplete.');return response.result;}
 return {HOST,MAX_FRAME,id,request,result};
});
