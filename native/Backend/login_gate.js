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
// With accountsGate (accounts/routes.js), Gendragoon account profiles replace the old Terms record: email/password,
// Google and Red-XAI sign-ins are accepted, and the gate requires a complete profile, the current Terms and the
// second factor. firebaseAuthWithoutTerms still skips it so account deletion always works.
const ACCOUNT_PROVIDERS=new Set(["google.com","password","redxai"]);
function createLoginGate({verifyIdToken,fetchTerms,decorate,accountsGate}={}){
 if(typeof verifyIdToken!=="function")throw Error("login gate requires verifyIdToken");
 async function readUser(req,{terms}){
  const match=BEARER.exec(req.headers?.authorization||"");
  if(!match)throw expose(401,"Sign in with Google");
  let user;
  try{user=await verifyIdToken(match[1]);}
  catch(_){throw expose(401,"Invalid or expired Firebase login");}
  if(!user||typeof user.uid!=="string"||!user.uid)throw expose(401,"Invalid or expired Firebase login");
  if(accountsGate){
   if(!ACCOUNT_PROVIDERS.has(user.firebase?.sign_in_provider))throw expose(403,"Unsupported sign-in provider");
   if(terms){
    try{await accountsGate(user);}
    catch(error){if(Number.isInteger(error?.status))throw error;throw expose(503,"Account check unavailable");}
   }
  }else if(user.firebase?.sign_in_provider!=="google.com")throw expose(403,"Google provider required");
  if(terms&&!accountsGate){
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
    // Account steps use the Red-XAI Accounts v1.1 error shape: {error:<code>, message, pending}. `code` repeats the
    // code for clients built against the earlier shape. Other failures keep {error:<message>} for older apps.
    let body={error:message};
    if(Array.isArray(error?.pending))body={error:error.code,message,code:error.code,pending:error.pending};
    else if(error?.accountError===true&&typeof error.code==="string"){
     body={error:error.code,message,code:error.code};
     if(typeof error.field==="string")body.field=error.field;
    }
    res.status(status).json(body);
   });
  };
 }
 return {firebaseAuth:middleware({terms:true}),firebaseAuthWithoutTerms:middleware({terms:false}),readUser,TERMS_VERSION};
}
module.exports={createLoginGate,TERMS_VERSION};
