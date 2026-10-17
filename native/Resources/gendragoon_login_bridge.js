"use strict";
const http=require("node:http"),fs=require("node:fs");
const path=require("node:path");
const configPath=process.argv[2],nonce=process.argv[3];
if(!configPath||!nonce||nonce.length<20)process.exit(2);
const config=JSON.parse(fs.readFileSync(configPath,"utf8"));
if(config.projectId!=="gendragoonssd"||!config.apiKey||!config.appId||!config.authDomain)process.exit(3);
const appConfig=JSON.stringify(config).replace(/</g,"\\u003c");
let used=false;
let port=0;
const html=()=>`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GenDragoonSSD - Google Sign In</title>
<style>
body{margin:0;background:#100c1a;color:#f3efff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
display:grid;place-items:center;min-height:100vh}
main{max-width:480px;padding:38px;background:#221b37;border:1px solid #554678;border-radius:20px;text-align:center}
h1{font-size:28px;margin:12px 0}p{line-height:1.5;color:#c9c1d8}
button{background:#a381ff;color:#120b20;font-size:16px;font-weight:700;border:0;border-radius:12px;
padding:14px 22px;cursor:pointer}button:disabled{opacity:.5}
small{display:block;margin-top:20px;color:#bbb1c9}
</style></head><body><main>
<div style="font-size:38px">☁</div><h1>GenDragoonSSD</h1>
<p>Sign in securely with Google to continue to your cloud workspace. After login, return to the GenDragoon app to read and accept the Terms of Service.</p>
<button id="signin">Continue with Google</button>
<p id="status" aria-live="polite">No storage or payment access is granted by signing in.</p>
<small>Official Google authentication · Firebase project gendragoonssd</small>
</main>
<script type="module">
import {initializeApp} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {getAuth,GoogleAuthProvider,signInWithPopup,setPersistence,browserSessionPersistence}
 from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
const firebase=initializeApp(${appConfig});
const auth=getAuth(firebase),provider=new GoogleAuthProvider();
const button=document.getElementById("signin"),status=document.getElementById("status");
button.addEventListener("click",async()=>{
 button.disabled=true;status.textContent="Opening Google login…";
 try{
  await setPersistence(auth,browserSessionPersistence);
  const result=await signInWithPopup(auth,provider);
  const idToken=await result.user.getIdToken(true);
  const refreshToken=result.user.refreshToken;
  const response=await fetch("/complete",{method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({nonce:${JSON.stringify(nonce)},idToken,refreshToken})});
  if(!response.ok)throw Error("The Mac app did not accept the login response.");
  status.textContent="Google login completed. Return to GenDragoon on your Mac.";
  button.remove();
 }catch(error){
  button.disabled=false;
  status.textContent=error.code ? "Google sign-in failed: "+error.code : "Sign-in failed. Please try again.";
 }
});
</script></body></html>`;
const server=http.createServer((req,res)=>{
 const origin="http://localhost:"+port;
 res.setHeader("Cache-Control","no-store");
 res.setHeader("X-Content-Type-Options","nosniff");
 res.setHeader("Referrer-Policy","no-referrer");
 if(req.method==="GET"&&req.url==="/"){
  res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});return res.end(html());
 }
 if(req.method==="POST"&&req.url==="/complete"&&!used&&req.headers.origin===origin){
  let body="",size=0;
  req.on("data",chunk=>{
   size+=chunk.length;if(size>35000){req.destroy();return;}body+=chunk;
  });
  req.on("end",()=>{
   try{
    const data=JSON.parse(body);
    if(data.nonce!==nonce||typeof data.idToken!=="string"||!data.idToken.startsWith("eyJ")||
      data.idToken.length<150||typeof data.refreshToken!=="string"||data.refreshToken.length<30)throw Error("bad payload");
    used=true;res.writeHead(200,{"Content-Type":"application/json"});
    res.end('{"ok":true}');
    process.stdout.write("RESULT "+Buffer.from(JSON.stringify({
      idToken:data.idToken,refreshToken:data.refreshToken})).toString("base64")+"\n");
    server.close();
   }catch(_){res.writeHead(400);res.end();}
  });return;
 }
 res.writeHead(404);res.end();
});
server.listen(0,"127.0.0.1",()=>{
 port=server.address().port;
 process.stdout.write("READY http://localhost:"+port+"/\n");
});
setTimeout(()=>{server.close();process.exit(0)},180000).unref();
