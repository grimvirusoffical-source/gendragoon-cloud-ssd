"use strict";
// Shared Teams HTTP fixture: memory Firestore, a Stripe double and signed webhooks. No network.
const assert=require("node:assert/strict"),crypto=require("node:crypto"),express=require("express"),Stripe=require("stripe");
const {memoryFirestore}=require("../test_firestore");
const {installedBilling,STRIPE_API_VERSION}=require("../billing_gateway");
const hash=uid=>crypto.createHash("sha256").update(uid).digest("hex");
const USERS=["test-a","test-b","test-c","test-d","test-e","test-f","test-g"];
const idFor=n=>"abcdef12-1234-4000-8000-"+String(n).padStart(12,"0");
const hookSecret="whsec_disposableFixtureOnly123";
const PRICES={"team|team|month":"price_team","team|team|year":"price_teamyr","team|team_plus|month":"price_teamplus","team|business|month":"price_biz",
 "storage|standard|100GB|month":"price_100gb","performance|boost|month":"price_boost","performance|lite|month":"price_lite"};
const AMOUNTS={price_team:999,price_teamyr:9990,price_teamplus:2499,price_biz:6999,price_100gb:640,price_boost:600,price_lite:300};

async function fixture(t,{bucket=null}={}){
 const db=memoryFirestore(USERS.map(u=>["gd_accounts/"+hash(u),{stripeCustomerId:"cus_"+u.replace("-","")}]));
 const sessions=new Map(),subs=new Map(),calls=[],canceled=[];
 const verifier=new Stripe("sk_test_dummyABC123",{apiVersion:STRIPE_API_VERSION});
 const stripe={webhooks:verifier.webhooks,customers:{create:async()=>({id:"cus_new"})},
   checkout:{sessions:{create:async(args,options)=>{const id="cs_t"+(calls.length+1);calls.push({args,options});
       const s={...args,id,status:"open",url:"https://checkout.stripe.com/c/pay/"+id,amount_total:args.line_items.reduce((n,x)=>n+AMOUNTS[x.price],0)};sessions.set(id,s);return structuredClone(s);},
     retrieve:async id=>structuredClone(sessions.get(id)),expire:async id=>{sessions.get(id).status="expired";return sessions.get(id);}}},
   subscriptions:{retrieve:async id=>structuredClone(subs.get(id)),cancel:async id=>{canceled.push(id);const s=subs.get(id);if(s)s.status="canceled";return s;}}};
 const app=express();app.use("/v2",express.json());
 const firebaseAuth=(req,res,next)=>{const uid=req.headers.authorization?.replace("Bearer ","");if(!USERS.includes(uid))return res.status(401).json({error:"Sign in"});req.user={uid};next();};
 installedBilling({app,db,bucket,stripeOverride:stripe,admin:{firestore:{FieldValue:{serverTimestamp:()=>123}}},firebaseAuth,accountKey:hash,
   env:{STRIPE_SECRET_KEY:"sk_test_dummyABC123",STRIPE_WEBHOOK_SECRET:hookSecret,STRIPE_CHECKOUT_ENABLED:"true",STRIPE_ENVIRONMENT:"test",
     PUBLIC_URL:"https://billing.example",STRIPE_PRICE_CATALOG_JSON:JSON.stringify(PRICES)}});
 const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
 t.after(()=>new Promise(r=>server.close(r)));
 const origin="http://127.0.0.1:"+server.address().port;
 async function request(path,body,token="test-a",method=body===undefined?"GET":"POST"){
   const r=await fetch(origin+path,{method,headers:{"Content-Type":"application/json",...(token?{Authorization:"Bearer "+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
   return {status:r.status,body:await r.json()};
 }
 async function webhook(type,object){
   const payload=JSON.stringify({id:"evt_"+crypto.randomBytes(8).toString("hex"),type,api_version:"2025-06-30.basil",data:{object}});
   const signature=verifier.webhooks.generateTestHeaderString({payload,secret:hookSecret});
   const r=await fetch(origin+"/billing/stripe-webhook",{method:"POST",headers:{"Content-Type":"application/json","Stripe-Signature":signature},body:payload});
   return {status:r.status,body:await r.json()};
 }
 async function paySession(sessionId,status="active",items){
   const s=sessions.get(sessionId),id="sub_"+sessionId;
   const sub={id,customer:s.customer,status,metadata:s.metadata,items:{data:(items||s.line_items.map(x=>x.price)).map(p=>({price:{id:p},quantity:1}))}};
   subs.set(id,sub);s.status="complete";
   return webhook("customer.subscription.updated",sub);
 }
 async function team(n=1,body={}){
   const r=await request("/v2/teams",{name:"Studio "+n,intentId:idFor(n),tier:"team",interval:"month",deviceName:"Josh's MacBook Pro",...body});
   assert.equal(r.status,201,JSON.stringify(r.body));
   return r;
 }
 async function activeTeam(n=1,body={}){
   const r=await team(n,body);await paySession(r.body.url.split("/").pop());return r.body.team.id;
 }
 async function invite(id){const r=await request("/v2/teams/"+id+"/invites",{});assert.equal(r.status,201,JSON.stringify(r.body));return r.body;}
 async function join(id,user,color,extra={}){const inv=await invite(id);return request("/v2/teams/join",{code:inv.code,color,deviceName:user+" phone",...extra},user);}
 async function personal(user,n){
   // A personal workspace, written the way the projects service stores it.
   const id=idFor(900+n);db.rows.set("gd_accounts/"+hash(user)+"/workspaces/"+id,{name:"Private "+user+" "+n,accountHash:hash(user),kind:"paid",projectStatus:"active"});
   return id;
 }
 return {db,origin,request,webhook,paySession,team,activeTeam,invite,join,personal,calls,subs,sessions,canceled,hash,idFor};
}

module.exports={fixture,hash,idFor,USERS};
