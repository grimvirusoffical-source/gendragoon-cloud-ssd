"use strict";
// Production login chain for /v2. Terms acceptance is a separate step from
// token verification so account deletion can keep the token check and skip
// Terms. free_server.js builds both middlewares from this module.
const TERMS_VERSION="terms-2026-10-14-v1";
const BEARER=/^Bearer ([a-zA-Z0-9._~-]+)$/;

function expose(status,message,code){
 const error=new Error(message);
 error.status=status;
 error.expose=message;
 if(code)error.code=code;
 return error;
}
function createLoginGate({verifyIdToken,fetchTerms,decorate}={}){
 if(typeof verifyIdToken!=="function")throw Error("login gate requires verifyIdToken");
 async function readUser(req,{terms}){
  const match=BEARER.exec(req.headers?.authorization||"");
  if(!match)throw expose(401,"Sign in with Google");
  let user;
  try{user=await verifyIdToken(match[1]);}
  catch(_){throw expose(401,"Invalid or expired Firebase login");}
  if(!user||typeof user.uid!=="string"||!user.uid)throw expose(401,"Invalid or expired Firebase login");
  if(user.firebase?.sign_in_provider!=="google.com")throw expose(403,"Google provider required");
  if(terms){
   if(typeof fetchTerms!=="function")throw expose(401,"Invalid or expired Firebase login");
   let response;
   try{response=await fetchTerms(user.uid,match[1]);}
   catch(_){throw expose(401,"Invalid or expired Firebase login");}
   if(!response||response.ok!==true)throw expose(403,"Current Terms acceptance required","terms_required");
   let data;
   try{data=await response.json();}
   catch(_){throw expose(401,"Invalid or expired Firebase login");}
   const fields=data?.fields||{};
   if(fields.termsVersion?.stringValue!==TERMS_VERSION||fields.readConfirmed?.booleanValue!==true||fields.agreed?.booleanValue!==true)
    throw expose(403,"Current Terms acceptance required","terms_required");
  }
  req.user=user;
  if(terms&&typeof decorate==="function")await decorate(req,user);
  return user;
 }
 function middleware({terms}){
  return function loginMiddleware(req,res,next){
   readUser(req,{terms}).then(()=>next()).catch(error=>{
    if(res.headersSent)return;
    const status=Number.isInteger(error?.status)?error.status:401;
    const message=typeof error?.expose==="string"?error.expose:(status===403?"Google provider required":"Invalid or expired Firebase login");
    res.status(status).json({error:message});
   });
  };
 }
 return {firebaseAuth:middleware({terms:true}),firebaseAuthWithoutTerms:middleware({terms:false}),readUser,TERMS_VERSION};
}
module.exports={createLoginGate,TERMS_VERSION};
