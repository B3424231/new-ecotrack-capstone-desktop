'use strict';
// Exercise actual report-table rows, filters/search, and shared notification equipment metadata without a live account.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=process.env.ECOTRACK_DESKTOP_OVERLAY||path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8').replace(/\r\n/g,'\n');
const section=(file,start,end)=>{const source=read(file),a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert(a>=0&&b>a,start);return source.slice(a,b)};
const hardware='esp32s3-001122334455';
const first={id:'AC-'+hardware,assetTag:'AC-'+hardware,airconId:'ac-one',airconName:'Matrix',airconType:'Split Type (Inverter)',nodeId:'node-one',nodeName:'Old controller',building:'IC Building',floor:'Floor 1',room:'Room 1'};
const second={id:'AC-other',assetTag:'AC-other',airconId:'ac-two',airconName:'Matrix',airconType:'Window',nodeId:'node-two',nodeName:'Other controller',building:'Other Building',floor:'Floor 2',room:'Room 2'};
const profiles=[{aircon_id:'ac-one',device_id:first.id,name:'Matrix',controller_node_id:first.nodeId,aircon_type:'Split Type (Inverter)',brand:'TCL',protocol_name:'TCL112AC'},
  {aircon_id:'ac-two',device_id:second.id,name:'Matrix',controller_node_id:second.nodeId,aircon_type:'Window',protocol_name:'DAIKIN64'}];
const report={id:'MR-LEGACY',aircon_id:'node-one',airconId:first.id,aircon_name:first.id,airconType:'TCL - Split Type (Inverter)',room:'Room 1',staffName:'Fixture Technician',status:'Pending',type:'Control Inspection',tasks:[]};
const reports=[report];let name='Ac Controller 1';
const table={innerHTML:''};
const dropdown={value:'all',options:[],replaceChildren(...options){this.options=options}};
const context=vm.createContext({window:{EcoTrackAirconSystem:{NodeService:{getNode:id=>id==='node-one'?{name}:id==='node-two'?{name:'Other controller'}:null},AirconProfileManager:{getAll:()=>profiles}}},
  getAirconsDatabase:()=>[first,second],localStorage:{getItem:()=>null},document:{getElementById:id=>id==='pageReportTableBody'?table:null},
  Option:class{constructor(text,value){this.text=text;this.value=value}},airconFilter:dropdown,staffFilter:null,
  pageStatus:'all',pagePriority:'all',pageAircon:'all',pageStaff:'all',pageSearch:'',pageReportCurrentPage:1,PAGE_REPORT_PER_PAGE:20,
  selectedReportIds:new Set(),isReportSelectMode:false,getEffectiveReportStatus:r=>r.status,updateBulkSelectControls(){}});
vm.runInContext(section('public/js/maintenance-modal.js','  function maintenanceDisplayText(','  function maintenanceStateClasses('),context);
context.window.EcoTrackMaintenance={resolveReportEquipment:context.maintenanceReportEquipment,getReports:()=>reports,getAircons:()=>[first,second]};
vm.runInContext(section('public/staff.html','      function reportEquipmentDisplay(','      window.updateReportFilters ='),context);
vm.runInContext(section('public/staff.html','      function getFilteredReports()','      // Update Select All Buttons'),context);
vm.runInContext(section('public/staff.html','      function renderPageReports()','      async function deleteReportPrompt('),context);
context.renderPageReports();
assert(table.innerHTML.includes('Ac Controller 1'));assert(table.innerHTML.includes('Aircon: Matrix'));
assert(table.innerHTML.includes('Split Type (Inverter)'));assert(!table.innerHTML.includes('TCL - Split'));
assert(!table.innerHTML.includes(first.id));assert(table.innerHTML.includes('IC Building • Floor 1 • Room 1'));
assert(dropdown.options.some(option=>option.value===first.id&&option.text==='Ac Controller 1'),'Filter routing IDs stay unchanged while labels use the controller name');
assert.equal(report.airconId,first.id);assert.equal(report.aircon_id,'node-one');assert.equal(profiles[0].protocol_name,'TCL112AC');
for(const search of ['Ac Controller 1','Matrix','Split Type','IC Building']){context.pageSearch=search;assert.equal(context.getFilteredReports().length,1,`Search resolves ${search}`)}context.pageSearch='';
name='Office <AC>';context.renderPageReports();assert(table.innerHTML.includes('Office &lt;AC&gt;'));assert(!table.innerHTML.includes('Office <AC>'));
assert.equal(context.maintenanceReportEquipment({aircon_id:'ac-one'}).controllerName,'Office <AC>','AC IDs and historical node FK references both resolve current controller names');
assert.equal(context.maintenanceReportEquipment({aircon_name:'Matrix'}).controllerName,'Controller unavailable','Duplicate custom names cannot select the first unrelated unit');
assert.equal(context.maintenanceReportEquipment({aircon_id:'deleted-node',aircon_name:'Matrix'}).controllerName,'Controller unavailable','A missing stable reference cannot redirect to a matching name');
assert.equal(context.maintenanceReportEquipment({airconType:'TCL - Split Type (Inverter)'}).airconType,'Split Type (Inverter)','Legacy report-only type labels omit their old manufacturer/protocol prefix');
reports.splice(0,1,{...report,aircon_id:'deleted-node',airconId:'Matrix',aircon_name:'Matrix'});context.renderPageReports();assert(table.innerHTML.includes('Controller unavailable'));assert(!table.innerHTML.includes('Other controller'));

context.rooms={r1:{name:'Room 1',nodes:[{id:'Repeated name',name:'Repeated name',pb_id:'node-one',aircon_type:'TCL - Split Type (Inverter)'}]},r2:{name:'Room 2',nodes:[{id:'Repeated name',name:'Repeated name',pb_id:'node-two',aircon_type:'Window'}]}};context.floors={};context.buildings={};
vm.runInContext(section('public/js/notifications.js','function notificationLocation(','async function setupNotificationsPage('),context);
assert.equal(context.notificationAirconType(context.rooms.r1.nodes[0]),'Split Type (Inverter)');
assert.equal(context.extractTargetNodes('Maintenance notification',null,'node-one').nodeNames[0],'Office <AC>');
assert.equal(context.extractTargetNodes('Maintenance notification',null,'Repeated name').nodeNames[0],'Controller unavailable','Repeated controller names cannot reroute notifications');
console.log('PASS: actual maintenance table/controller filter/search, separate custom AC/type, legacy node references, rename escaping, duplicate/unmatched resolution, notification type/name mapping, and unchanged IDs/protocols.');

assert.equal(context.notificationRoomId('', 'node-one'), 'r1');
assert.equal(context.notificationRoomId('', 'Repeated name'), '', 'Ambiguous controller names cannot invent a room');
assert.equal(context.notificationRoomId('', 'missing-node'), '', 'Missing equipment cannot be assigned the first loaded room');
assert.equal(context.notificationRoomId('r2', null), 'r2', 'Room-wide notifications preserve their explicit location');
console.log('PASS: notification location resolution rejects unknown/ambiguous targets and preserves explicit room-wide events.');
