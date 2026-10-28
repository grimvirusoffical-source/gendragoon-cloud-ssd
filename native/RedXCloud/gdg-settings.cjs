'use strict';
// Client-encrypted device receipts. The server never receives the account vault
// secret or a raw hardware ID. Existing account authentication remains required.
const {CloudError}=require('./redx-state.cjs');
const {actor}=require('./gdg-account-state.cjs');
const policy=require('./gdg-signed-policy.cjs');
function createGDGSettings({accounts,validateCarrier}){
 if(!accounts||typeof validateCarrier!=='function')throw new Error('GDG account store and original carrier validator required');
 async function sync(identity,state){return accounts.syncWorkspaces(identity,state);}
 async function listing(identity,workspace){return policy.list(identity,workspace,await accounts.get(identity));}
 async function save(identity,workspace,registration,input){
  actor(identity);
  const request=policy.validateRequest({id:registration.id,name:registration.name,platform:registration.platform,deviceFingerprint:input?.deviceFingerprint});
  const qr=policy.validateImage(input?.qr);
  // The original library validates the carrier. Decryption is deliberately
  // client-side; this receipt is display data, not a bearer credential.
  await validateCarrier(Buffer.from(qr.png,'base64'));
  await accounts.writeReceipt(identity,workspace,registration.id,qr);
  let result;
  try{await accounts.change(identity,state=>{result=policy.add(identity,workspace,state,request,qr,registration.createdMs);});}
  catch(error){await accounts.removeReceipt(identity,registration.id).catch(()=>{});throw error;}
  return result;
 }
 async function remove(identity,workspace,id){const state=await accounts.get(identity);policy.check(identity,workspace,state);if(state.GDGSigned[id]&&state.GDGSigned[id].workspaceId!==workspace)throw new CloudError('not_found',404);await accounts.removeReceipt(identity,id);let result;await accounts.change(identity,state=>{result=policy.remove(identity,workspace,state,id);});return result;}
 async function image(identity,workspace,id){const expected=policy.image(identity,workspace,await accounts.get(identity),id);const stored=await accounts.readReceipt(identity,id);if(!stored||stored.workspaceId!==workspace||stored.qr.sha256!==expected.sha256||stored.qr.objectId!==expected.objectId)throw new CloudError('not_found',404);return {workspace,id,...stored.qr};}
 async function owned(identity,workspace){const s=await accounts.get(identity);actor(identity);if(!s?.GDGWS?.[workspace])throw new CloudError('not_found',404);return s.GDGWS[workspace];}
 return {sync,listing,save,remove,image,owned};
}
module.exports={createGDGSettings};
