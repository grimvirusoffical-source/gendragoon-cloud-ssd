"use strict";
// Web billing card (mobile/billing.mjs) against the real billing routes with a stubbed
// Stripe object: no network, no keys, no live Stripe calls.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto"),fs=require("node:fs"),path=require("node:path"),express=require("express"),Stripe=require("stripe");
const {memoryFirestore}=require("./test_firestore");
const {installedBilling,STRIPE_API_VERSION}=require("./billing_gateway");
const hash=uid=>crypto.createHash("sha256").update(uid).digest("hex"),owner=hash("test-a");
const CATALOG={"storage|standard|100GB|month":"price_100gb","storage|standard|2TB|month":"price_2tb","storage|standard|2TB|year":"price_2tby",
 "performance|lite|month":"price_lite","performance|turbo|month":"price_turbo","performance|turbo|year":"price_turboy"};

async function backend(t,{customer="cus_own"}={}){
 const db=memoryFirestore([["gd_accounts/"+owner,customer?{stripeCustomerId:customer}:{}]]),sessions=new Map(),calls=[],customers=[];
 const verifier=new Stripe("sk_test_dummyABC123",{apiVersion:STRIPE_API_VERSION});
 const stripe={webhooks:verifier.webhooks,
   customers:{create:async(args,options)=>{customers.push({args,options});return {id:"cus_new"+customers.length};}},
   checkout:{sessions:{
     create:async(args,options)=>{const id="cs_local"+(calls.length+1);calls.push({args,options});
       const session={...args,id,status:"open",url:"https://checkout.stripe.com/c/pay/"+id};sessions.set(id,session);return structuredClone(session);},
     retrieve:async id=>structuredClone(sessions.get(id)),expire:async id=>{sessions.get(id).status="expired";return sessions.get(id);}}}};
 const app=express();app.use("/v2",express.json());
 const firebaseAuth=(req,res,next)=>{const uid=req.headers.authorization?.replace("Bearer ","");if(uid!=="test-a")return res.status(401).json({error:"Sign in"});req.user={uid};next();};
 installedBilling({app,db,bucket:{file:()=>({save:async()=>{}})},stripeOverride:stripe,
   admin:{firestore:{FieldValue:{serverTimestamp:()=>123}}},firebaseAuth,accountKey:hash,
   env:{STRIPE_SECRET_KEY:"sk_test_dummyABC123",STRIPE_WEBHOOK_SECRET:"whsec_disposableFixtureOnly123",STRIPE_CHECKOUT_ENABLED:"true",
     STRIPE_ENVIRONMENT:"test",PUBLIC_URL:"https://billing.example",STRIPE_PRICE_CATALOG_JSON:JSON.stringify(CATALOG)}});
 const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
 t.after(()=>new Promise(r=>server.close(r)));
 const origin="http://127.0.0.1:"+server.address().port;
 async function request(p,body,method=body===undefined?"GET":"POST"){
   const r=await fetch(origin+p,{method,headers:{"Content-Type":"application/json",Authorization:"Bearer test-a"},body:body===undefined?undefined:JSON.stringify(body)});
   return {status:r.status,body:await r.json()};
 }
 return {db,origin,request,calls,customers};
}

// Minimal DOM: just what billing.mjs touches.
function fakeDom(){
 const els=new Map(),posted=[];
 class Option{constructor(text,value){this.text=text;this.value=value===undefined?text:value;}}
 function el(id){
  if(els.has(id))return els.get(id);
  const handlers={},e={id,value:"",textContent:"",disabled:false,hidden:false,options:[],
   addEventListener(type,fn){(handlers[type]||=[]).push(fn);},
   async click(){await Promise.all((handlers.click||[]).map(fn=>fn()));},
   async change(){await Promise.all((handlers.change||[]).map(fn=>fn()));},
   replaceChildren(...opts){this.options=opts;if(!opts.some(o=>o.value===this.value))this.value=opts[0]?.value??"";},
   add(o){this.options.push(o);if(this.options.length===1)this.value=o.value;},
   scrollIntoView(){}};
  els.set(id,e);return e;
 }
 return {els,posted,el,Option};
}
async function mountCard(t,api,{store=new Map()}={}){
 const dom=fakeDom(),said=[],assigned=[];
 globalThis.document={getElementById:dom.el};globalThis.Option=dom.Option;
 globalThis.location={hash:"",assign:url=>assigned.push(url)};
 for(const [id,value] of [["buy-workspace-name","My Cloud Project"],["buy-tier","100GB"],["buy-plan-performance","lite"],["buy-period","month"],
   ["buy-performance-tier","lite"],["performance-period","month"],["performance-workspace",""]])dom.el(id).value=value;
 const storage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v))};
 const {attachBilling}=await import(path.join(__dirname,"mobile","billing.mjs"));
 const card=attachBilling({getAPI:()=>api,say:m=>said.push(m),storage});
 card.setSignedIn(true);await card.refresh();
 t.after(()=>card.setSignedIn(false));
 return {dom,said,assigned,card,store,$:dom.el};
}
async function browserApi(origin){
 const {BrowserCloud}=await import(path.join(__dirname,"mobile","transfer-client.mjs"));
 return new BrowserCloud({endpoint:origin,uid:"test-a",token:async()=>"test-a",storage:{getItem:()=>null,setItem(){},removeItem(){}}});
}

test("web card: first workspace is created free without Stripe; the next opens one Checkout with storage + performance",async t=>{
 const b=await backend(t),api=await browserApi(b.origin),ui=await mountCard(t,api);
 assert.equal(ui.$("buy-storage").textContent,"Create free workspace");
 assert.equal(ui.$("buy-storage").disabled,false);
 ui.$("buy-workspace-name").value="Starter";await ui.$("buy-storage").click();
 assert.equal(b.calls.length,0);assert.equal(ui.assigned.length,0);
 assert.match(ui.said.at(-1),/free workspace "Starter" is ready/);

 // Free slot is now used: the card prices storage + performance together.
 ui.$("buy-tier").value="2TB";ui.$("buy-plan-performance").value="turbo";ui.$("buy-period").value="month";await ui.$("buy-tier").change();
 assert.equal(ui.$("storage-total").textContent,"$81.00 / month");
 assert.match(ui.$("storage-breakdown").textContent,/^\$72\.00 storage \+ \$9\.00 performance \(8 parallel workers\)\. Renews monthly\.$/);
 assert.doesNotMatch(ui.$("storage-breakdown").textContent,/workspace management/);
 assert.equal(ui.$("buy-storage").textContent,"Continue to Stripe · $81.00 / month");

 ui.$("buy-workspace-name").value="Team archive";await ui.$("buy-storage").click();
 assert.equal(b.calls.length,1);
 assert.deepEqual(b.calls[0].args.line_items,[{price:"price_2tb",quantity:1},{price:"price_turbo",quantity:1}]);
 assert.equal(b.calls[0].args.mode,"subscription");assert.equal(b.calls[0].args.metadata.kind,"workspace_plans");
 assert.deepEqual(ui.assigned,["https://checkout.stripe.com/c/pay/cs_local1"]);
 assert.ok(!ui.said.some(m=>/CLIENT_UPDATE_REQUIRED/.test(m)));

 // Clicking again (e.g. back from a cancelled Stripe page) resumes the same workspace and session.
 await ui.$("buy-storage").click();
 assert.equal(b.calls.length,1,"no second Checkout session");
 assert.deepEqual(ui.assigned,["https://checkout.stripe.com/c/pay/cs_local1","https://checkout.stripe.com/c/pay/cs_local1"]);
 const list=await b.request("/v2/projects");
 assert.equal(list.body.projects.filter(p=>p.name==="Team archive").length,1,"no duplicate pending workspace");
});

test("web card: yearly billing sends one interval for both plans",async t=>{
 const b=await backend(t),api=await browserApi(b.origin);
 await b.request("/v2/projects",{name:"First project",intentId:crypto.randomUUID()});
 const ui=await mountCard(t,api);
 ui.$("buy-tier").value="2TB";ui.$("buy-plan-performance").value="turbo";ui.$("buy-period").value="year";await ui.$("buy-period").change();
 assert.equal(ui.$("storage-total").textContent,"$810.00 / year");
 await ui.$("buy-storage").click();
 assert.deepEqual(b.calls[0].args.line_items,[{price:"price_2tby",quantity:1},{price:"price_turboy",quantity:1}]);
});

test("web card: server error codes become plain-language messages",async t=>{
 const b=await backend(t),api=await browserApi(b.origin);
 await b.request("/v2/projects",{name:"First project",intentId:crypto.randomUUID()});
 const ui=await mountCard(t,api);
 // 100GB yearly + lite yearly are not in the catalog: the server answers 503 PLANS_PRICE_UNCONFIGURED.
 ui.$("buy-tier").value="100GB";ui.$("buy-plan-performance").value="lite";ui.$("buy-period").value="year";
 await ui.$("buy-storage").click();
 assert.equal(b.calls.length,0);assert.equal(ui.assigned.length,0);
 assert.equal(ui.said.at(-1),"This plan is not available to buy right now. Please choose another plan or try again later. Nothing was charged.");
 assert.doesNotMatch(ui.said.at(-1),/^[A-Z_]+$/);
 ui.$("buy-workspace-name").value="x";await ui.$("buy-storage").click();
 assert.equal(ui.said.at(-1),"Enter a workspace name between 3 and 64 characters.");
});

test("friendlyBillingError maps codes, keeps server messages and never shows a bare code",async()=>{
 const {friendlyBillingError:f}=await import(path.join(__dirname,"mobile","billing.mjs"));
 assert.equal(f({message:"CLIENT_UPDATE_REQUIRED",code:"CLIENT_UPDATE_REQUIRED",status:426}),"This page is out of date. Reload it and try again.");
 assert.match(f({message:"PROJECT_LIMIT_REACHED",code:"PROJECT_LIMIT_REACHED",status:409}),/workspace limit/);
 assert.equal(f({message:"SOMETHING_NEW",code:"SOMETHING_NEW",status:409,detail:"Server explanation."}),"Server explanation.");
 assert.equal(f({message:"SOMETHING_NEW",status:409}),"Something went wrong preparing checkout. Please try again. Nothing was charged.");
 assert.equal(f({message:"Choose an active workspace."}),"Choose an active workspace.");
 assert.equal(f({message:"Sign in",status:401}),"Your session expired. Sign in again to continue.");
});

test("web page no longer shows retired Bring Your Own Cloud or workspace-management copy, and never calls the retired draft route",()=>{
 const html=fs.readFileSync(path.join(__dirname,"mobile","index.html"),"utf8"),js=fs.readFileSync(path.join(__dirname,"mobile","billing.mjs"),"utf8");
 assert.doesNotMatch(html,/Bring Your Own Cloud/i);assert.doesNotMatch(html,/before purchasing its subscription/);
 assert.doesNotMatch(js,/workspace management/);assert.doesNotMatch(js,/\/v2\/workspaces\/draft/);assert.doesNotMatch(html,/id="buy-kind"/);
 assert.match(html,/id="buy-plan-performance"/);assert.match(js,/'\/v2\/projects'/);
});

test("storage/performance checkout validates the price before creating a Stripe customer (no orphan customers)",async t=>{
 const b=await backend(t,{customer:null});
 const first=await b.request("/v2/projects",{name:"First project",intentId:crypto.randomUUID()});
 const id=first.body.workspaceId;assert.equal(first.status,201);
 // 6TB monthly storage is not configured on this account.
 const missing=await b.request("/v2/workspaces/"+id+"/checkout/storage",{tier:"6TB",interval:"month",mode:"standard"});
 assert.equal(missing.status,503);assert.equal(b.customers.length,0,"no customer created for a missing price");assert.equal(b.calls.length,0);
 // Control: a configured price creates exactly one customer and one session.
 const ok=await b.request("/v2/workspaces/"+id+"/checkout/storage",{tier:"100GB",interval:"month",mode:"standard"});
 assert.equal(ok.status,200);assert.equal(b.customers.length,1);assert.equal(b.calls.length,1);
 assert.deepEqual(b.calls[0].args.line_items,[{price:"price_100gb",quantity:1}]);
});

test("billing status no longer advertises the retired bring-your-own-cloud kind and keeps projectCreationEnabled",async t=>{
 const b=await backend(t),s=await b.request("/v2/billing/status");
 assert.equal(s.status,200);assert.ok(!s.body.availableKinds.includes("bring-your-own-cloud"));
 assert.ok(s.body.availableKinds.includes("storage"));assert.equal(typeof s.body.projectCreationEnabled,"boolean");
 const src=fs.readFileSync(path.join(__dirname,"billing_bootstrap.js"),"utf8");
 assert.doesNotMatch(src,/'bring-your-own-cloud'/);
});
