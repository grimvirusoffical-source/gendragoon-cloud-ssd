'use strict';
(function(root){
  const LABEL='gendragoon-dev-chat-v1', HEX=/^[a-f0-9]{32}$/;
  const uuid=()=>crypto.randomUUID().replaceAll('-','');
  function packet(text,id=uuid()){
    if(typeof text!=='string'||!text.trim()||text.length>4000||!HEX.test(id))throw new Error('Chat messages must contain 1–4000 characters.');
    return {type:'chat',id,text,sentAt:Date.now()};
  }
  function decode(value){
    if(typeof value!=='string'||value.length>8192)throw new Error('Only small text chat messages are supported.');
    const p=JSON.parse(value);
    if(!p||Object.keys(p).some(k=>!['type','id','text','sentAt'].includes(k))||p.type!=='chat'||!HEX.test(p.id||'')||
      typeof p.text!=='string'||!p.text.trim()||p.text.length>4000||!Number.isSafeInteger(p.sentAt))throw new Error('Unsupported peer message.');
    return p;
  }
  class Session {
    constructor({peerId,authorizePeer,sendSignal,onMessage=()=>{},onState=()=>{},rtcFactory,iceServers=[],maxConnections=8,negotiationTimeout=30000}){
      if(typeof peerId!=='string'||!peerId||typeof authorizePeer!=='function'||typeof sendSignal!=='function')throw new Error('Authenticated peer configuration is required.');
      this.peerId=peerId;this.authorizePeer=authorizePeer;this.sendSignal=sendSignal;this.onMessage=onMessage;this.onState=onState;
      this.rtcFactory=rtcFactory||(()=>new RTCPeerConnection({iceServers}));this.maxConnections=Math.max(1,Math.min(16,maxConnections));
      this.peers=new Map();this.closed=false;
      this.negotiationTimeout=Math.max(10,Math.min(60000,negotiationTimeout));
    }
    async authorized(peerId){
      if(this.closed||typeof peerId!=='string'||peerId===this.peerId)throw new Error('Peer session is unavailable.');
      const member=await this.authorizePeer(peerId);
      if(!member||member.peerId!==peerId||typeof member.username!=='string'||!member.username||this.closed)throw new Error('This person is no longer an authorized team peer.');
      return member;
    }
    current(entry){return !this.closed&&this.peers.get(entry.peerId)===entry;}
    make(peerId,connectionId){
      if(!HEX.test(connectionId))throw new Error('Invalid connection identity.');
      if(this.peers.size>=this.maxConnections)throw new Error('Close a direct connection before opening another. Team membership and group chat remain available.');
      const pc=this.rtcFactory(),entry={peerId,connectionId,pc,channel:null,pending:[],sent:new Set(),received:new Set()};
      this.peers.set(peerId,entry);
      entry.timer=setTimeout(()=>{if(this.current(entry)&&entry.channel?.readyState!=='open'){this.onState(peerId,'connection-timed-out');this.close(peerId);}},this.negotiationTimeout);
      entry.timer.unref?.();
      pc.onicecandidate=e=>{if(this.current(entry))this.signal(entry,'ice',e.candidate?.candidate?e.candidate.toJSON():{candidate:null,sdpMid:null,sdpMLineIndex:null}).catch(()=>this.close(peerId));};
      pc.ondatachannel=e=>this.attach(entry,e.channel);
      pc.onconnectionstatechange=()=>{
        if(!this.current(entry))return;
        this.onState(peerId,pc.connectionState);
        if(['failed','closed'].includes(pc.connectionState))this.close(peerId);
      };
      return entry;
    }
    attach(entry,channel){
      if(!this.current(entry)||channel.label!==LABEL||entry.channel){channel.close();return;}
      entry.channel=channel;
      channel.onopen=()=>{if(this.current(entry)){clearTimeout(entry.timer);this.onState(entry.peerId,'direct-connected');}};
      channel.onclose=()=>{if(this.current(entry))this.close(entry.peerId);};
      channel.onerror=()=>{if(this.current(entry))this.close(entry.peerId);};
      channel.onmessage=e=>this.receive(entry,e.data).catch(()=>this.close(entry.peerId));
    }
    async signal(entry,kind,payload){
      await this.authorized(entry.peerId);if(!this.current(entry))return;
      await this.sendSignal({signalId:uuid(),to:entry.peerId,connectionId:entry.connectionId,kind,payload});
    }
    async connect(peerId){
      await this.authorized(peerId);
      if(this.peers.has(peerId))return;
      const entry=this.make(peerId,uuid());
      try{
        this.attach(entry,entry.pc.createDataChannel(LABEL,{ordered:true}));
        await entry.pc.setLocalDescription(await entry.pc.createOffer());
        await this.signal(entry,'offer',{type:'offer',sdp:entry.pc.localDescription.sdp});
      }catch(e){this.close(peerId);throw e;}
    }
    async handleSignal(s){
      if(!s||!HEX.test(s.connectionId||'')||!['offer','answer','ice'].includes(s.kind))throw new Error('Invalid peer signal.');
      await this.authorized(s.from);
      let entry=this.peers.get(s.from);
      if(entry&&entry.connectionId!==s.connectionId){
        if(s.kind!=='offer'||this.peerId<s.from)return; // deterministic glare resolution
        this.close(s.from);entry=null;
      }
      if(!entry){if(s.kind==='answer')return;entry=this.make(s.from,s.connectionId);}
      if(!this.current(entry))return;
      try{
        if(s.kind==='ice'){
          const candidate=s.payload?.candidate===null?null:s.payload;
          if(entry.pc.remoteDescription)await entry.pc.addIceCandidate(candidate);
          else {if(entry.pending.length>=64)throw new Error('Too many pending ICE candidates.');entry.pending.push(candidate);}
          return;
        }
        if(!s.payload||typeof s.payload.sdp!=='string'||s.payload.sdp.length>8000||s.payload.type!==s.kind)throw new Error('Invalid peer description.');
        await entry.pc.setRemoteDescription(s.payload);
        for(const candidate of entry.pending.splice(0))await entry.pc.addIceCandidate(candidate);
        if(s.kind==='offer'){
          await entry.pc.setLocalDescription(await entry.pc.createAnswer());
          await this.signal(entry,'answer',{type:'answer',sdp:entry.pc.localDescription.sdp});
        }
      }catch(e){this.close(s.from);throw e;}
    }
    async send(peerId,text){
      await this.authorized(peerId);
      const entry=this.peers.get(peerId),channel=entry?.channel;
      if(!entry||!this.current(entry)||channel?.readyState!=='open')throw new Error('This direct connection is not open.');
      if(channel.bufferedAmount>64*1024)throw new Error('The peer connection is busy. Wait before sending another message.');
      const value=packet(text);channel.send(JSON.stringify(value));return value;
    }
    async receive(entry,value){
      const p=decode(value),member=await this.authorized(entry.peerId);
      if(!this.current(entry)||entry.received.has(p.id))return;
      entry.received.add(p.id);if(entry.received.size>1000)entry.received.delete(entry.received.values().next().value);
      this.onMessage({...p,peerId:member.peerId,username:member.username,transport:'webrtc-direct'});
    }
    async revalidate(){
      await Promise.all([...this.peers.keys()].map(async peerId=>{try{await this.authorized(peerId);}catch{this.close(peerId);}}));
    }
    close(peerId){
      const e=this.peers.get(peerId);if(!e)return;this.peers.delete(peerId);
      clearTimeout(e.timer);
      e.channel?.close();e.pc.close();this.onState(peerId,'closed');
    }
    shutdown(){this.closed=true;for(const id of [...this.peers.keys()])this.close(id);}
  }
  const api={Session,packet,decode,LABEL};root.GDDevPeer=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
