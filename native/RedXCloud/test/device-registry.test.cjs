'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const devices=require('../device-registry.cjs');
const workspace='a'.repeat(32),another='b'.repeat(32);

test('assign several devices and several workspaces without exposing credentials in lists',()=>{
  const state={};
  const first=devices.attach(state,workspace,{name:'MacBook',platform:'macos'});
  const second=devices.attach(state,workspace,{name:'iPhone',platform:'ios'});
  const other=devices.attach(state,another,{name:'MacBook',platform:'macos'});
  assert.equal(devices.visible(state,workspace).length,2);
  assert.equal(devices.visible(state,another).length,1);
  assert.ok(!JSON.stringify(devices.visible(state,workspace)).includes(first.credential));
  assert.ok(!JSON.stringify(state).includes(first.credential));
  const headers={'x-gendragoon-device-id':first.device.id,'x-gendragoon-device-token':first.credential};
  assert.doesNotThrow(()=>devices.requireDevice(state,workspace,headers));
  assert.throws(()=>devices.requireDevice(state,another,headers),{code:'device_assignment_required'});
  assert.throws(()=>devices.requireDevice(state,workspace,{'x-gendragoon-device-id':first.device.id,'x-gendragoon-device-token':other.credential}),{code:'device_assignment_required'});
  assert.doesNotThrow(()=>devices.requireDevice(state,workspace,{'x-gendragoon-device-id':second.device.id,'x-gendragoon-device-token':second.credential}));
  devices.detach(state,workspace,first.device.id);
  assert.throws(()=>devices.requireDevice(state,workspace,headers),{code:'device_assignment_required'});
});
test('reject malformed and over-limit device assignments',()=>{
  assert.throws(()=>devices.attach({},workspace,{name:'',platform:'macos'}),{code:'device_name_invalid'});
  assert.throws(()=>devices.attach({},workspace,{name:'Laptop',platform:'satellite'}),{code:'device_platform_invalid'});
  const state={};
  for(let i=0;i<devices.MAX_PER_WORKSPACE;i++)devices.attach(state,workspace,{name:'Laptop '+i,platform:'linux'});
  assert.throws(()=>devices.attach(state,workspace,{name:'Excess',platform:'linux'}),{code:'device_limit'});
});
