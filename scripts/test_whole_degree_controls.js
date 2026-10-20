'use strict';
// Production helpers, render functions and click handlers; isolated DOM/storage/dispatch only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');
const control=read('public/control.html'),dashboard=read('public/dashboard.html');
function section(source,start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert(a>=0&&b>a,start);return source.slice(a,b);}
class Element {
 constructor(id=''){this.id=id;this.dataset={};this.style={};this.children=[];this.handlers={};this.textContent='';this.disabled=false;this.innerHTML='';this.classList={add(){},remove(){},toggle(){},contains(){return false;}};}
 appendChild(child){this.children.push(child);return child;}
 replaceChildren(...children){this.children=children;}
 addEventListener(name,fn){(this.handlers[name]||=[]).push(fn);}
 getAttribute(name){return name==='data-device-id'?'fixture':name==='data-action'?this.dataset.action:null;}
 setAttribute(name,value){this[name]=value;}
 querySelector(){return null;}
 querySelectorAll(selector){return selector==='button'?this.children.filter(child=>child.tagName==='BUTTON'):[];}
 async click(){for(const fn of this.handlers.click||[])await fn({target:this,stopPropagation(){}});if(this.onclick)await this.onclick({stopPropagation(){}});}
}
function fixture(){
 const nodes=new Map(),storage=new Map(),calls=[],toasts=[];
 const get=id=>{if(!nodes.has(id))nodes.set(id,new Element(id));return nodes.get(id);};
 const buttons=[get('dashDown'),get('dashUp')];buttons[0].dataset.action='down';buttons[1].dataset.action='up';
 const presets=[0,1,2,3].map(i=>get('preset'+i)),sims=[get('simUp'),get('simDown')];sims[0].dataset.cmd='TEMP_UP';sims[1].dataset.cmd='TEMP_DOWN';
 const d={device_id:'fixture',node_id:'controller',name:'Fixture AC',protocol_name:'TCL112AC',protocol:'TCL112AC',status:'online',
  state:{power:true,temperature:21.5,mode:'cool',fan:'auto'},
  control_snapshot:{observed_remote_state:{power:true,temp:21.5,mode:'cool',fan:'auto'},observed_remote_at:'2026-10-18T06:00:00Z'}};
 const context=vm.createContext({console:{log(){},warn(){},error(){}},Date,performance,localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,v)=>storage.set(key,v)},
  setTimeout(){},clearTimeout(){},setInterval(){},clearInterval(){},alert:message=>toasts.push(message),
  document:{getElementById:get,createElement:tag=>Object.assign(new Element(),{tagName:tag.toUpperCase()}),querySelector:()=>null,
   querySelectorAll:selector=>selector==='.rem-preset-btn'?presets:selector==='.sim-btn'?sims:[]}});
 context.window=context;
 vm.runInContext(read('public/js/aircon-system.js'),context);
 vm.runInContext(read('public/js/aircon-state.js'),context);
 const engine=context.EcoTrackAirconSystem;
 Object.assign(context,{CapabilityEngine:engine.CapabilityEngine,activeDeviceId:'fixture',profile:d,
  AirconProfileManager:{getById:()=>d,getAll:()=>[d]},NodeService:{getNode:()=>({status:'online',capabilities:{ir_transmitter:true,ir_receiver:true}}),isNodeOnline:()=>true},
  CommandManager:{dispatch:async request=>{calls.push(structuredClone(request));return {success:!context.fail,message:'Fixture dispatch'};}},
  getControllerDisplayName:()=> 'Fixture controller',getControllerLabel:()=> 'Fixture controller',getAirconDisplayName:()=> 'Fixture AC',
  openCommandErrorModal(){},renderDeviceDropdown(){},commandStatusText:get('commandStatusText'),commandLatencyText:get('commandLatencyText')});
 context.EcoToast={show:message=>toasts.push(message)};
 for(const m of control.matchAll(/const (\w+) = document\.getElementById\('([^']+)'\);/g))if(!context[m[1]])context[m[1]]=get(m[2]);
 const card=get('ac-card-fixture');card.querySelector=selector=>selector==='.target-temp-val'?get('dashValue'):null;
 card.querySelectorAll=selector=>selector==='.temp-step-btn'?buttons:[];
 const container={querySelectorAll:selector=>selector==='.temp-step-btn'?buttons:[]};
 vm.runInContext(section(dashboard,'      function updateSingleCardDom(', '      function wireCardListeners('),context);
 vm.runInContext(section(dashboard,'      function wireCardListeners(', '      function getDashboardPowerState('),context);
 vm.runInContext(section(control,'      function renderControlPanel(', '      // Pending command tracking'),context);
 vm.runInContext(section(control,'      function enforceControllerCapabilities(', '      // ===== COMMAND ERROR'),context);
 vm.runInContext(section(control,'      // Temperature Clickers', '      // Workspace Tabs logic'),context);
 vm.runInContext(section(control,'      // Remote simulation tactile buttons', '      // Parse initial tab'),context);
 context.wireCardListeners(container);
 return {context,C:engine.CapabilityEngine,registry:engine.AcCapabilityRegistry,d,get,buttons,presets,sims,calls,toasts,card};
}
const tests={};
tests['half-degree starts snap in the selected direction; whole targets advance by one']=async()=>{
 const {C,d}=fixture();for(const [start,up,down]of[[21.5,22,21],[21,22,20],[16.5,17,16],[30.5,31,30]]){
  assert.equal(C.nextControlTemperature(d,start,1),up);assert.equal(C.nextControlTemperature(d,start,-1),down);
 }
};
tests['bounds, unknown settings and unsupported modes cannot create targets']=async()=>{
 const {C,d}=fixture();assert.equal(C.nextControlTemperature(d,31,1),null);assert.equal(C.nextControlTemperature(d,16,-1),null);
 for(const v of [null,undefined,'',' ',true,[],{},NaN,Infinity])assert.equal(C.nextControlTemperature(d,v,1),null);
 assert.equal(C.nextControlTemperature({...d,state:{...d.state,mode:'fan'}},21.5,1),null);
 assert.equal(C.nextControlTemperature({...d,protocol_name:'UNKNOWN',protocol:'UNKNOWN'},21.5,1),null);
};
tests['app validation rejects fractional targets without changing native protocol support']=async()=>{
 const {C,d,registry}=fixture(),before=JSON.stringify(d);
 assert.equal(C.validateControlTemperature(d,21.5),false);assert.equal(C.validateControlTemperature(d,22),true);
 assert.equal(C.validateControlTemperature(d,'22'),false);assert.equal(registry.validateTemperature(d,21.5).valid,true);
 assert.equal(C.getCapabilities(d).temperature_step,0.5);assert.equal(JSON.stringify(d),before);
};
tests['formatting preserves actual fractions and removes unnecessary decimal zeros']=async()=>{
 const {C}=fixture();for(const [v,want]of[[21,'21'],['21.0','21'],[21.5,'21.5'],[null,'—'],['','—'],[false,'—']])assert.equal(C.formatTemperature(v),want);
 assert.equal(C.formatTemperature(21.5,'°C'),'21.5°C');
};
tests['both main control clickers dispatch whole targets from a received fraction']=async()=>{
 const f=fixture();await f.get('tempPlusBtn').click();assert.equal(f.calls.at(-1).value,22);
 await f.get('tempMinusBtn').click();assert.equal(f.calls.at(-1).value,21);
 assert.equal(f.d.control_snapshot.observed_remote_state.temp,21.5);
};
tests['IR workspace simulation temperature buttons use whole targets']=async()=>{
 const f=fixture();
 for(const [button,want]of[[f.sims[0],22],[f.sims[1],21]]){await button.click();assert.equal(f.calls.at(-1).value,want);}
};
tests['fractional explicit app requests fail before any dispatch']=async()=>{
 const f=fixture();await f.context.executeCommand('TEMP',21.5);assert.equal(f.calls.length,0);assert.match(f.toasts[0],/whole-degree/);
 await f.context.executeCommand('TEMP',22);assert.equal(f.calls.length,1);
};
tests['control rendering preserves the received value and respects boundaries']=async()=>{
 const f=fixture(),before=JSON.stringify(f.d.control_snapshot);f.context.renderControlPanel();
 assert.equal(f.get('tempValueDisplay').textContent,'21.5');
 assert.equal(f.get('liveSetpointReadout').textContent,'21.5°C');assert.match(f.get('tempRangeHelp').textContent,/Step: 1°C/);
 assert.equal(JSON.stringify(f.d.control_snapshot),before);
 f.d.state.temperature=31;f.context.renderControlPanel();assert.equal(f.get('tempPlusBtn').disabled,true);
};
tests['dashboard click, refresh and failed dispatch do not round or lose received fractions']=async()=>{
 const f=fixture();f.context.updateSingleCardDom(f.card,f.d,{status:'online'});assert.equal(f.get('dashValue').textContent,'21.5');
 await f.buttons[1].click();assert.equal(f.calls.at(-1).value,22);assert.equal(f.get('dashValue').textContent,'22');
 f.context.updateSingleCardDom(f.card,f.d,{status:'online'});assert.equal(f.get('dashValue').textContent,'22');
 f.d.state.temperature=21.5;f.context.fail=true;await f.buttons[0].click();assert.equal(f.calls.at(-1).value,21);
 assert.equal(f.d.state.temperature,21.5);assert.equal(f.get('dashValue').textContent,21.5);
 assert.equal(f.d.control_snapshot.observed_remote_state.temp,21.5);
};
tests['dashboard blocks limits, missing targets and powered-off controls']=async()=>{
 const f=fixture();f.d.state.temperature=31;await f.buttons[1].click();assert.equal(f.calls.length,0);
 f.context.updateSingleCardDom(f.card,f.d,{status:'online'});assert.equal(f.buttons[1].disabled,true);
 f.d.state.temperature=null;await f.buttons[0].click();assert.equal(f.calls.length,0);
 f.d.state.temperature=21.5;f.d.state.power=false;await f.buttons[0].click();assert.equal(f.calls.length,0);
};
tests['retired remote view and selector extras are absent from production markup']=async()=>{
 for(const id of ['viewStandardBtn','viewRemoteBtn','remoteLayoutContainer','prevAirconBtn','nextAirconBtn','quickStatusPill'])assert(!control.includes('id="'+id+'"'));
};
(async()=>{let failures=0;for(const [name,test]of Object.entries(tests)){try{await test();console.log('PASS '+name);}catch(error){failures++;console.error('FAIL '+name+'\n'+error.stack);}}assert.equal(failures,0);console.log(`PASS ${Object.keys(tests).length} whole-degree control scenarios; no live commands or writes.`);})().catch(error=>{console.error(error);process.exitCode=1;});
