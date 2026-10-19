"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),{spawn}=require("node:child_process");
const path=require("node:path");
test("unconfigured development server is safe to start and rejects anonymous access",async()=>{
 const env={...process.env,GOOGLE_CLOUD_PROJECT:"gendragoonssd",
   STRIPE_SECRET_KEY:"sk_test_dummy_not_real",STRIPE_WEBHOOK_SECRET:"whsec_dummy_not_real",
   STRIPE_PRICE_IDS_JSON:"{}",PUBLIC_URL:"https://example.test",PORT:"19088"};
 const child=spawn(process.execPath,[path.join(__dirname,"server.js")],{env,stdio:["ignore","pipe","pipe"]});
 let log="";child.stderr.on("data",buf=>log+=buf.toString());
 try{
  let ready=false;
  for(let i=0;i<35;i++){
   if(child.exitCode!==null)break;
   try{const r=await fetch("http://127.0.0.1:19088/health");
      if(r.ok){const b=await r.json();assert.equal(b.state,"development");ready=true;break;}}
   catch{}
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(ready,"Backend did not start: "+log.slice(0,200));
  for(const path of ["/session","/v2/workspaces","/storage/status"]){
   const r=await fetch("http://127.0.0.1:19088"+path);
   assert.equal(r.status,401,path+" should require verified Google login");
  }
  const r=await fetch("http://127.0.0.1:19088/v2/workspaces/draft",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"unauthorized",storage:"100GB"})});
  assert.equal(r.status,401);
 }finally{child.kill("SIGTERM");}
});
