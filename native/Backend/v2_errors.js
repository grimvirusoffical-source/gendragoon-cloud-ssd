"use strict";
// JSON responses for every /v2 route that does not match, and for parser or
// unexpected failures. Bodies are {error} only. Stack traces stay in the log.
function installV2Errors(app){
 if(!app||typeof app.use!=="function")throw Error("v2 errors require an app");
 app.use("/v2",(err,req,res,next)=>{
  if(res.headersSent)return next(err);
  const type=err?.type||"";
  if(err?.status===413||type==="entity.too.large")return res.status(413).json({error:"payload_too_large"});
  if(type==="entity.parse.failed"||(err instanceof SyntaxError&&err.status===400))
   return res.status(400).json({error:"invalid_json"});
  console.error("v2 request failed",err?.code||err?.name||"internal");
  res.status(500).json({error:"internal"});
 });
 app.use("/v2",(_req,res)=>{
  res.status(404).json({error:"not_found"});
 });
}
module.exports={installV2Errors};
