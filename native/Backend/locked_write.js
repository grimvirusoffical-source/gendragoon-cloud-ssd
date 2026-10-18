"use strict";
// Pure workspace-lock guard for free-tier writes. Callers inject the database
// and the project list so tests can require this module without Firestore.
const {summarizeProjects,lockBody,LIST_UNAVAILABLE_LOCK}=require("./workspace_policy");

function isProjectList(value){return Array.isArray(value);}

async function lockedWrite(req,res,deps){
 const {db,accountKey,listAccountProjects}=deps||{};
 const summarize=deps?.summarizeProjects||summarizeProjects;
 const bodyFor=deps?.lockBody||lockBody;
 try{
  const listed=await listAccountProjects(db,accountKey(req.user.uid));
  if(!isProjectList(listed)){
   res.status(423).json(LIST_UNAVAILABLE_LOCK);
   return true;
  }
  const summary=summarize(listed);
  if(!summary.locked)return false;
  res.status(423).json(bodyFor(summary));
  return true;
 }catch(_){
  res.status(503).json({error:"Workspace policy unavailable"});
  return true;
 }
}

module.exports={lockedWrite,isProjectList};
