'use strict';
const OWNER_EMAIL='support@infected-nation.com';
const LEGACY_OWNER_EMAIL='grimvirusoffical@gmail.com';
const OWNER_STORAGE_TIER='6TB';
const OWNER_PERFORMANCE_TIER='max';

function provider(user){
 return user?.__identity?.provider==='redxai'?'redxai':user?.firebase?.sign_in_provider||null;
}
function eligible(user){
 const email=String(user?.email||'').trim().toLowerCase();
 return !!user?.uid && user.email_verified===true && email===OWNER_EMAIL && ['redxai','google.com'].includes(provider(user));
}
async function grantOwnerBenefits({user,db,hash,stamp}){
 if(!eligible(user))return false;
 const owner=hash(user.uid),policy=db.collection('system').doc('owner-benefits-v1');
 const wid='00000000-0000-4000-9000-'+owner.slice(0,12);
 const workspace=db.collection('gd_accounts').doc(owner).collection('workspaces').doc(wid);
 return db.runTransaction(async tx=>{
  const [p,w]=await Promise.all([tx.get(policy),tx.get(workspace)]);
  const settings=p.exists?p.data():null;
  if(settings?.disabled===true)return false;
  // One controlled migration from the historical Gmail binding to the user's
  // Red-XAI support account. Once rebound, a different UID cannot claim it.
  if(settings?.uid&&settings.uid!==user.uid){
   if(String(settings.email||'').toLowerCase()!==LEGACY_OWNER_EMAIL)return false;
   tx.set(policy,{uid:user.uid,email:OWNER_EMAIL,previousUid:settings.uid,grantVersion:2,migratedAt:stamp()},{merge:true});
  }else if(!p.exists){
   tx.create(policy,{uid:user.uid,email:OWNER_EMAIL,grantVersion:2,createdAt:stamp()});
  }else if(settings.email!==OWNER_EMAIL||settings.grantVersion!==2){
   tx.set(policy,{email:OWNER_EMAIL,grantVersion:2,updatedAt:stamp()},{merge:true});
  }
  const grant={
   name:'Owner • All features',kind:'paid',accountHash:owner,
   projectBillingVersion:3,projectStatus:'active',projectFeeStatus:'owner',projectFeeCents:0,
   workspaceFeeCents:0,workspaceFeeIncluded:true,plansStatus:'owner',
   requiredPlans:{storage:'managed',storageTier:OWNER_STORAGE_TIER,performanceTier:OWNER_PERFORMANCE_TIER,interval:'year'},
   storageBillingVersion:2,storageTier:OWNER_STORAGE_TIER,storageMode:'bundle',storageInterval:'year',storageActive:true,
   performanceTier:OWNER_PERFORMANCE_TIER,performanceInterval:'year',performanceActive:true,
   provisioned:true,quotaBytes:6_000_000_000_000,
   entitlementSource:'owner',ownerLifetime:true,updatedAt:stamp()
  };
  if(!w.exists)tx.create(workspace,{...grant,usedBytes:0,reservedBytes:0,createdAt:stamp()});
  else tx.set(workspace,grant,{merge:true});
  return true;
 });
}
module.exports={eligible,grantOwnerBenefits,OWNER_EMAIL,LEGACY_OWNER_EMAIL,OWNER_STORAGE_TIER,OWNER_PERFORMANCE_TIER};
