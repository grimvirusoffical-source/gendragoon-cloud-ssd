'use strict';
// Private child-process fixture: loopback HTTP and IPC gates only. No database,
// filesystem, provider credentials or real account is used.
const http=require('node:http');
const {createControlLifecycle,runControlCLI}=require('../../control-lifecycle.cjs');
const gates=new Map(),released=new Set();
function gate(name){if(released.has(name))return Promise.resolve();return new Promise(resolve=>gates.set(name,resolve));}
function send(value){if(process.connected)process.send(value);}
process.on('message',name=>{released.add(name);const release=gates.get(name);if(release){gates.delete(name);release();}});
const mode=process.argv[2],createGate=mode==='startup'?gate('create'):Promise.resolve();
let background=Promise.resolve(),drains=0;
const runner=runControlCLI(async()=>{
 send({event:'creating'});await createGate;
 const server=http.createServer(),blocker=mode==='listen-failure'?http.createServer():null;
 if(blocker){background=gate('worker');await new Promise(resolve=>blocker.listen(0,'127.0.0.1',resolve));}
 const lifecycle=createControlLifecycle(server,{drain:async()=>{drains++;send({event:'draining',drains});await background;}});
 server.on('request',lifecycle.admit(async(_req,res)=>{
  const release=gate('handler');send({event:'entered'});await release;
  background=gate('worker');send({event:'worker'});res.end('finished');
  if(mode==='rejected-handler')throw Error('private fixture detail must not be logged');
 }));
 return {async listen(){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(blocker?blocker.address().port:0,'127.0.0.1',resolve);});send({event:'ready',port:server.address().port});},async close(){const closing=lifecycle.close();send({event:'closing'});await closing;if(blocker)await new Promise(resolve=>blocker.close(resolve));send({event:'drained',drains});}};
});
if(mode==='listen-failure')runner.startup.then(()=>{if(process.connected)process.disconnect();});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{send({event:'signal'});runner.stop().then(()=>{if(process.connected)process.disconnect();});});
