'use strict';
(()=>{
 const el=id=>document.getElementById(id),client=globalThis.GDCompanion,platform=globalThis.GDPlatform;
 let notes=[],items=[],sessions=[],epoch=0,polling=false,device=platform.detect(navigator);
 const selected=()=>notes.find(note=>note.id===el('notes').value);
 const report=(message,error=false)=>{el('status').textContent=message;el('status').className=error?'error':'';};
 function describeDevice(){el('device').textContent='This device: '+platform.label(device)+' · '+device.deviceType+(device.architecture&&device.architecture!=='unknown'?' · '+device.architecture:'')+'. Play uses a verified local cache on the matching OS.';}
 async function api(path){return client.call('request',{path,method:'GET'});}
 const action=fn=>Promise.resolve().then(fn).catch(error=>report(error.message||'The companion request failed.',true));
 function draw(){
  el('files').replaceChildren();
  for(const item of items){
   const row=document.createElement('li'),name=document.createElement('span');
   name.textContent=(item.displayName||item.name||'Stored item')+(Number.isSafeInteger(item.archiveBytes)?' · '+new Intl.NumberFormat().format(item.archiveBytes)+' archive bytes':'');row.append(name);
   const active=sessions.some(s=>s.key===item.key&&s.state==='running');
   const pending=sessions.some(s=>s.key===item.key&&s.state!=='running');
   if(platform.canPlay(item,device)||active){
    const button=document.createElement('button');button.type='button';button.textContent=pending?'Starting…':active?'■ Stop':'▶ Play';button.disabled=pending;
    button.setAttribute('aria-label',(active?'Stop ':'Play ')+(item.displayName||item.name));
    button.onclick=()=>action(async()=>{
     const note=selected();if(!note)throw new Error('Choose a workspace first.');
     button.disabled=true;
     try{const result=await client.call(active?'stopApp':'playApp',{workspaceId:note.id,key:item.key});
      report(result.requested?(active?'Stop requested. Confirm any force-quit in GenDragoon.':'Review the application in GenDragoon. Play is not complete until the app starts.'):result.message||'Check GenDragoon.');
     }finally{button.disabled=false;}
     await pollSessions();
    });row.append(button);
   }else if(platform.target(item)){
    const hint=document.createElement('small');hint.textContent=' · '+platform.target(item)+' app'+(platform.target(item)!==device.platform?' — requires that OS':' — restore/install or use its mobile launcher');row.append(hint);
   }
   el('files').append(row);
  }
  if(!items.length){const row=document.createElement('li');row.textContent='No completed stored items in this MachineNote.';el('files').append(row);}
 }
 async function pollSessions(){
  const note=selected();if(!note||!device.nativeAppControl||polling)return;
  const id=note.id;polling=true;
  try{const response=await client.call('appSessions',{workspaceId:id});if(selected()?.id===id){sessions=Array.isArray(response.sessions)?response.sessions:[];draw();}}
  finally{polling=false;}
 }
 async function loadFiles(){
  const current=++epoch,note=selected();items=[];sessions=[];draw();
  const active=note?.active===true&&note.readOnly!==true;
  el('upload-file').disabled=!active;el('upload-folder').disabled=!active;el('teams').disabled=!note;
  el('note-detail').textContent=note?(active?'Ready. For app controls, select and mount this same workspace in GenDragoon.':'Read only or awaiting subscription. Open GenDragoon to manage this workspace.'):'Choose a MachineNote.';
  if(!note)return;
  const response=await api('/v1/receivers/me/workspaces/'+note.id+'/library');if(current!==epoch)return;
  items=Array.isArray(response.items)?response.items:[];draw();await pollSessions();
 }
 async function refresh(){
  report('Waiting for the locally approved GenDragoon app…');const status=await client.call('status');
  device=platform.effective(platform.detect(navigator),status.capabilities);describeDevice();
  if(!status.connected){notes=[];el('notes').replaceChildren();await loadFiles();throw new Error('Open GenDragoon and connect your Red-XAI account.');}
  const prior=el('notes').value,state=await api('/v1/receivers/me');
  notes=(Array.isArray(state.machineNotes)?state.machineNotes:Array.isArray(state.workspaces)?state.workspaces:[]).filter(n=>/^[a-f0-9]{32}$/.test(n.id||''));
  el('notes').replaceChildren();for(const note of notes){const option=document.createElement('option');option.value=note.id;option.textContent=note.name||'MachineNote';el('notes').append(option);}
  if(notes.some(n=>n.id===prior))el('notes').value=prior;
  await loadFiles();report('Connected'+(status.accountLabel?' as '+status.accountLabel:'')+'. App-start and stop requests require native approval.');
 }
 el('refresh').onclick=()=>action(refresh);el('notes').onchange=()=>action(loadFiles);
 for(const kind of ['file','folder'])el('upload-'+kind).onclick=()=>action(async()=>{const note=selected();if(!note)throw new Error('Choose your MachineNote first.');const response=await client.call('selectUpload',{workspaceId:note.id,kind});report(response.cancelled?'Selection cancelled.':response.queued?'Queued in GenDragoon. Wait for verified Succeeded before removing any original.':response.message||'Review the selection in GenDragoon.');});
 el('teams').onclick=()=>{const note=selected();if(!note)return;const url=new URL('teams/index.html',location.href);url.searchParams.set('workspaceId',note.id);url.searchParams.set('workspaceName',note.name||'MachineNote');window.open(url.href,'_blank','noopener');};
 const timer=setInterval(()=>{if(!document.hidden)action(pollSessions);},3000);
 addEventListener('unload',()=>clearInterval(timer));describeDevice();action(refresh);
})();
