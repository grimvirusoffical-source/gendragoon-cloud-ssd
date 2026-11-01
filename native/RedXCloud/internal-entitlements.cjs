'use strict';
const crypto = require('node:crypto');
const {CloudError,digest} = require('./redx-state.cjs');
const ID=/^[a-f0-9]{32}$/, OWNER=/^[a-f0-9]{64}$/;

// A separate service credential is never accepted as a customer/API-key login.
// The route is limited to fresh entitlement reads for an already existing note.
function createInternalEntitlements({token,issuer,resolve,now=Date.now}) {
  if(token && (typeof token!=='string'||!/^[A-Za-z0-9_-]{43,128}$/.test(token)))throw new Error('Invalid internal entitlement credential');
  const expected=token?crypto.createHash('sha256').update(token).digest():null;
  return async function handle(req,res,pathname) {
    if(pathname!=='/internal/receiver-entitlements')return false;
    if(!expected)throw new CloudError('not_found',404);
    if(req.method!=='POST')throw new CloudError('method_not_allowed',405);
    if(!['127.0.0.1','::ffff:127.0.0.1','::1'].includes(req.socket.remoteAddress))throw new CloudError('forbidden',403);
    const supplied=req.headers.authorization;
    if(typeof supplied!=='string'||supplied.length>160||!supplied.startsWith('Bearer '))throw new CloudError('service_login_required',401);
    const actual=crypto.createHash('sha256').update(supplied.slice(7)).digest();
    if(!crypto.timingSafeEqual(actual,expected))throw new CloudError('service_login_required',401);
    let bytes=0,chunks=[];
    for await(const c of req){bytes+=c.length;if(bytes>4096)throw new CloudError('body_too_large',413);chunks.push(c);}
    let b;try{b=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new CloudError('bad_json',400);}
    if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['owner','issuer','subject','workspaceId'].includes(k))||
       !OWNER.test(b.owner||'')||b.issuer!==issuer||typeof b.subject!=='string'||!b.subject||b.subject.length>512||/[\x00-\x1f]/.test(b.subject)||
       !ID.test(b.workspaceId||'')||digest(JSON.stringify(['red-xai-receiver/v1',issuer,b.subject]))!==b.owner)
      throw new CloudError('identity_binding_invalid',403);
    const proof=await resolve({owner:b.owner,issuer:b.issuer,subject:b.subject},b.workspaceId);
    if(!proof)throw new CloudError('workspace_not_found',404);
    const age=now()-proof.checkedAtMs;
    if(proof.id!==b.workspaceId||typeof proof.active!=='boolean'||typeof proof.readOnly!=='boolean'||
       !Number.isSafeInteger(proof.quotaBytes)||proof.quotaBytes<0||proof.quotaBytes>1e15||
       !Number.isInteger(proof.workers)||proof.workers<0||proof.workers>24||!Number.isSafeInteger(proof.checkedAtMs)||age< -5000||age>60000)
      throw new CloudError('entitlement_response_invalid',503);
    const result={schema:1,owner:b.owner,issuer:b.issuer,subject:b.subject,workspace:proof};
    const data=Buffer.from(JSON.stringify(result));
    res.writeHead(200,{'content-type':'application/json','content-length':data.length,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(data);return true;
  };
}
function createInternalEntitlementClient({url,token,issuer,fetchImpl=fetch}) {
  if(!url||!token)return async()=>{throw new CloudError('integration_entitlements_unavailable',503);};
  const u=new URL(url);
  if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.search||u.hash||u.pathname!=='/internal/receiver-entitlements'||!/^[A-Za-z0-9_-]{43,128}$/.test(token))throw new Error('Internal entitlement service must use authenticated IPv4 loopback');
  return async(identity,workspaceId)=>{
    if(identity.issuer!==issuer||!ID.test(workspaceId||'')||!OWNER.test(identity.owner||'')||typeof identity.subject!=='string'||
       digest(JSON.stringify(['red-xai-receiver/v1',issuer,identity.subject]))!==identity.owner)throw new CloudError('identity_binding_invalid',403);
    let response;try{response=await fetchImpl(u.href,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({owner:identity.owner,issuer,subject:identity.subject,workspaceId})});}catch{throw new CloudError('integration_entitlements_unavailable',503);}
    if(response.status===404)return null;
    if(!response.ok)throw new CloudError('integration_entitlements_unavailable',503);
    const text=await response.text();if(text.length>16384)throw new CloudError('entitlement_response_invalid',503);
    let value;try{value=JSON.parse(text);}catch{throw new CloudError('entitlement_response_invalid',503);}
    if(value.schema!==1||value.owner!==identity.owner||value.issuer!==issuer||value.subject!==identity.subject||value.workspace?.id!==workspaceId)throw new CloudError('entitlement_response_invalid',503);
    return value.workspace;
  };
}
module.exports={createInternalEntitlements,createInternalEntitlementClient};
