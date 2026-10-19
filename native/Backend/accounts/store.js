"use strict";
// Gendragoon's account profiles in Firestore. Field names follow the Red-XAI Accounts v1 schema where the
// meaning is the same, so moving a profile to the central service is a copy, not a translation.
//   gd_profiles/{accountKey}        the profile (no age is ever stored, only dob)
//   gd_usernames/{usernameFolded}   uniqueness index -> {accountKey}
//   gd_emails/{sha256(emailKey)}    uniqueness index -> {accountKey}
//   gd_tos_grants/{sha256(grantId)} spent ToS grants (single use)
//   gd_identity_links/{sha256(iss|sub)} Red-XAI subject -> Gendragoon uid (the migration link)
const crypto=require("node:crypto");
const sha=v=>crypto.createHash("sha256").update(String(v)).digest("hex");

class StoreConflict extends Error{constructor(code){super(code);this.code=code;}}

function createAccountStore({db,accountKey}){
 // Collections are looked up per call: creating the store must not open a database connection.
 const col=name=>db.collection(name);
 const profiles={doc:id=>col("gd_profiles").doc(id)},usernames={doc:id=>col("gd_usernames").doc(id)},emails={doc:id=>col("gd_emails").doc(id)};
 const grants={doc:id=>col("gd_tos_grants").doc(id)},links={doc:id=>col("gd_identity_links").doc(id)};
 const profileRef=uid=>profiles.doc(accountKey(uid));
 async function get(uid){const s=await profileRef(uid).get();return s.exists?s.data():null;}
 async function usernameTaken(folded){return (await usernames.doc(folded).get()).exists;}
 async function emailTaken(key){return (await emails.doc(sha(key)).get()).exists;}
 // Creates the profile and both indexes and spends the ToS grant in one transaction.
 async function create(uid,profile,{usernameFolded,emailKey,grantId,grantExpiresMs}){
  const key=accountKey(uid);
  const refs={p:profileRef(uid),u:usernames.doc(usernameFolded),e:emails.doc(sha(emailKey)),g:grants.doc(sha(grantId))};
  await db.runTransaction(async tx=>{
   const [p,u,e,g]=await Promise.all([tx.get(refs.p),tx.get(refs.u),tx.get(refs.e),tx.get(refs.g)]);
   if(p.exists)throw new StoreConflict("account_exists");
   if(u.exists)throw new StoreConflict("username_taken");
   if(e.exists)throw new StoreConflict("email_taken");
   if(g.exists)throw new StoreConflict("tos_grant_invalid");
   tx.create(refs.p,profile);
   tx.create(refs.u,{accountKey:key});
   tx.create(refs.e,{accountKey:key});
   tx.create(refs.g,{expiresMs:grantExpiresMs});
  });
 }
 async function update(uid,patch){await profileRef(uid).set(patch,{merge:true});}
 // Re-accepting new Terms spends a grant too.
 async function acceptTerms(uid,patch,{grantId,grantExpiresMs}){
  const g=grants.doc(sha(grantId)),p=profileRef(uid);
  await db.runTransaction(async tx=>{
   const [gs,ps]=await Promise.all([tx.get(g),tx.get(p)]);
   if(gs.exists)throw new StoreConflict("tos_grant_invalid");
   if(!ps.exists)throw new StoreConflict("account_setup_required");
   tx.create(g,{expiresMs:grantExpiresMs});
   tx.set(p,patch,{merge:true});
  });
 }
 async function resolveLink(issuer,sub){const s=await links.doc(sha(issuer+"|"+sub)).get();return s.exists?s.data().uid:null;}
 async function link(issuer,sub,uid,now){
  const ref=links.doc(sha(issuer+"|"+sub));
  await db.runTransaction(async tx=>{
   const s=await tx.get(ref);
   if(s.exists&&s.data().uid!==uid)throw new StoreConflict("identity_linked_elsewhere");
   if(!s.exists)tx.create(ref,{uid,linkedMs:now});
  });
 }
 // Account deletion: the profile, its indexes and its identity link go; spent grants are anonymous and expire.
 async function remove(uid){
  const p=await get(uid);
  if(!p)return false;
  await usernames.doc(p.usernameFolded).delete().catch(()=>{});
  await emails.doc(sha(p.emailKey)).delete().catch(()=>{});
  if(p.identity?.issuer&&p.identity?.sub)await links.doc(sha(p.identity.issuer+"|"+p.identity.sub)).delete().catch(()=>{});
  await profileRef(uid).delete();
  return true;
 }
 return {get,usernameTaken,emailTaken,create,update,acceptTerms,resolveLink,link,remove};
}
// Used by account deletion, which knows only the account hash.
async function deleteProfileByHash(db,owner){
 const ref=db.collection("gd_profiles").doc(owner);
 const snap=await ref.get();
 if(!snap.exists)return false;
 const p=snap.data()||{};
 if(p.usernameFolded)await db.collection("gd_usernames").doc(p.usernameFolded).delete().catch(()=>{});
 if(p.emailKey)await db.collection("gd_emails").doc(sha(p.emailKey)).delete().catch(()=>{});
 if(p.identity?.issuer&&p.identity?.sub)await db.collection("gd_identity_links").doc(sha(p.identity.issuer+"|"+p.identity.sub)).delete().catch(()=>{});
 await ref.delete();
 return true;
}
module.exports={createAccountStore,deleteProfileByHash,StoreConflict};
