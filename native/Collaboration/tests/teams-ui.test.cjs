'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
class Element{
 constructor(tag='div'){this.tag=tag;this.children=[];this.value='';this.hidden=false;this.classList={toggle(){}};this.textContent='';this.scrollHeight=0;}
 append(...children){for(const child of children){child.parent=this;this.children.push(child);}}
 replaceChildren(...children){this.children=[];this.append(...children);if(this.tag==='select')this.value=children[0]?.value||'';}
 add(option){this.append(option)}
 get firstChild(){return this.children[0]}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this)}
}
function fixture({accepted=true,serviceOwner=false,communityFailure=false}={}){
 const elements=new Map(),calls=[],peers=[],blocked=new Set(),tid='a'.repeat(32),self={peerId:'owner',username:'Owner',role:'owner'};let rulesAccepted=accepted;
 const names=['Alice','Bob','Charlie'],members=Array.from({length:125},(_,i)=>({peerId:'p'+i,username:names[i%3]+i,role:'peer'}));
 const team={id:tid,name:'Development',role:'owner',me:self};let removed=false;
 const api=async(route,method='GET',body)=>{
  calls.push({route,method,body});const u=new URL(route,'https://fixture.invalid'),cursor=u.searchParams.get('cursor'),start=Number(cursor||0);
  const paged=(key,rows)=>({[key]:rows.slice(start,start+50),cursor:String(start+Math.min(50,rows.length-start)),nextCursor:start+50<rows.length?String(start+50):null});
  if(u.pathname==='/v1/receivers/me/dev-community'){if(communityFailure)throw new Error('Fixture server unavailable');if(method==='PUT')rulesAccepted=body.version==='fixture-v1'&&body.accepted===true;return{policy:{version:'fixture-v1',rules:['Fixture community rule'],notice:'Fixture reporting notice'},accepted:rulesAccepted,serviceOwner};}
  if(u.pathname==='/v1/receivers/me/dev-profile')return{profile:{username:'Owner'}};
  if(u.pathname==='/v1/receivers/me/dev-teams')return paged('teams',Array.from({length:121},(_,i)=>({...team,id:i===0?tid:i.toString(16).padStart(32,'0'),name:'Team '+i})));
  if(u.pathname.endsWith('/members')&&method==='GET')return paged('members',members.filter(m=>!removed||m.peerId!=='p0').map(m=>({...m,blockedByYou:blocked.has(m.peerId),directAvailable:!blocked.has(m.peerId)})));
  if(u.pathname.endsWith('/members/p0')&&method==='DELETE'){removed=true;return{removed:true};}
  if(u.pathname.endsWith('/invites')&&method==='GET')return paged('invites',[{id:'b'.repeat(32),expiresAtMs:Date.now()+100000,revoked:false,consumed:false}]);
  if(u.pathname.includes('/invites/')&&method==='DELETE')return{revoked:true};
  if(u.pathname.endsWith('/membership')&&method==='DELETE')return{left:true};
  if(u.pathname.endsWith('/messages'))return{messages:[{id:'msg',peerId:'p0',username:'<svg onload=alert(1)>',text:'<script>private()</script>'}],cursor:'1'};
  if(u.pathname.endsWith('/signals'))return{signals:[],cursor:'1'};
  if(u.pathname.includes('/blocks/')&&['PUT','DELETE'].includes(method)){const peerId=u.pathname.split('/').at(-1);if(method==='PUT')blocked.add(peerId);else blocked.delete(peerId);return{blocked:method==='PUT'};}
  if(u.pathname.endsWith('/reports')&&method==='POST')return{report:{id:'c'.repeat(32)}};
  if(u.pathname.endsWith('/reports')||u.pathname.endsWith('/dev-reports'))return{reports:[{id:'c'.repeat(32),reason:'spam',evidence:{kind:'reporter-provided-direct-text',text:'<script>evidence</script>'}}]};
  if(u.pathname.includes('/reports/')||u.pathname.includes('/dev-reports/'))return{report:{reason:'spam',targetPeerId:'p0',evidence:{kind:'reporter-provided-direct-text',text:'<script>evidence</script>'}},reviews:[{reviewer:'team-owner',input:{status:'reviewed',action:'none',note:'<b>literal</b>'}}]};
  if(u.pathname.endsWith('/presence'))return{expiresAtMs:Date.now()+45000};
  if(u.pathname==='/v1/receivers/teams/'+tid)return{team,self};
  throw new Error('Unexpected fixture route: '+method+' '+route);
 };
 const el=id=>{if(!elements.has(id))elements.set(id,new Element(id==='recipient'?'select':'div'));return elements.get(id)};
 class Peer{constructor(options){this.closed=[];this.onMessage=options.onMessage;peers.push(this);}async revalidate(){}shutdown(){}close(id){this.closed.push(id)}async handleSignal(){}}
 const window={gdNative:{request:api},confirm:()=>true,dispatchEvent(){},addEventListener(){}};
 const context={window,document:{getElementById:el,createElement:t=>new Element(t)},crypto:globalThis.crypto,Option:function(text,value){return{textContent:text,value}},GDDevPeer:{Session:Peer},setInterval(){},Event:class{},URL,Date,console};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../teams-ui.js'),'utf8'),context);
 return{el,calls,window,peers,setCommunityFailure:value=>{communityFailure=value},configure:()=>window.GenDragoonTeams.configure({workspaceId:'f'.repeat(32),workspaceName:'Fixture'}),open:async()=>el('teams').children[0].children[1].onclick()};
}
test('team and member lists can page past50 without an artificial total cap',async()=>{
 const f=fixture();await f.configure();assert.equal(f.el('teams').children.length,50);assert.equal(f.el('more-teams').hidden,false);
 await f.el('more-teams').onclick();await f.el('more-teams').onclick();assert.equal(f.el('teams').children.length,121);assert.equal(f.el('more-teams').hidden,true);
 await f.open();assert.equal(f.el('members').children.length,50);
 await f.el('more-members').onclick();await f.el('more-members').onclick();assert.equal(f.el('members').children.length,125);assert.equal(f.el('more-members').hidden,true);
});
test('removal, invitation revocation and self leave call their distinct authorization routes',async()=>{
 const f=fixture();await f.configure();await f.open();
 await f.el('members').children[0].children[2].onclick();assert(f.calls.some(c=>c.method==='DELETE'&&c.route.endsWith('/members/p0')));
 await f.el('refresh-invites').onclick();await f.el('invites').children[0].children[1].onclick();assert(f.calls.some(c=>c.method==='DELETE'&&c.route.endsWith('/invites/'+'b'.repeat(32))));
 await f.el('leave').onclick();assert(f.calls.some(c=>c.method==='DELETE'&&c.route.endsWith('/membership')));
});
test('peer-supplied chat and username render as literal text',async()=>{
 const f=fixture();await f.configure();await f.open();const message=f.el('messages').children[0];
 assert.equal(message.children[0].textContent,'<svg onload=alert(1)> · team chat');
 assert.equal(message.children[1].textContent,'<script>private()</script>');assert.equal(message.children[1].children.length,0);
});
const flush=()=>new Promise(setImmediate),submit=element=>element.onsubmit({preventDefault(){}});
test('rules display the server version and participation stays disabled until explicit acceptance',async()=>{
 const f=fixture({accepted:false});await f.configure();assert.equal(f.el('community-version').textContent,'Current rules · fixture-v1');assert.equal(f.el('community-rules').children[0].textContent,'Fixture community rule');
 for(const name of ['save-username','join-team','send-message','create-team'])assert.equal(f.el(name).disabled,true);
 submit(f.el('community-form'));await flush();assert.equal(f.calls.filter(c=>c.method==='PUT').length,0);
 f.el('community-accept').checked=true;submit(f.el('community-form'));await flush();assert(f.calls.some(c=>c.route.endsWith('/dev-community')&&c.body?.accepted===true&&c.body.version==='fixture-v1'));
 for(const name of ['save-username','join-team','send-message','create-team'])assert.equal(f.el(name).disabled,false);
 assert.equal(f.el('community-form').hidden,true);
});
test('blocking closes existing direct connection, removes displayed peer text and supports explicit unblock',async()=>{
 const f=fixture();await f.configure();await f.open();const buttons=()=>f.el('members').children[0].children;
 await buttons().find(x=>x.textContent==='Block user').onclick();assert.deepEqual(f.peers[0].closed,['p0']);assert.equal(f.el('messages').children.length,0);assert(f.calls.some(c=>c.route.endsWith('/blocks/p0')&&c.method==='PUT'));
 assert(!f.el('recipient').children.some(x=>x.value==='p0'));await buttons().find(x=>x.textContent==='Unblock user').onclick();assert(f.calls.some(c=>c.route.endsWith('/blocks/p0')&&c.method==='DELETE'));
});
test('reporting requires visible review and relay reports send a reference without a fabricated transcript',async()=>{
 const f=fixture();await f.configure();await f.open();f.el('messages').children[0].children.find(x=>x.textContent==='Report message').onclick();
 assert.equal(f.el('report-compose').hidden,false);assert.equal(f.el('report-snippet').value,'<script>private()</script>');assert.equal(f.calls.filter(c=>c.method==='POST'&&c.route.endsWith('/reports')).length,0);
 f.el('report-reason').value='spam';submit(f.el('report-form'));await flush();const sent=f.calls.find(c=>c.method==='POST'&&c.route.endsWith('/reports'));assert.equal(sent.body.messageId,'msg');assert.equal(sent.body.directText,undefined);assert.equal(f.el('report-compose').hidden,true);
});
test('direct report snippets require a separate opt-in and never contain attachment or file instructions',async()=>{
 for(const include of [false,true]){const f=fixture();await f.configure();await f.open();f.peers[0].onMessage({id:'direct',peerId:'p1',username:'Bob',text:'Direct fixture',transport:'webrtc-direct'});f.el('messages').children.at(-1).children.find(x=>x.textContent==='Report message').onclick();assert.match(f.el('report-evidence').textContent,/unverified/);assert.equal(f.el('report-direct-consent').checked,false);f.el('report-direct-consent').checked=include;f.el('report-reason').value='spam';submit(f.el('report-form'));await flush();const request=f.calls.find(c=>c.method==='POST'&&c.route.endsWith('/reports')).body;assert.equal(request.directText,include?'Direct fixture':undefined);assert.equal(request.messageId,undefined);assert(!Object.keys(request).some(k=>['path','file','attachment'].includes(k)));}
});
test('owner review exposes literal evidence and appends a distinct decision; service controls require verified flag',async()=>{
 const f=fixture({serviceOwner:true});await f.configure();await f.open();assert.equal(f.el('service-moderation').hidden,false);await f.el('refresh-service-reports').onclick();await f.el('service-reports').children[0].children[1].onclick();assert.match(f.el('review-evidence').textContent,/UNVERIFIED REPORTER-PROVIDED DIRECT TEXT/);assert.match(f.el('review-evidence').textContent,/<script>evidence<\/script>/);assert.equal(f.el('review-evidence').children.length,0);
 f.el('review-status').value='reviewed';f.el('review-action').value='none';submit(f.el('review-form'));await flush();assert(f.calls.some(c=>c.method==='PATCH'&&c.route.includes('/me/dev-reports/')&&c.body.reviewId));
 const peer=fixture();await peer.configure();assert.equal(peer.el('service-moderation').hidden,true);
});

test('unavailable rules leave readable explanation and prevent implicit acceptance',async()=>{
 const f=fixture({accepted:false,communityFailure:true});await f.configure();
 assert.match(f.el('community-version').textContent,/could not be verified/);
 for(const name of ['community-accept','accept-community','save-username','join-team','send-message','create-team'])assert.equal(f.el(name).disabled,true);
 assert.equal(f.calls.filter(c=>c.method==='PUT').length,0);
 f.setCommunityFailure(false);await f.el('reload-community').onclick();
 assert.equal(f.el('community-version').textContent,'Current rules · fixture-v1');
 assert.equal(f.el('community-accept').disabled,false);assert.equal(f.el('community-accept').checked,false);
 assert.equal(f.el('accept-community').disabled,true);assert.equal(f.el('create-team').disabled,true);
});
test('shutdown clears acceptance and blocks participation without a verified current policy',async()=>{
 const f=fixture({accepted:true});await f.configure();assert.equal(f.el('create-team').disabled,false);
 f.window.GenDragoonTeams.shutdown();
 for(const name of ['community-accept','accept-community','save-username','join-team','send-message','create-team'])assert.equal(f.el(name).disabled,true);
});
