"use strict";
// Optional check that Secret Manager has SUPPORT_DISCORD_WEBHOOK_URL.
// This is not the production start gate. stdout from gcloud is discarded so the
// secret value cannot be printed, including if a caller switches to versions access.
const {spawnSync}=require("node:child_process");
const secret="SUPPORT_DISCORD_WEBHOOK_URL";
const project=process.env.GCLOUD_PROJECT||process.env.GOOGLE_CLOUD_PROJECT||process.env.STORAGE_PROJECT_ID||"gendragood-ssd";
const result=spawnSync("gcloud",["secrets","versions","describe","latest","--secret="+secret,"--project="+project,"--format=value(state)"],{encoding:"utf8"});
if(result.error){
 console.error("predeploy:check failed: secret "+secret+" is missing");
 process.exit(1);
}
const state=(result.stdout||"").trim().split(/\s+/)[0];
if(result.status!==0||state!=="enabled"){
 console.error("predeploy:check failed: secret "+secret+" is missing");
 process.exit(1);
}
console.log("predeploy:check ok: secret "+secret+" exists");
