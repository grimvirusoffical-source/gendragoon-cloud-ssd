"use strict";
// Writes fixtures/<area>/<case>.json. Key-envelope cases live in their own exporter.
const {spawnSync}=require("node:child_process");
const path=require("node:path");

const outDir=path.resolve(process.argv[2]||path.join(__dirname,"../../../fixtures"));
const envelope=spawnSync(process.execPath,[path.join(__dirname,"export_key_envelope_fixtures.js"),outDir],{encoding:"utf8"});
if(envelope.status!==0){
 console.error((envelope.stderr||"")+(envelope.stdout||"")||"key-envelope fixtures failed");
 process.exit(envelope.status||1);
}
