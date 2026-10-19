'use strict';
const OWNER_EMAIL='grimvirusoffical@gmail.com';
function eligible(user){return !!user?.uid && user.email_verified===true && user.email?.toLowerCase()===OWNER_EMAIL && user.firebase?.sign_in_provider==='google.com';}
async function grantOwnerBenefits({user,db,hash,stamp}){
 if(!eligible(user))return false;
 const owner=hash(user.uid),policy=db.collection('system').doc('owner-benefits-v1');
 const wid='00000000-0000-4000-9000-'+owner.slice(0,12);
 const workspace=db.collection('gd_accounts').doc(owner).collection('workspaces').doc(wid);
 return db.runTransaction(async tx=>{
  const [p,w]=await Promise.all([tx.get(policy),tx.get(workspace)]);
  const settings=p.exists?p.data():null;
  if(settings?.disabled===true || (settings?.uid && settings.uid!==user.uid))return false;
  if(!p.exists)tx.create(policy,{uid:user.uid,email:OWNER_EMAIL,grantVersion:1,createdAt:stamp()});
  if(!w.exists)tx.create(workspace,{name:'Owner • All features',kind:'paid',accountHash:owner,
   storageTier:'6TB',storageMode:'bundle',storageInterval:'year',storageActive:true,
   performanceTier:'max',performanceActive:true,provisioned:true,usedBytes:0,reservedBytes:0,
   entitlementSource:'owner',createdAt:stamp()});
  return true;
 });
}
module.exports={eligible,grantOwnerBenefits};
