import {attachBilling} from './billing.mjs';
import {BrowserCloud,CloudError,workers} from './transfer-client.mjs';
const $=id=>document.getElementById(id),say=message=>{$('status').textContent=message;};
const TERM='terms-2026-10-14-v1';let auth,api,user,config,sdk,busy=false,ownedBlob=null,generation=0,allFiles=[],activeFilter="all";
const billing=attachBilling({getAPI:()=>api,say});
const mobile=matchMedia('(pointer:coarse)').matches,gb=n=>(n/1e9).toFixed(2)+' GB';
function setBusy(value){busy=value;for(const id of ['workspace','files-input','refresh','create-free','data-saver','sign-out'])$(id).disabled=value;
 $('upload-label').classList.toggle('disabled',value);$('pause').hidden=!value;$('transfer').hidden=!value;
 for(const button of document.querySelectorAll('#files-list button'))button.disabled=value;}
function progress(p){$('transfer-progress').value=p.done/p.total;const rate=p.rate>0?(p.rate/1e6).toFixed(1)+' MB/s':'';
 $('transfer-label').textContent=p.phase+' · '+Math.round(p.done/p.total*100)+'%'+(rate?' · '+rate:'');}
const workspace=()=>$('workspace').value;
async function currentToken(force=false){const current=auth.currentUser;if(!current||current.uid!==user?.uid)throw new CloudError('Your account changed. Sign in again.',401);return current.getIdToken(force);}
async function consentStatus(){
 const uid=encodeURIComponent(user.uid),path='https://firestore.googleapis.com/v1/projects/'+config.projectId+'/databases/(default)/documents/accepted_terms/'+uid;
 const response=await fetch(path,{headers:{Authorization:'Bearer '+await currentToken()},cache:'no-store'});
 if(response.status===404)return false;if(!response.ok)throw new CloudError('Cannot verify your Terms record. Please retry.',response.status);
 const data=await response.json(),fields=data.fields||{};
 return fields.termsVersion?.stringValue===TERM&&fields.readConfirmed?.booleanValue===true&&fields.agreed?.booleanValue===true;
}
async function showCloud(){
 const run=++generation;api?.pause();api=new BrowserCloud({uid:user.uid,token:currentToken});
 const accepted=await consentStatus();if(run!==generation)return;
 document.body.classList.toggle('authenticated',accepted);$('login-card').hidden=true;$('terms-card').hidden=accepted;$('cloud-card').hidden=!accepted;billing.setSignedIn(accepted);
 if(!accepted){$('terms').textContent=await(await fetch('./terms.txt')).text();say('Read the Terms and choose both checkboxes to continue.');return;}
 $('account').textContent=user.email||'Google account';await refresh();
}
async function refresh(){
 if(!api||busy)return;const old=workspace(),identity=user?.uid;
 const response=await(await api.request('/v2/workspaces')).json();if(user?.uid!==identity)return;
 $('workspace').replaceChildren(new Option('Free · 2 GB','free'));
 for(const item of response.workspaces||[])if(item.kind==='paid'&&item.storageActive&&item.provisioned)$('workspace').add(new Option(item.name,item.id));
 if([...$('workspace').options].some(o=>o.value===old))$('workspace').value=old;
 try{
  const c=await api.config(workspace());if(user?.uid!==identity)return;$('create-free').hidden=true;$('upload-label').hidden=false;
  $('usage').textContent=gb(c.usedBytes)+' / '+gb(c.quotaBytes);
  const used=workers(c.transfer,{mobile,saveData:$('data-saver').checked});
  $('workers').textContent=String(used)+(used<c.transfer.workers?' / '+c.transfer.workers:'');
  $('storage-progress').value=Math.min(1,(c.usedBytes+c.reservedBytes)/c.quotaBytes);
  const files=await api.list(workspace());if(user?.uid!==identity)return;render(files);say('Your private workspace is ready. Originals are retained on upload.');
 }catch(error){
  if(error.status===404&&workspace()==='free'){$('create-free').hidden=false;$('upload-label').hidden=true;$('usage').textContent='0 / 2 GB';$('workers').textContent='1';render([]);say('Create your free workspace to begin.');}
  else throw error;
 }
}
function category(file){
 const ext=file.name.split('.').pop().toLowerCase();
 if(['mp3','wav','flac','aac','m4a','ogg','aiff'].includes(ext))return 'audio';
 if(['png','jpg','jpeg','webp','gif','heic','svg'].includes(ext))return 'image';
 if(['zip','7z','tar','gz','rar','dmg','ipa','apk','aab'].includes(ext))return 'archive';
 if(['pdf','txt','md','doc','docx','xls','xlsx','csv','json','rtf','pages'].includes(ext))return 'document';
 return 'other';
}
function render(files){allFiles=files;drawFiles();}
function drawFiles(){
 const term=$('file-search').value.trim().toLocaleLowerCase(),sort=$('file-sort').value;
 const files=allFiles.filter(f=>(activeFilter==='all'||category(f)===activeFilter)&&f.name.toLocaleLowerCase().includes(term)).sort((a,b)=>sort==='largest'?b.sizeBytes-a.sizeBytes:sort==='smallest'?a.sizeBytes-b.sizeBytes:a.name.localeCompare(b.name,undefined,{numeric:true}));
 $('file-count').textContent=files.length+' '+(files.length===1?'file':'files');
 $('files-list').replaceChildren();
 if(!files.length){const empty=document.createElement('p');empty.className='small';empty.textContent=allFiles.length?'No matching files. Try another search or filter.':'No cloud files yet.';$('files-list').append(empty);}
 for(const file of files){
  const row=document.createElement('div');row.className='file';const badge=document.createElement('div');badge.className='file-icon '+category(file);badge.textContent=({audio:'♫',image:'▧',document:'≡',archive:'▣',other:'◇'})[category(file)];badge.setAttribute('aria-hidden','true');const info=document.createElement('div');info.className='file-info';
  const name=document.createElement('p');name.className='filename';name.textContent=file.name;const size=document.createElement('p');size.className='file-size';size.textContent=gb(file.sizeBytes);info.append(name,size);
  const actions=document.createElement('div');actions.className='file-actions';
  const restore=document.createElement('button');restore.className='secondary';restore.textContent='Restore';restore.addEventListener('click',()=>download(file).catch(showError));
  const remove=document.createElement('button');remove.className='delete';remove.textContent='Delete';remove.addEventListener('click',async()=>{
   if(busy||!confirm('Delete the cloud copy of '+file.name+'? Local copies are not affected.'))return;
   try{await api.delete(file.id,workspace());await refresh();}catch(error){showError(error);}
  });actions.append(restore,remove);restore.disabled=busy;remove.disabled=busy;row.append(badge,info,actions);$('files-list').append(row);
 }
}
async function download(file){
 if(busy)return;let writer=null;
 if(typeof window.showSaveFilePicker==='function'){const handle=await showSaveFilePicker({suggestedName:file.name});writer=await handle.createWritable();}
 setBusy(true);
 try{
  const blob=await api.download(file,workspace(),{writer,onProgress:progress});
  if(blob){if(ownedBlob)URL.revokeObjectURL(ownedBlob);ownedBlob=URL.createObjectURL(blob);
   const link=document.createElement('a');link.href=ownedBlob;link.download=file.name;link.textContent='Save '+file.name;link.className='button';
   const share=document.createElement('button');share.className='secondary';share.textContent='Open share sheet';
   share.addEventListener('click',async()=>{try{const shared=new File([blob],file.name,{type:'application/octet-stream'});if(!navigator.canShare?.({files:[shared]}))throw new Error('Sharing is not supported here. Use Save instead.');await navigator.share({files:[shared],title:file.name});}catch(error){showError(error);}});
   $('download-actions').replaceChildren(link);if(navigator.share)$('download-actions').append(share);
   // Keep the download user-initiated on mobile; do not navigate away unexpectedly.
   say('File verified. Tap Save or Open share sheet to choose where it goes.');
  }else say('File verified and saved to your chosen destination.');
 }finally{setBusy(false);}
}
function showError(error){say(error.name==='AbortError'?'Transfer paused. Reselect the same file to resume an upload.':error.message||'Cloud request failed.');}
async function uploadSelection(files){
 if(busy||!api||!files.length)return;setBusy(true);
 try{for(const file of files){say('Uploading '+file.name+'…');await api.upload(file,workspace(),{mobile,saveData:$('data-saver').checked,onProgress:progress});}setBusy(false);await refresh();say('Files verified and saved. Your originals are unchanged.');}
 catch(error){showError(error);}finally{setBusy(false);$('files-input').value='';}
}
$('files-input').addEventListener('change',event=>uploadSelection([...event.target.files]));
$('file-search').addEventListener('input',drawFiles);$('file-sort').addEventListener('change',drawFiles);
$('layout-toggle').addEventListener('click',()=>{const grid=$('files-list').classList.toggle('grid-view');$('layout-toggle').textContent=grid?'List view':'Grid view';$('layout-toggle').setAttribute('aria-pressed',String(grid));$('layout-toggle').setAttribute('aria-label',grid?'Switch to list view':'Switch to grid view');});
for(const button of document.querySelectorAll('[data-filter]'))button.addEventListener('click',()=>{activeFilter=button.dataset.filter;for(const other of document.querySelectorAll('[data-filter]')){other.classList.toggle('active',other===button);other.setAttribute('aria-pressed',String(other===button));}drawFiles();});
let dragDepth=0;
window.addEventListener('dragenter',event=>{if(!user||busy||!Array.from(event.dataTransfer?.types||[]).includes('Files'))return;event.preventDefault();dragDepth++;$('drop-target').hidden=false;});
window.addEventListener('dragleave',()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('drop-target').hidden=true;});
window.addEventListener('dragover',event=>{if(user&&Array.from(event.dataTransfer?.types||[]).includes('Files'))event.preventDefault();});
window.addEventListener('drop',event=>{dragDepth=0;$('drop-target').hidden=true;if(!user)return;event.preventDefault();if(busy)return;
 const entries=Array.from(event.dataTransfer?.items||[]);if(entries.some(i=>i.webkitGetAsEntry?.()?.isDirectory)){say('Archive folders before uploading. No files were uploaded.');return;}
 uploadSelection(Array.from(event.dataTransfer?.files||[]));});
window.addEventListener('offline',()=>say('You are offline. Your completed upload chunks are retained; reconnect and reselect the file to resume.'));
$('pause').addEventListener('click',()=>api?.pause());
$('refresh').addEventListener('click',()=>refresh().catch(showError));$('workspace').addEventListener('change',()=>refresh().catch(showError));
$('data-saver').checked=!!navigator.connection?.saveData||navigator.connection?.type==='cellular';
$('data-saver').addEventListener('change',()=>refresh().catch(showError));
$('create-free').addEventListener('click',async()=>{try{await api.request('/v1/free',{method:'POST',json:{name:'My Free Cloud'}});await refresh();}catch(error){showError(error);}});
$('sign-out').addEventListener('click',()=>sdk.signOut(auth).catch(showError));
$('accept-terms').addEventListener('click',async()=>{
 if(!$('read-terms').checked||!$('agree-terms').checked)return say('Read the Terms and choose both checkboxes first.');
 $('accept-terms').disabled=true;
 try{
  const name='projects/'+config.projectId+'/databases/(default)/documents/accepted_terms/'+user.uid;
  const result=await fetch('https://firestore.googleapis.com/v1/projects/'+config.projectId+'/databases/(default)/documents:commit',{
   method:'POST',headers:{Authorization:'Bearer '+await currentToken(),'Content-Type':'application/json'},
   body:JSON.stringify({writes:[{update:{name,fields:{termsVersion:{stringValue:TERM},readConfirmed:{booleanValue:true},agreed:{booleanValue:true}}},updateTransforms:[{fieldPath:'acceptedAt',setToServerValue:'REQUEST_TIME'}],currentDocument:{exists:false}}]})});
  if(!result.ok)throw new Error('Terms acceptance could not be saved. No acceptance was assumed.');await showCloud();
 }catch(error){showError(error);}finally{$('accept-terms').disabled=false;}
});
window.addEventListener('pagehide',()=>{api?.pause();if(ownedBlob)URL.revokeObjectURL(ownedBlob);});
try{
 config=await(await fetch('./firebase-public.json',{cache:'no-store'})).json();
 const [appModule,authModule]=await Promise.all([import('https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js'),import('https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js')]);
 sdk=authModule;auth=sdk.getAuth(appModule.initializeApp(config));await sdk.setPersistence(auth,sdk.browserSessionPersistence);
 $('sign-in').disabled=false;$('sign-in').textContent='Continue with Google';say('Sign in to open your private cloud.');
 $('sign-in').addEventListener('click',()=>sdk.signInWithPopup(auth,new sdk.GoogleAuthProvider()).catch(error=>{
  if(error.code==='auth/unauthorized-domain')say('The site owner must authorize this host in Firebase before sign-in can work.');
  else if(error.code==='auth/popup-blocked')say('Allow the Google sign-in popup, then tap Continue with Google again.');else showError(error);
 }));
 sdk.onAuthStateChanged(auth,current=>{
  generation++;api?.pause();user=current;
  if(current)showCloud().catch(showError);
  else{billing.setSignedIn(false);api=null;allFiles=[];document.body.classList.remove('authenticated');$('download-actions').replaceChildren();if(ownedBlob)URL.revokeObjectURL(ownedBlob);ownedBlob=null;$('files-list').replaceChildren();$('account').textContent='';$('cloud-card').hidden=true;$('terms-card').hidden=true;$('login-card').hidden=false;say('Sign in to open your private cloud.');}
 });
}catch(error){$('sign-in').textContent='Sign-in unavailable';showError(error);}
