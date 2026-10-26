'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Session,packet,decode,LABEL}=require('../dev-peer.js');
class RTC {
 constructor(){this.connectionState='new';this.remoteDescription=null;this.candidates=[];this.channels=[];}
 createDataChannel(label){const c={label,readyState:'open',bufferedAmount:0,sent:[],send(v){this.sent.push(v)},close(){this.readyState='closed'}};this.channels.push(c);return c;}
 async createOffer(){return{type:'offer',sdp:'fixture-offer'}}
 async createAnswer(){return{type:'answer',sdp:'fixture-answer'}}
 async setLocalDescription(d){this.localDescription=d}
 async setRemoteDescription(d){this.remoteDescription=d}
 async addIceCandidate(c){this.candidates.push(c)}
 close(){this.connectionState='closed'}
}
function fixture(id='a'){
 const signals=[],messages=[],states=[],connections=[];let member=true;
 const session=new Session({peerId:id,authorizePeer:async peerId=>member?{peerId,username:'verified-user'}:null,sendSignal:async s=>signals.push(s),
   onMessage:m=>messages.push(m),onState:(...s)=>states.push(s),rtcFactory:()=>{const p=new RTC();connections.push(p);return p;}});
 return{session,signals,messages,states,connections,revoke:()=>{member=false}};
}
test('peer protocol rejects binary, attachments, arbitrary actions and oversized text',()=>{
 const p=packet('hello');assert.equal(decode(JSON.stringify(p)).text,'hello');
 for(const value of [new Uint8Array([1]),'x'.repeat(9000),JSON.stringify({...p,file:'private.zip'}),JSON.stringify({...p,type:'run-command'}),JSON.stringify({...p,username:'owner'})])assert.throws(()=>decode(value));
 assert.throws(()=>packet('x'.repeat(4001)));assert.throws(()=>packet(' '));
});
test('direct channel uses authenticated membership, ordered text and bounded backpressure',async()=>{
 const f=fixture();await f.session.connect('b');const e=f.session.peers.get('b');assert.equal(e.channel.label,LABEL);assert.equal(f.signals[0].kind,'offer');
 await f.session.send('b','dev chat');assert.equal(decode(e.channel.sent[0]).text,'dev chat');
 e.channel.bufferedAmount=65537;await assert.rejects(f.session.send('b','wait'),/busy/);
 f.revoke();await assert.rejects(f.session.send('b','denied'),/authorized/);await f.session.revalidate();assert.equal(f.session.peers.size,0);
});
test('ICE before offer is bounded, then flushed; answer uses the same connection identity',async()=>{
 const f=fixture('b'),connectionId='a'.repeat(32),s={from:'a',connectionId};
 await f.session.handleSignal({...s,kind:'ice',payload:{candidate:'fixture'}});
 await f.session.handleSignal({...s,kind:'offer',payload:{type:'offer',sdp:'fixture'}});
 assert.equal(f.connections[0].candidates.length,1);assert.equal(f.signals.at(-1).kind,'answer');assert.equal(f.signals.at(-1).connectionId,connectionId);
 const c=f.connections[0].createDataChannel(LABEL);f.connections[0].ondatachannel({channel:c});
 const p=JSON.stringify(packet('hello'));await f.session.receive(f.session.peers.get('a'),p);await f.session.receive(f.session.peers.get('a'),p);
 assert.equal(f.messages.length,1);assert.equal(f.messages[0].username,'verified-user');
});
test('removed peers cannot create, signal or retain a live connection',async()=>{
 const f=fixture();f.revoke();await assert.rejects(f.session.connect('b'));assert.equal(f.connections.length,0);
 await assert.rejects(f.session.handleSignal({from:'b',connectionId:'b'.repeat(32),kind:'offer',payload:{type:'offer',sdp:'x'}}));
});
test('shutdown rejects late sends and asynchronous negotiation callbacks',async()=>{
 const f=fixture();await f.session.connect('b');f.session.shutdown();await assert.rejects(f.session.send('b','late'));assert.equal(f.connections[0].connectionState,'closed');
});
test('abandoned ICE negotiations expire and release a direct connection slot',async()=>{
 const session=new Session({peerId:'a',authorizePeer:async peerId=>({peerId,username:'peer'}),sendSignal:async()=>{},rtcFactory:()=>new RTC(),maxConnections:1,negotiationTimeout:15});
 await session.handleSignal({from:'b',connectionId:'b'.repeat(32),kind:'ice',payload:{candidate:null}});
 await assert.rejects(session.handleSignal({from:'c',connectionId:'c'.repeat(32),kind:'ice',payload:{candidate:null}}),/Close a direct connection/);
 await new Promise(resolve=>setTimeout(resolve,30));assert.equal(session.peers.size,0);
 await session.handleSignal({from:'c',connectionId:'c'.repeat(32),kind:'ice',payload:{candidate:null}});session.shutdown();
});
