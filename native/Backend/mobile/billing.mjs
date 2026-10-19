// Server error codes the billing card can hit, as plain-language messages. Nothing is
// charged in any of these cases, so the copy says so where a user might wonder.
const FRIENDLY={
 CLIENT_UPDATE_REQUIRED:'This page is out of date. Reload it and try again.',
 PLANS_REQUIRED:'Choose a storage plan and a performance plan for the new workspace.',
 PERFORMANCE_PLAN_REQUIRED:'Choose a performance plan to continue.',
 INVALID_SELECTION:'That plan combination is not available. Choose a storage plan, a performance plan and one billing period.',
 INVALID_PROJECT_NAME:'Enter a workspace name between 3 and 64 characters.',
 INVALID_INTENT:'Something went wrong preparing checkout. Reload the page and try again. Nothing was charged.',
 INTENT_CONFLICT:'A checkout for a different workspace is already in progress. Reload the page and try again.',
 PROJECT_LIMIT_REACHED:'You have reached your workspace limit. Archive a workspace or upgrade to 2 TB storage with Turbo performance to raise it.',
 FREE_PROJECT_ALREADY_CLAIMED:'Your free workspace is already in use. A new workspace needs a storage plan and a performance plan.',
 PLANS_CHECKOUT_UNAVAILABLE:'Plan checkout is not available right now. Your existing workspaces are not affected. Please try again later.',
 PLANS_PRICE_UNCONFIGURED:'This plan is not available to buy right now. Please choose another plan or try again later. Nothing was charged.',
 PLANS_MANAGED_TOGETHER:'This workspace bills storage and performance together. Use Manage billing to change its plans.',
 PAYMENT_PENDING:'Your payment is still being verified. Refresh in a moment before trying again.',
 CHECKOUT_BUSY:'Another checkout for this workspace is being prepared. Please wait a moment and try again.',
 PROJECT_ARCHIVED:'Restore this workspace before opening checkout.',
 PROJECT_NOT_FOUND:'That workspace could not be found. Refresh and try again.',
 PROJECT_UNAVAILABLE:'Checkout is temporarily unavailable. Please try again in a few minutes. Nothing was charged.'
};
export function friendlyBillingError(error){
 const code=error?.code||error?.message;
 if(error?.status===401)return 'Your session expired. Sign in again to continue.';
 if(typeof code==='string'&&Object.hasOwn(FRIENDLY,code))return FRIENDLY[code];
 if(typeof error?.detail==='string'&&error.detail)return error.detail;
 const message=typeof error?.message==='string'?error.message:'';
 // Never show a bare SERVER_CODE to a person.
 if(!message||/^[A-Z][A-Z0-9_]+$/.test(message))return 'Something went wrong preparing checkout. Please try again. Nothing was charged.';
 return message;
}
const INTENTS='gd-billing-plan-intents';
export function attachBilling({getAPI,say,storage=globalThis.sessionStorage,uuid=()=>crypto.randomUUID()}){
 const $=id=>document.getElementById(id),money=c=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(c/100);
 let pricing=null,state=null,spaces=[],policy=null,signedIn=false,busy=false,timer=null,adFree=false,ownerBenefits=false;
 // One creation intent per name + plan choice, so a retry or a return from a cancelled
 // Stripe page resumes the same pending workspace instead of creating another one.
 const readIntents=()=>{try{const v=JSON.parse(storage?.getItem(INTENTS)||'{}');return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch{return {};}};
 const writeIntents=v=>{try{storage?.setItem(INTENTS,JSON.stringify(v));}catch{}};
 function intentFor(key){const all=readIntents();if(typeof all[key]!=='string'){all[key]=uuid();writeIntents(all);}return all[key];}
 function forgetIntent(key){const all=readIntents();delete all[key];writeIntents(all);}
 const freeAvailable=()=>policy?.freeProjectAvailable===true;
 const card=$('billing-card');
 function lock(){
  const allowed=signedIn&&(ownerBenefits||state?.checkoutEnabled)&&!busy;
  for(const id of ['buy-storage','buy-ads','manage-billing'])$(id).disabled=!allowed||(id==='buy-ads'&&adFree);
  $('buy-performance').disabled=!allowed||!$('performance-workspace').value;
  $('buy-ads').textContent=adFree?'Ad-free is already active':pricing?'Remove ads · '+money(pricing.removeAds.oneTimeCents)+' once':'Remove ads';
 }
 function quote(){
  if(!pricing)return;
  const tier=pricing.storage[$('buy-tier').value],plan=pricing.performance[$('buy-plan-performance').value],year=$('buy-period').value==='year',term=year?'year':'month';
  if(tier&&plan){
   const storageCents=year?tier.yearlyCents:tier.monthlyCents,performanceCents=year?plan.yearlyCents:plan.monthlyCents,total=storageCents+performanceCents;
   $('storage-total').textContent=money(total)+' / '+term;
   $('storage-breakdown').textContent=money(storageCents)+' storage + '+money(performanceCents)+' performance ('+plan.workers+' parallel workers). '+(year?'Billed yearly, upfront.':'Renews monthly.');
   $('buy-storage').textContent='Continue to Stripe · '+money(total)+' / '+term;
  }
  if(freeAvailable()&&!ownerBenefits){
   $('storage-total').textContent='Free · '+(pricing.free?.storageGB||2)+' GB';
   $('storage-breakdown').textContent='Your first workspace is free: '+(pricing.free?.storageGB||2)+' GB with 1 transfer worker. Storage and performance plans apply from your second workspace.';
   $('buy-storage').textContent='Create free workspace';
  }
  const perf=pricing.performance[$('buy-performance-tier').value],py=$('performance-period').value==='year';
  $('performance-total').textContent=money(py?perf.yearlyCents:perf.monthlyCents)+' / '+(py?'year':'month')+' · '+perf.workers+' parallel workers';
  if(ownerBenefits){$('storage-total').textContent='Included · No charge';$('storage-breakdown').textContent='Owner access includes every available storage and performance plan.';$('buy-storage').textContent='Create included workspace';$('performance-total').textContent='Included · '+perf.workers+' parallel workers';}
  $('buy-performance').textContent=ownerBenefits?'Activate included performance':'Continue to Stripe';lock();
 }
 async function refresh(){
  if(!signedIn||busy||!getAPI())return;
  try{
   const api=getAPI();
   const [s,p,w,e]=await Promise.all([api.request('/v2/billing/status').then(r=>r.json()),api.request('/v2/pricing').then(r=>r.json()),api.request('/v2/workspaces').then(r=>r.json()),api.request('/v2/account/entitlements').then(r=>r.json())]);
   if(!signedIn)return;state=s;pricing=p;spaces=w.workspaces||[];policy=w.policy||null;
   const intents=readIntents();for(const [key,id] of Object.entries(intents))if(spaces.some(x=>x.id===id&&x.projectStatus==='active'))delete intents[key];writeIntents(intents);adFree=e.adFree===true;ownerBenefits=e.ownerBenefits===true;
   $('billing-mode').textContent=ownerBenefits?'OWNER · NO CHARGE':s.checkoutEnabled?(s.stripeMode==='live'?'LIVE · REAL PAYMENTS':'TEST CHECKOUT'):'PAYMENT SETUP PENDING';
   $('billing-state').textContent=ownerBenefits?'All available plans and ad-free access are included for your verified owner account. Cloud provider usage charges still apply.':s.checkoutEnabled?'Stripe handles your payment details. Your workspace activates only after the payment is verified.':(s.message||'Payment setup is not complete. No charge can be made.');
   const chosen=$('buy-tier').value;$('buy-tier').replaceChildren(...Object.keys(p.storage).map(t=>new Option(t,t)));if(p.storage[chosen])$('buy-tier').value=chosen;
   for(const id of ['buy-performance-tier','buy-plan-performance']){const perf=$(id).value;$(id).replaceChildren(...Object.keys(p.performance).map(t=>new Option(t[0].toUpperCase()+t.slice(1),t)));if(p.performance[perf])$(id).value=perf;}
   const old=$('performance-workspace').value;$('performance-workspace').replaceChildren(new Option('Choose an active workspace',''));
   for(const item of spaces)if(item.billingModel!=='plans'&&(item.storageActive&&item.provisioned)||(item.byoActive&&item.manualProviderConfigured))$('performance-workspace').add(new Option(item.name,item.id));
   if([...$('performance-workspace').options].some(o=>o.value===old))$('performance-workspace').value=old;
   quote();lock();
  }catch(error){state=null;$('billing-state').textContent=friendlyBillingError(error);lock();}
 }
 async function checkout(action){
  if(busy||(!ownerBenefits&&!state?.checkoutEnabled))return;busy=true;lock();say(ownerBenefits?'Activating included access…':'Preparing secure Stripe checkout…');
  try{
   const result=await action();
   if(result.complimentary===true){say(result.message||'Owner access activated at no charge.');return;}
   if(typeof result.url!=='string'){say(result.message||'Done.');return;}
   const url=new URL(result.url);
   if(url.protocol!=='https:'||!['checkout.stripe.com','billing.stripe.com'].includes(url.hostname))throw Error('Stripe returned an untrusted checkout URL.');
   location.assign(url.href);
  }catch(error){say(friendlyBillingError(error));}finally{busy=false;lock();await refresh();}
 }
 $('buy-storage').addEventListener('click',()=>checkout(async()=>{
  const api=getAPI(),name=$('buy-workspace-name').value.trim();if(name.length<3||name.length>64)throw Error('Enter a workspace name between 3 and 64 characters.');
  // Same flow as the desktop and mobile apps: one POST creates the workspace and, for a
  // paid workspace, opens one Stripe Checkout with the storage + performance plans.
  const plans={storageTier:$('buy-tier').value,performanceTier:$('buy-plan-performance').value,interval:$('buy-period').value};
  const key=JSON.stringify([name,plans.storageTier,plans.performanceTier,plans.interval]);
  const result=await(await api.request('/v2/projects',{method:'POST',json:{name,intentId:intentFor(key),storage:'managed',plans}})).json();
  if(typeof result.url==='string')return result;
  forgetIntent(key);
  if(result.alreadyActivated&&result.message)return {message:result.message};
  if(result.isFree===true||result.project?.isFree===true)return {message:'Your free workspace "'+name+'" is ready.'};
  if(ownerBenefits)return {complimentary:true,message:'Workspace "'+name+'" created with owner access at no charge.'};
  return {message:'Workspace "'+name+'" is ready.'};
 }));
 $('buy-performance').addEventListener('click',()=>checkout(async()=>{
  const id=$('performance-workspace').value;if(!spaces.some(w=>w.id===id))throw Error('Choose an active workspace.');
  return(await getAPI().request('/v2/workspaces/'+id+'/checkout/performance',{method:'POST',json:{tier:$('buy-performance-tier').value,interval:$('performance-period').value}})).json();
 }));
 $('buy-ads').addEventListener('click',()=>checkout(async()=>(await getAPI().request('/v2/remove-ads/checkout',{method:'POST'})).json()));
 $('manage-billing').addEventListener('click',()=>checkout(async()=>(await getAPI().request('/billing/customer-portal',{method:'POST'})).json()));
 for(const id of ['buy-plan-performance','buy-tier','buy-period','buy-performance-tier','performance-period','performance-workspace'])$(id).addEventListener('change',quote);
 $('billing-refresh').addEventListener('click',refresh);
 return {refresh,setSignedIn(value){signedIn=value;card.hidden=!value;clearInterval(timer);if(value){refresh();timer=setInterval(refresh,15000);if(location.hash==='#billing')card.scrollIntoView({behavior:'smooth'});}else{state=null;spaces=[];policy=null;pricing=null;adFree=false;ownerBenefits=false;$('buy-workspace-name').value='My Cloud Project';}lock();}};
}
