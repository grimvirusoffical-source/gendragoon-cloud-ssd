'use strict';
(()=>{
 // This page receives metadata RPC only; no file-selection command is exposed.
 window.gdNative={request:(path,method='GET',body)=>window.GDCompanion.call('request',{path,method,...(body===undefined?{}:{body})})};
 addEventListener('gd-teams-ready',async()=>{const query=new URLSearchParams(location.search),workspaceId=query.get('workspaceId')||'',workspaceName=query.get('workspaceName')||'';try{const status=await window.GDCompanion.call('status');if(!status.connected)throw new Error('Connect your Red-XAI account in GenDragoon first.');await window.GenDragoonTeams.configure({workspaceId:/^[a-f0-9]{32}$/.test(workspaceId)?workspaceId:'',workspaceName:workspaceName.slice(0,80)});}catch(error){const status=document.getElementById('status');status.textContent=error.message;status.classList.add('error');}});
})();
