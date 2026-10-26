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
function fixture(){
 const elements=new Map(),calls=[],tid='a'.repeat(32),self={peerId:'owner',username:'Owner',role:'owner'};
 const names=['Alice','Bob','Charlie'],members=Array.from({length:125},(_,i)=>({peerId:'p'+i,username:names[i%3]+i,role:'peer'}));
 const team={id:tid,name:'Development',role:'owner',me:self};let removed=false;
 const api=async(route,method='GET',body)=>{
  calls.push({route,method,body});const u=new URL(route,'https://fixture.invalid'),cursor=u.searchParams.get('cursor'),start=Number(cursor||0);
  const paged=(key,rows)=>({[key]:rows.slice(start,start+50),cursor:String(start+Math.min(50,rows.length-start)),nextCursor:start+50<rows.length?String(start+50):null});
  if(u.pathname==='/v1/receivers/me/dev-profile')return{profile:{username:'Owner'}};
  if(u.pathname==='/v1/receivers/me/dev-teams')return paged('teams',Array.from({length:121},(_,i)=>({...team,id:i===0?tid:i.toString(16).padStart(32,'0'),name:'Team '+i})));
  if(u.pathname.endsWith('/members')&&method==='GET')return paged('members',members.filter(m=>!removed||m.peerId!=='p0'));
  if(u.pathname.endsWith('/members/p0')&&method==='DELETE'){removed=true;return{removed:true};}
  if(u.pathname.endsWith('/invites')&&method==='GET')return paged('invites',[{id:'b'.repeat(32),expiresAtMs:Date.now()+100000,revoked:false,consumed:false}]);
  if(u.pathname.includes('/invites/')&&method==='DELETE')return{revoked:true};
  if(u.pathname.endsWith('/membership')&&method==='DELETE')return{left:true};
  if(u.pathname.endsWith('/messages'))return{messages:[{id:'msg',username:'<svg onload=alert(1)>',text:'<script>private()</script>'}],cursor:'1'};
  if(u.pathname.endsWith('/signals'))return{signals:[],cursor:'1'};
  if(u.pathname.endsWith('/presence'))return{expiresAtMs:Date.now()+45000};
  if(u.pathname==='/v1/receivers/teams/'+tid)return{team,self};
  throw new Error('Unexpected fixture route: '+method+' '+route);
 };
 const el=id=>{if(!elements.has(id))elements.set(id,new Element(id==='recipient'?'select':'div'));return elements.get(id)};
 class Peer{constructor(){this.closed=[];}async revalidate(){}shutdown(){}close(id){this.closed.push(id)}async handleSignal(){}}
 const window={gdNative:{request:api},confirm:()=>true,dispatchEvent(){},addEventListener(){}};
 const context={window,document:{getElementById:el,createElement:t=>new Element(t)},crypto:globalThis.crypto,Option:function(text,value){return{textContent:text,value}},GDDevPeer:{Session:Peer},setInterval(){},Event:class{},URL,Date,console};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../teams-ui.js'),'utf8'),context);
 return{el,calls,configure:()=>window.GenDragoonTeams.configure({workspaceId:'f'.repeat(32),workspaceName:'Fixture'}),open:async()=>el('teams').children[0].children[1].onclick()};
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
