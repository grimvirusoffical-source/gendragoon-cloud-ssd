'use strict';
// GenDragoon-only SDK. Callers keep keys in their own native credential store.
const crypto=require('node:crypto');
const {origin}=require('./redx-state.cjs');
const id32=value=>{if(typeof value!=='string'||!/^[a-f0-9]{32}$/.test(value))throw Error('invalid_identifier');return value;};
async function boundedBody(response,limit){
 const declared=response.headers.get('content-length');if(declared&&(!/^[0-9]+$/.test(declared)||Number(declared)>limit)){await response.body?.cancel();throw Error('response_too_large');}
 if(!response.body)return Buffer.alloc(0);
 const chunks=[];let total=0;const reader=response.body.getReader();
 try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>limit){await reader.cancel();throw Error('response_too_large');}chunks.push(Buffer.from(value));}return Buffer.concat(chunks,total);}finally{reader.releaseLock();}
}
class IntegrationClient {
 #token;
 constructor({baseURL,token,fetchImpl=fetch,development=false}){this.baseURL=origin(baseURL,development);if(typeof token!=='function')throw Error('credential_callback_required');this.#token=token;this.fetch=fetchImpl;}
 async _call(route,{method='GET',body,publicRequest=false,headers={},bytes=false}={}){
  const token=publicRequest?null:await this.#token();
  if(!publicRequest&&(typeof token!=='string'||!token||/[\r\n]/.test(token)))throw Error('credential_required');
  const response=await this.fetch(this.baseURL+route,{method,redirect:'error',signal:AbortSignal.timeout(90000),headers:{...(token?{authorization:'Bearer '+token}:{}),...(body!==undefined&&!Buffer.isBuffer(body)?{'content-type':'application/json'}:{}),...headers},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)});
  if(!response.ok){await response.body?.cancel();const error=Error('integration_request_failed');error.status=response.status;throw error;}
  const raw=await boundedBody(response,bytes?8*1024*1024:4*1024*1024);
  if(bytes)return {data:raw,headers:response.headers};
  let data;try{data=JSON.parse(raw.toString('utf8'));}catch{throw Error('invalid_response');}if(!data||typeof data!=='object'||Array.isArray(data))throw Error('invalid_response');return data;
 }
 services(){return this._call('/v1/integrations/services');}
 keys(){return this._call('/v1/integrations/keys');}
 createKey({name,service,workspaceId,scopes=['files:read']}){return this._call('/v1/integrations/keys',{method:'POST',body:{name,service,workspaceId:id32(workspaceId),scopes}});}
 revokeKey(id){if(!/^[a-f0-9]{16}$/.test(id))throw Error('invalid_identifier');return this._call('/v1/integrations/keys/'+id,{method:'DELETE'});}
 byo(){return this._call('/v1/integrations/byo');}
 registerBYO({name,origin,database,pack='gendragoon'}){return this._call('/v1/integrations/byo',{method:'POST',body:{name,origin,database,pack}});}
 disconnectBYO(id){if(!/^byo_[a-f0-9]{32}$/.test(id))throw Error('invalid_identifier');return this._call('/v1/integrations/byo/'+id,{method:'DELETE'});}
 createGrant({name,service,workspaceId,scopes=['files:read']}){return this._call('/provider/v1/connect/grants',{method:'POST',body:{name,service,workspaceId:id32(workspaceId),scopes}});}
 authorize({name,service,workspaceId,scopes=['files:read'],codeChallenge}){return this._call('/provider/v1/connect/authorize',{method:'POST',body:{name,service,workspaceId:id32(workspaceId),scopes,codeChallenge,codeChallengeMethod:'S256'}});}
 async redeem(grant,client_instance={}){if(!/^gdpg_[A-Za-z0-9_-]{43}$/.test(grant))throw Error('invalid_grant');return this._binding(await this._call('/provider/v1/connect/redeem',{method:'POST',body:{grant,client_instance},publicRequest:true}));}
 async exchange(code,codeVerifier){return this._binding(await this._call('/provider/v1/connect/token',{method:'POST',body:{code,codeVerifier},publicRequest:true}));}
 _binding(data){if(!/^gdpk_[a-f0-9]{16}_[A-Za-z0-9_-]{43}$/.test(data.key||'')||data.key!==data.apiKey||typeof data.binding?.id!=='string'||!data.binding?.workspaceId)throw Error('invalid_binding');return data;}
 health(){return this._call('/provider/v1/health');}
 library(workspaceId){return this._call('/v1/receivers/me/workspaces/'+id32(workspaceId)+'/library');}
 async putPNG(workspaceId,objectId,png){if(!Buffer.isBuffer(png)||png.length>8*1024*1024||png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('invalid_png');const sha=crypto.createHash('sha256').update(png).digest('hex');return this._call('/v1/receivers/me/workspaces/'+id32(workspaceId)+'/blobs/'+id32(objectId),{method:'PUT',body:png,headers:{'content-type':'image/png','x-content-sha256':sha,'content-length':String(png.length)}});}
 async getPNG(workspaceId,objectId){const {data,headers}=await this._call('/v1/receivers/me/workspaces/'+id32(workspaceId)+'/blobs/'+id32(objectId),{bytes:true});if(data.length>8*1024*1024||data.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||crypto.createHash('sha256').update(data).digest('hex')!==headers.get('x-content-sha256'))throw Error('carrier_integrity_failed');return data;}
}
function pkce(){const verifier=crypto.randomBytes(48).toString('base64url');return {verifier,challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),method:'S256'};}
module.exports={IntegrationClient,pkce};
