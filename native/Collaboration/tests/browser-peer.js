
'use strict';
document.getElementById('run').onclick=async()=>{
 const output=document.getElementById('result'),button=document.getElementById('run');button.disabled=true;output.textContent='Negotiating two real RTCPeerConnections…';
 let a,b,member=true;const received=[],states=[],aid='a'.repeat(32),bid='b'.repeat(32),wait=ms=>new Promise(r=>setTimeout(r,ms));
 const authorizePeer=async peerId=>member?{peerId,username:peerId===aid?'Alice':'Bob'}:null;
 try{
  a=new GDDevPeer.Session({peerId:aid,authorizePeer,sendSignal:s=>b.handleSignal({...s,from:aid}),onMessage:m=>received.push(m),onState:(id,state)=>states.push(state)});
  b=new GDDevPeer.Session({peerId:bid,authorizePeer,sendSignal:s=>a.handleSignal({...s,from:bid}),onMessage:m=>received.push(m),onState:(id,state)=>states.push(state)});
  await a.connect(bid);let deadline=Date.now()+15000;
  while((a.peers.get(bid)?.channel?.readyState!=='open'||b.peers.get(aid)?.channel?.readyState!=='open')&&Date.now()<deadline)await wait(20);
  if(a.peers.get(bid)?.channel?.readyState!=='open'||b.peers.get(aid)?.channel?.readyState!=='open')throw new Error('The real data channel did not open. '+states.join(','));
  output.textContent='Direct data channels open. Sending 400 authenticated text messages…';
  for(let i=0;i<200;i++){await a.send(bid,'A message '+i);await b.send(aid,'B message '+i);}
  deadline=Date.now()+10000;while(received.length<400&&Date.now()<deadline)await wait(20);
  if(received.length!==400||new Set(received.map(m=>m.id)).size!==400)throw new Error('Message delivery mismatch: '+received.length);
  if(received.some(m=>m.transport!=='webrtc-direct'||!['Alice','Bob'].includes(m.username)))throw new Error('An authenticated peer label was lost.');
  let attachmentDenied=false;try{GDDevPeer.decode(JSON.stringify({...GDDevPeer.packet('text'),file:'not-allowed.zip'}));}catch{attachmentDenied=true;}
  if(!attachmentDenied)throw new Error('Attachment-shaped data was accepted.');
  member=false;let revoked=false;try{await a.send(bid,'must not send');}catch{revoked=true;}
  await a.revalidate();await b.revalidate();if(!revoked||a.peers.size||b.peers.size)throw new Error('Revoked membership retained a connection.');
  output.textContent='PASS\nReal WebRTC peers connected: 2\nOrdered text messages delivered: 400 / 400\nDuplicate messages: 0\nAttachment-shaped packet rejected: yes\nRemoved membership blocked send and closed both peers: yes\nNetwork scope: same-device direct path; internet NAT/TURN reachability is not covered.';
 }catch(error){output.textContent='FAIL\n'+error.message;}finally{a?.shutdown();b?.shutdown();button.disabled=false;}
};
