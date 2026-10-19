export function attachBilling({getAPI,say}){
 const $=id=>document.getElementById(id),money=c=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(c/100);
 let pricing=null,state=null,spaces=[],signedIn=false,busy=false,timer=null,adFree=false,ownerBenefits=false;
 const card=$('billing-card');
 function lock(){
  const allowed=signedIn&&(ownerBenefits||state?.checkoutEnabled)&&!busy;
  for(const id of ['buy-storage','buy-ads','manage-billing'])$(id).disabled=!allowed||(id==='buy-ads'&&adFree);
  $('buy-performance').disabled=!allowed||!$('performance-workspace').value;
  $('buy-ads').textContent=adFree?'Ad-free is already active':pricing?'Remove ads · '+money(pricing.removeAds.oneTimeCents)+' once':'Remove ads';
 }
 function quote(){
  if(!pricing)return;
  const tier=pricing.storage[$('buy-tier').value],year=$('buy-period').value==='year',bundle=$('buy-kind').value==='bundle';
  const cents=bundle?(year?tier.bundleYearlyCents:tier.bundleMonthlyCents):(year?tier.yearlyCents:tier.monthlyCents);
  const fee=pricing.workspaceFeeMonthlyCents*(year?10:1),term=year?'year':'month';
  $('storage-total').textContent=money(cents+fee)+' / '+term;
  $('storage-breakdown').textContent=money(cents)+' storage + '+money(fee)+' workspace management. '+(year?'Billed yearly, upfront.':'Renews monthly.');
  $('buy-storage').textContent='Continue to Stripe · '+money(cents+fee)+' / '+term;
  const perf=pricing.performance[$('buy-performance-tier').value],py=$('performance-period').value==='year';
  $('performance-total').textContent=money(py?perf.yearlyCents:perf.monthlyCents)+' / '+(py?'year':'month')+' · '+perf.workers+' parallel workers';
  if(ownerBenefits){$('storage-total').textContent='Included · No charge';$('storage-breakdown').textContent='Owner access includes every available storage tier and workspace management.';$('buy-storage').textContent='Activate included storage';$('performance-total').textContent='Included · '+perf.workers+' parallel workers';}
  $('buy-performance').textContent=ownerBenefits?'Activate included performance':'Continue to Stripe';lock();
 }
 async function refresh(){
  if(!signedIn||busy||!getAPI())return;
  try{
   const api=getAPI();
   const [s,p,w,e]=await Promise.all([api.request('/v2/billing/status').then(r=>r.json()),api.request('/v2/pricing').then(r=>r.json()),api.request('/v2/workspaces').then(r=>r.json()),api.request('/v2/account/entitlements').then(r=>r.json())]);
   if(!signedIn)return;state=s;pricing=p;spaces=w.workspaces||[];adFree=e.adFree===true;ownerBenefits=e.ownerBenefits===true;
   $('billing-mode').textContent=ownerBenefits?'OWNER · NO CHARGE':s.checkoutEnabled?(s.stripeMode==='live'?'LIVE · REAL PAYMENTS':'TEST CHECKOUT'):'PAYMENT SETUP PENDING';
   $('billing-state').textContent=ownerBenefits?'All available plans and ad-free access are included for your verified owner account. Cloud provider usage charges still apply.':s.checkoutEnabled?'Stripe handles your payment details. Your workspace activates only after the payment is verified.':(s.message||'Payment setup is not complete. No charge can be made.');
   const chosen=$('buy-tier').value;$('buy-tier').replaceChildren(...Object.keys(p.storage).map(t=>new Option(t,t)));if(p.storage[chosen])$('buy-tier').value=chosen;
   const perf=$('buy-performance-tier').value;$('buy-performance-tier').replaceChildren(...Object.keys(p.performance).map(t=>new Option(t[0].toUpperCase()+t.slice(1),t)));if(p.performance[perf])$('buy-performance-tier').value=perf;
   const old=$('performance-workspace').value;$('performance-workspace').replaceChildren(new Option('Choose an active workspace',''));
   for(const item of spaces)if((item.storageActive&&item.provisioned)||(item.byoActive&&item.manualProviderConfigured))$('performance-workspace').add(new Option(item.name,item.id));
   if([...$('performance-workspace').options].some(o=>o.value===old))$('performance-workspace').value=old;
   quote();lock();
  }catch(error){state=null;$('billing-state').textContent=error.message;lock();}
 }
 async function checkout(action){
  if(busy||(!ownerBenefits&&!state?.checkoutEnabled))return;busy=true;lock();say(ownerBenefits?'Activating included access…':'Preparing secure Stripe checkout…');
  try{
   const result=await action();
   if(result.complimentary===true){say(result.message||'Owner access activated at no charge.');return;}
   const url=new URL(result.url);
   if(url.protocol!=='https:'||!['checkout.stripe.com','billing.stripe.com'].includes(url.hostname))throw Error('Stripe returned an untrusted checkout URL.');
   location.assign(url.href);
  }catch(error){say(error.message);}finally{busy=false;lock();await refresh();}
 }
 $('buy-storage').addEventListener('click',()=>checkout(async()=>{
  const api=getAPI(),name=$('buy-workspace-name').value.trim();if(name.length<3||name.length>64)throw Error('Enter a workspace name between 3 and 64 characters.');
  const draft=await(await api.request('/v2/workspaces/draft',{method:'POST',json:{name,tier:$('buy-tier').value,mode:$('buy-kind').value,interval:$('buy-period').value}})).json();
  return (await api.request('/v2/workspaces/'+draft.workspaceId+'/checkout/storage',{method:'POST'})).json();
 }));
 $('buy-performance').addEventListener('click',()=>checkout(async()=>{
  const id=$('performance-workspace').value;if(!spaces.some(w=>w.id===id))throw Error('Choose an active workspace.');
  return(await getAPI().request('/v2/workspaces/'+id+'/checkout/performance',{method:'POST',json:{tier:$('buy-performance-tier').value,interval:$('performance-period').value}})).json();
 }));
 $('buy-ads').addEventListener('click',()=>checkout(async()=>(await getAPI().request('/v2/remove-ads/checkout',{method:'POST'})).json()));
 $('manage-billing').addEventListener('click',()=>checkout(async()=>(await getAPI().request('/billing/customer-portal',{method:'POST'})).json()));
 for(const id of ['buy-kind','buy-tier','buy-period','buy-performance-tier','performance-period','performance-workspace'])$(id).addEventListener('change',quote);
 $('billing-refresh').addEventListener('click',refresh);
 return {refresh,setSignedIn(value){signedIn=value;card.hidden=!value;clearInterval(timer);if(value){refresh();timer=setInterval(refresh,15000);if(location.hash==='#billing')card.scrollIntoView({behavior:'smooth'});}else{state=null;spaces=[];pricing=null;adFree=false;ownerBenefits=false;$('buy-workspace-name').value='My Cloud Project';}lock();}};
}
