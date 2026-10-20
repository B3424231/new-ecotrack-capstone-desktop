'use strict';
// Isolated metadata/capture regressions. No real database or hardware calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.ECOTRACK_DESKTOP_OVERLAY || path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
function section(file, start, end) {
  const text=read(file),a=text.indexOf(start),b=text.indexOf(end,a+start.length);
  assert(a>=0&&b>a,`Missing source section ${start}`);
  return text.slice(a,b);
}

function captures() {
  const data=new Map();
  const localStorage={getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,String(value)),removeItem:key=>data.delete(key)};
  const context=vm.createContext({window:{localStorage},localStorage,console,setTimeout,clearTimeout});
  vm.runInContext(read('public/js/aircon-system.js'),context);
  const adapter=context.window.EcoTrackAirconSystem.ProtocolAdapter;
  for(const protocol of ['TCL112AC','DAIKIN64','DAIKIN2','PANASONIC_AC','COOLIX']){
    const frame=adapter.decodeRemoteCapture({protocol,raw_count:227,sequence:51,state:{temp:24}});
    assert.equal(frame.success,true);assert.equal(frame.protocol,protocol);assert.equal(frame.brand,null);
    assert.equal(frame.ambiguous,true);assert.equal(frame.sequence,51);assert.equal(frame.state.temp,24);
  }
  assert.equal(adapter.decodeRemoteCapture({protocol:'TCL112AC',raw_count:0}).success,false);
}

async function editNames() {
  const elements=new Map();
  const get=id=>{if(!elements.has(id))elements.set(id,{value:'',disabled:false,innerHTML:'Save',reportValidity:()=>true});return elements.get(id)};
  const writes=[];let resets=0;
  const profile={node_id:'esp32s3-001122334455',controller_node_id:'db-node',name:'Matrix',brand:'Physical maker',protocol_name:'TCL112AC'};
  const context=vm.createContext({document:{getElementById:get},window:{EcoTrackControllerLocations:{resolve:async()=>({room_id:'r1'})}},
    NodeService:{getNode:()=>({db_id:'db-node',node_id:profile.node_id,name:'Old controller',protocol_name:'DAIKIN2'}),editDevice:async(id,payload)=>writes.push({id,payload})},
    AirconProfileManager:{getAll:()=>[profile]},remoteCapture:{edit:{busy:false,protocol:null,brand:null}},
    editForm:{reportValidity:()=>true},saveEditBtn:get('saveEditNodeBtn'),editSaving:false,
    _cachedBuildings:[],_cachedFloors:[],_cachedRooms:[],closeEditNodeModal(){},renderNodes(){},resetRemoteDetection(){resets++}});
  get('editNodeIdHidden').value=profile.node_id;get('editNodeName').value='Renamed controller';
  get('editAirconName').value='Matrix';get('editNodeBrand').value='Confirmed physical maker';get('editNodeAirconType').value='Split Type (Inverter)';
  vm.runInContext(section('public/nodes.html','      function selectManualBrand(', '      async function listenForRemote(')+
    section('public/nodes.html','      async function handleSaveEditNode()', '      if (saveEditBtn) saveEditBtn.addEventListener'),context);
  await context.handleSaveEditNode();
  assert.equal(writes[0].id,profile.node_id);assert.equal(writes[0].payload.name,'Renamed controller');
  assert.equal(writes[0].payload.aircon_name,'Matrix');assert.equal(writes[0].payload.brand,'Confirmed physical maker');
  assert.equal(writes[0].payload.protocol_name,'TCL112AC','Metadata edits preserve the linked AC exact protocol rather than a stale node protocol');
  context.remoteCapture.edit.protocol='DAIKIN64';context.selectManualBrand('edit','Another manufacturer');
  assert.equal(context.remoteCapture.edit.protocol,'DAIKIN64');assert.equal(resets,0);
  await context.handleSaveEditNode();assert.equal(writes[1].payload.protocol_name,'DAIKIN64','Only an explicit new capture changes the exact configured protocol');
}

function maintenance() {
  let savedName='Current controller';
  const actual={id:'AC-esp32s3-001122334455',airconId:'db-ac',airconName:'Matrix',airconType:'Split Type (Inverter)',
    nodeId:'db-node',nodeName:'Stale controller',assetTag:'AC-esp32s3-001122334455',building:'IC Building',floor:'Floor 1',room:'Room 1',protocolName:'TCL112AC'};
  const profiles=[{aircon_id:'db-ac',device_id:actual.assetTag,name:'Matrix',brand:'TCL',aircon_type:'Split Type (Inverter)',protocol_name:'TCL112AC'}];
  const context=vm.createContext({window:{EcoTrackAirconSystem:{NodeService:{getNode:()=>({name:savedName})},AirconProfileManager:{getAll:()=>profiles}}},
    getAirconsDatabase:()=>[{id:'unrelated',airconId:'unrelated-ac',airconName:'Other AC'},actual]});
  vm.runInContext(section('public/js/maintenance-modal.js','  function maintenanceDisplayText(', '  function maintenanceStateClasses('),context);
  const report={aircon_id:'db-ac',aircon_name:actual.assetTag,room:'Room 1',aircon_type:'TCL - Split Type (Inverter)'};
  let equipment=context.maintenanceReportEquipment(report);
  assert.equal(equipment.controllerName,'Current controller');assert.equal(equipment.airconName,'Matrix');
  assert.equal(equipment.airconType,'Split Type (Inverter)');assert.equal(equipment.protocol,'TCL112AC');
  assert.equal(equipment.location,'IC Building • Floor 1 • Room 1');
  savedName='Renamed controller';assert.equal(context.maintenanceReportEquipment(report).controllerName,'Renamed controller','A rename refreshes the report display without changing saved report identities');
  profiles[0].device_id='Matrix';actual.assetTag='Matrix';
  assert.equal(context.maintenanceReportEquipment(report).airconName,'Matrix','An explicit human name remains valid when registration uses it as the asset tag');
  profiles[0].device_id=actual.id;actual.assetTag=actual.id;
  assert.equal(context.findMaintenanceAircon({aircon_id:'missing-ac'}),null,'An unmatched report never borrows the first unrelated AC');
  assert.equal(context.maintenanceReportEquipment({aircon_id:'missing-ac'}).controllerName,'Controller unavailable');
  profiles[0].name=actual.assetTag;actual.airconName=actual.assetTag;
  assert.equal(context.maintenanceReportEquipment(report).airconName,'Aircon name unavailable','A generated hardware identifier is never presented as the custom name');
  profiles[0].name='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  assert.equal(context.maintenanceReportEquipment(report).airconName,'Aircon name unavailable','A database UUID is not a custom name');
  assert.equal(context.maintenanceDisplayText('Office <AC>'),'Office &lt;AC&gt;');
}

function notifications() {
  const controller={id:'Old controller',pb_id:'db-node',name:'Current controller',node_id:'esp32s3-001122334455'};
  const room={id:'r1',name:'Room 1',floor_id:'f1',nodes:[controller]};
  const context=vm.createContext({window:{},rooms:{r1:room},floors:{f1:{name:'Floor 1',building_id:'b1'}},buildings:{b1:{name:'IC Building'}}});
  vm.runInContext(section('public/js/notifications.js','function notificationLocation(', 'async function setupNotificationsPage('),context);
  assert.equal(context.notificationLocation(room),'IC Building • Floor 1 • Room 1');
  for(const identifier of ['db-node','esp32s3-001122334455']){
    const target=context.extractTargetNodes('Inspection notification',null,identifier);
    assert.equal(target.nodeNames[0],'Current controller','An explicit database or hardware ID resolves the saved name across rooms');
    assert.equal(target.specificNodeId,identifier,'Notification command/routing IDs remain unchanged');
  }
  assert.equal(context.extractTargetNodes('Inspection',room,'unknown-id').nodeNames[0],'Controller unavailable');
}

(async()=>{captures();await editNames();maintenance();notifications();console.log('PASS: exact IR protocols, independent names, current controller display, full location, and unknown-target handling.');})().catch(error=>{console.error(error);process.exitCode=1});
