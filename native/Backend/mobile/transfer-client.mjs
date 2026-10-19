export class CloudError extends Error {constructor(message,status=0){super(message);this.status=status;}}
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const sha256=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
export function workers(profile,{saveData=false,mobile=false}={}){
 const count=profile?.workers;if(!Number.isInteger(count)||count<1||count>24)throw new CloudError('Invalid server worker limit.');
 return saveData?1:mobile?Math.min(4,count):count;
}
export function received(ranges,index){return ranges.some(r=>Array.isArray(r)&&r.length===2&&index>=r[0]&&index<=r[1]);}
export class BrowserCloud {
 constructor({endpoint=location.origin,uid,token,storage=globalThis.sessionStorage,fetcher=globalThis.fetch}){
  const url=new URL(endpoint);
  if(url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new CloudError('HTTPS is required.');
  if(!uid||typeof token!=='function')throw new CloudError('Sign in before opening cloud storage.');
  this.base=url.origin;this.uid=uid;this.token=token;this.storage=storage;this.fetcher=fetcher.bind(globalThis);this.abort=null;
 }
 path(workspace){if(workspace!=='free'&&!UUID.test(workspace))throw new CloudError('Invalid workspace.');return '/v3/cloud/'+workspace;}
 async request(path,{method='GET',json,body,headers={},signal=this.abort?.signal}={}){
  if(!path.startsWith('/')||path.startsWith('//'))throw new CloudError('Invalid cloud route.');let last;
  for(let attempt=0;attempt<5;attempt++){
   if(signal?.aborted)throw new DOMException('Paused','AbortError');
   try{
    const auth=await this.token(attempt>0);
    const response=await this.fetcher(this.base+path,{method,body:json===undefined?body:JSON.stringify(json),signal,
     cache:'no-store',credentials:'omit',redirect:'error',
     headers:{Authorization:'Bearer '+auth,Accept:'application/json',...(json===undefined?{}:{'Content-Type':'application/json'}),...headers}});
    if(response.ok)return response;
    const error=await response.json().catch(()=>({}));last=new CloudError(error.error||'Cloud request failed ('+response.status+').',response.status);if(typeof error.error==='string')last.code=error.error;if(typeof error.message==='string')last.detail=error.message;
    if(![401,408,429,500,502,503,504].includes(response.status))throw last;
   }catch(error){if(error.name==='AbortError')throw error;if(error instanceof CloudError&&![0,401,408,429,500,502,503,504].includes(error.status))throw error;last=error;}
   if(attempt<4)await new Promise((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);reject(new DOMException('Paused','AbortError'));};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},250*2**attempt+Math.random()*100);
    signal?.addEventListener('abort',abort,{once:true});
   });
  }
  throw last;
 }
 async config(workspace){const result=await(await this.request(this.path(workspace)+'/config')).json();
  if(!Number.isInteger(result.transfer?.chunkBytes)||result.transfer.chunkBytes<1||result.transfer.chunkBytes>8*1024*1024)throw new CloudError('Invalid cloud chunk size.');workers(result.transfer);return result;
 }
 async list(workspace){const files=[];let cursor=null;const seen=new Set();do{
  const result=await(await this.request(this.path(workspace)+'/files'+(cursor?'?cursor='+encodeURIComponent(cursor):''))).json();
  if(!Array.isArray(result.files))throw new CloudError('Invalid file list.');files.push(...result.files);cursor=result.nextCursor;
  if(cursor&&(!UUID.test(cursor)||seen.has(cursor)))throw new CloudError('Invalid pagination cursor.');if(cursor)seen.add(cursor);
 }while(cursor);return files;}
 pause(){this.abort?.abort();}
 async upload(file,workspace,{saveData=false,mobile=false,onProgress=()=>{}}={}){
  if(this.abort)throw new CloudError('One transfer batch is already active.');this.abort=new AbortController();
  try{
   const config=await this.config(workspace),path=this.path(workspace),chunk=config.transfer.chunkBytes;
   if(!Number.isSafeInteger(file.size)||file.size<1||file.size>config.maxFileBytes)throw new CloudError('This file exceeds the workspace file limit.');
   const key='gd-upload-v3:'+await sha256(new TextEncoder().encode([this.uid,workspace,file.name,file.size,file.lastModified].join('|')));
   let id;try{id=this.storage.getItem(key);}catch{}
   if(!UUID.test(id||''))id=crypto.randomUUID();
   try{this.storage.setItem(key,id);}catch{throw new CloudError('Browser storage is unavailable. Enable site storage before uploading.');}
   const job=await(await this.request(path+'/uploads',{method:'POST',json:{requestId:id,name:file.name,sizeBytes:file.size}})).json();
   if(job.uploadId!==id||job.chunkBytes!==chunk||job.totalChunks!==Math.ceil(file.size/chunk))throw new CloudError('Invalid upload session.');
   if(job.status==='completed'){this.storage.removeItem(key);return;}
   if(!['active','assembling'].includes(job.status)){this.storage.removeItem(key);throw new CloudError('The previous upload expired. Choose this file again.');}
   let next=0,done=job.uploadedBytes,initial=done;const started=performance.now(),count=job.totalChunks;
   const work=async()=>{while(next<count){
    while(next<count&&received(job.receivedRanges,next))next++;if(next>=count)return;const index=next++;
    const bytes=await file.slice(index*chunk,Math.min(file.size,(index+1)*chunk)).arrayBuffer();
    await this.request(path+'/uploads/'+id+'/chunks/'+index,{method:'PUT',body:bytes,
     headers:{'Content-Type':'application/octet-stream','X-Chunk-SHA256':await sha256(bytes)}});
    done+=bytes.byteLength;onProgress({done,total:file.size,rate:(done-initial)/Math.max(.001,(performance.now()-started)/1000),phase:'Uploading'});
   }};
   if(job.status==='active'){
    const jobs=Array.from({length:workers(config.transfer,{saveData,mobile})},()=>work().catch(error=>{this.abort.abort();throw error;}));
    const result=await Promise.allSettled(jobs);const failed=result.find(r=>r.status==='rejected');if(failed)throw failed.reason;
   }
   while(true){
    const response=await this.request(path+'/uploads/'+id+'/finalize',{method:'POST',json:{}});
    if(response.status===200)break;if(response.status!==202)throw new CloudError('Invalid finalization response.');
    onProgress({done:file.size,total:file.size,rate:0,phase:'Verifying cloud file'});await new Promise(r=>setTimeout(r,1000));
   }
   this.storage.removeItem(key);onProgress({done:file.size,total:file.size,rate:0,phase:'Saved and verified'});
  }finally{this.abort=null;}
 }
 // Browser fallback is intentionally memory bounded; large downloads require a streaming writer.
 async download(item,workspace,{writer=null,maxMemoryBytes=128*1024*1024,onProgress=()=>{}}={}){
  if(this.abort)throw new CloudError('Finish or pause the current transfer.');
  if(!UUID.test(item.id)||!Number.isSafeInteger(item.sizeBytes)||item.sizeBytes<1)throw new CloudError('Invalid file.');
  if(!writer&&item.sizeBytes>maxMemoryBytes)throw new CloudError('This browser cannot safely save this large file in memory. Use Save-to-file streaming in a supported browser or the desktop app.');
  this.abort=new AbortController();
  try{
   const config=await this.config(workspace),path=this.path(workspace)+'/files/'+item.id+'/download',head=await this.request(path,{method:'HEAD'});
   const etag=head.headers.get('etag');if(!etag||head.headers.get('content-length')!==String(item.sizeBytes))throw new CloudError('Refresh the file list; metadata changed.');
   const blobs=[];let done=0,crc=0xffffffff;const start=performance.now();
   for(let offset=0;offset<item.sizeBytes;offset+=config.transfer.chunkBytes){
    const end=Math.min(item.sizeBytes-1,offset+config.transfer.chunkBytes-1);
    const response=await this.request(path,{headers:{Range:`bytes=${offset}-${end}`,'If-Match':etag}});
    if(response.status!==206||response.headers.get('content-range')!==`bytes ${offset}-${end}/${item.sizeBytes}`||response.headers.get('etag')!==etag)throw new CloudError('Invalid or changed cloud byte range.');
    const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length!==end-offset+1)throw new CloudError('Incomplete byte range.');
    crc=crc32c(bytes,crc);if(writer)await writer.write(bytes);else blobs.push(bytes);
    done+=bytes.length;onProgress({done,total:item.sizeBytes,rate:done/Math.max(.001,(performance.now()-start)/1000),phase:'Restoring'});
   }
   const hash=new Uint8Array(4);new DataView(hash.buffer).setUint32(0,(crc^0xffffffff)>>>0);
   const encoded=btoa(String.fromCharCode(...hash));if(item.crc32c&&item.crc32c!==encoded)throw new CloudError('Checksum mismatch. The download was not committed.');
   if(writer){await writer.close();return null;}return new Blob(blobs,{type:'application/octet-stream'});
  }catch(error){if(writer)await writer.abort().catch(()=>{});throw error;}finally{this.abort=null;}
 }
 async delete(id,workspace){if(!UUID.test(id))throw new CloudError('Invalid file.');return this.request(this.path(workspace)+'/files/'+id,{method:'DELETE'});}
}
const crcTable=Uint32Array.from({length:256},(_,i)=>{let c=i;for(let n=0;n<8;n++)c=c&1?0x82f63b78^(c>>>1):c>>>1;return c>>>0;});
export function crc32c(bytes,seed=0xffffffff){let c=seed;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return c>>>0;}
