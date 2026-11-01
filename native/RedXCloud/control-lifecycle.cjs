'use strict';

// Track handler completion rather than socket completion: an account mutation
// may still be running after its client disconnects. No shutdown deadline is
// allowed to interrupt that work or an account-deletion worker.
function createControlLifecycle(server,{drain}){
 const active=new Set();let closing=false,closePromise;
 function reject(req,res){
  req.resume();
  if(!res.headersSent){res.writeHead(503,{'content-type':'application/json','cache-control':'no-store','connection':'close'});res.end('{"error":"service_closing"}');}
 }
 function admit(handler){return (req,res)=>{
  if(closing){reject(req,res);return;}
  const work=Promise.resolve().then(()=>handler(req,res));active.add(work);
  const done=()=>active.delete(work);
  work.then(done,()=>{
   // A request failure must not become an unhandled rejection or bypass drain.
   try{reject(req,res);}catch{}finally{done();}
  });
 };}
 function close(){
  if(closePromise)return closePromise;
  closing=true;
  // Initiate close synchronously, before awaiting any handlers or workers.
  const httpClosed=new Promise(resolve=>{
   try{server.close(error=>resolve(error?.code==='ERR_SERVER_NOT_RUNNING'?null:error));}
   catch(error){resolve(error);}
  });
  closePromise=(async()=>{
   while(active.size)await Promise.allSettled([...active]);
   let drainError;try{await drain();}catch(error){drainError=error;}
   const closeError=await httpClosed;
   if(drainError||closeError)throw drainError||closeError;
  })();
  return closePromise;
 }
 return {admit,close,get closing(){return closing;}};
}

// Install handlers before asynchronous startup. A second signal never invokes
// Node's default termination or a second drain. Failure deliberately retains the
// process for operator inspection; no forced exit, signals or lock removal.
function runControlCLI(create,{port,processImpl=process}={}){
 let control,stopRequested=false,stopPromise,retention,exitCode=0;
 const fixedError=code=>{try{processImpl.stderr.write(code+'\n');}catch{}};
 const retain=()=>{if(!retention)retention=setInterval(()=>{},1000);};
 const created=Promise.resolve().then(create);
 function stop(){
  stopRequested=true;
  if(stopPromise)return stopPromise;
  stopPromise=created.then(c=>{control=c;return c.close();}).then(()=>{
   processImpl.exitCode=exitCode;
  },()=>{
   if(control){fixedError('control_shutdown_failed');retain();}
   // A failed constructor has admitted no requests. The startup path reports it.
  });
  return stopPromise;
 }
 processImpl.on('SIGTERM',stop);processImpl.on('SIGINT',stop);
 const startup=created.then(async c=>{control=c;if(!stopRequested)await c.listen(port);}).catch(()=>{
  if(!stopRequested){fixedError('control_startup_failed');exitCode=1;}
  else if(!control){fixedError('control_startup_failed');exitCode=1;}
  // A constructed controller can already own background work even if listen
  // failed. Use the very same close promise before allowing startup-failure
  // exit; a drain failure retains the process just as a signal failure does.
  if(control)return stop();
  processImpl.exitCode=exitCode;
 });
 return {startup,stop};
}
module.exports={createControlLifecycle,runControlCLI};
