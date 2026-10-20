'use strict';
// Historical snapshots only; no credentials, network, or live hardware.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8'),source=read('public/js/logs.js');
const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const context=vm.createContext({window:{},Date,console:{log(){}}});
vm.runInContext(read('public/js/aircon-state.js'),context);
vm.runInContext(section('function getConfirmedAcOnState(','function getRuntimeIntervalMs('),context);
const modes=snapshot=>JSON.parse(JSON.stringify(context.getRecordedClimateModes({controlSnapshot:snapshot})));
const checks=[];
const time=n=>'2026-10-10T10:00:0'+n+'Z';
const captured={reported_state:{mode:'heat',fan:'high'},reported_at:time(1),
 observed_remote_state:{power:false,mode:'cool',fan:'quiet',turbo:true},observed_remote_at:time(2),
 desired_state:{power:true,mode:'dry',fan:'auto',turbo:false},commanded_at:time(3),command_status:'transmitted'};
assert.deepEqual(modes(captured),{mode:'COOL',fan:'QUIET · TURBO'});
checks.push('Receiver settings remain historical facts even when a newer request asks for different settings.');
assert.deepEqual(modes(JSON.stringify(captured)),modes(captured));
assert.deepEqual(modes({reported_state:{mode:'fan',fan:'low'},reported_at:time(3),observed_remote_state:{mode:'cool',fan:'high'},observed_remote_at:time(2)}),{mode:'FAN',fan:'LOW'});
checks.push('Serialized snapshots and newer reported feedback select the saved mode and fan correctly.');
assert.deepEqual(modes({reported_state:{mode:'heat',fan:'high'},reported_at:time(2),observed_remote_state:{mode:'dry',fan:'low'},observed_remote_at:time(3),
 observed_remote_field_at:{mode:time(3),fan:time(1)}}),{mode:'DRY',fan:'HIGH'});
checks.push('Partial remote frames respect per-field timestamps.');
assert.deepEqual(modes({desired_state:{mode:'heat',fan:'turbo'},configured_state:{mode:'auto',fan:'low'},command_status:'transmitted'}),{mode:'Unavailable',fan:'Unavailable'});
assert.deepEqual(modes({observed_remote_state:{mode:'fan'},observed_remote_at:time(1)}),{mode:'FAN',fan:'Unavailable'});
for(const snapshot of [null,'invalid json',{observed_remote_state:{mode:'<script>',fan:'injected'}}])
 assert.deepEqual(modes(snapshot),{mode:'Unavailable',fan:'Unavailable'});
assert.deepEqual(context.getRecordedClimateModes({control_snapshot:JSON.stringify(captured)}),context.getRecordedClimateModes({controlSnapshot:captured}));
checks.push('Requests, configured defaults, missing fields and malformed records cannot fabricate hardware readings.');
assert.equal(context.getRecordedSpecialFunctions({controlSnapshot:captured}), 'Turbo: ON');
assert.equal(context.getRecordedSpecialFunctions({controlSnapshot:{desired_state:{turbo:true}}}), 'Unavailable');
assert.equal(context.getRecordedSpecialFunctions({controlSnapshot:{observed_remote_state:{swing_vertical:true,swing_horizontal:false,eco:'on',filter:true},observed_remote_at:time(2)}}), 'Vertical Swing: ON · Horizontal Swing: OFF · Eco: ON');
assert.equal(context.getRecordedSpecialFunctions({controlSnapshot:{reported_state:{turbo:true},reported_at:time(2),observed_remote_state:{turbo:false},observed_remote_at:time(3),observed_remote_field_at:{turbo:time(1)}}}), 'Turbo: ON');
checks.push('Special functions use saved receiver/reported values, separate swing directions, omit FILTER and respect field timestamps.');
const records=[
 {nodeId:'n1',timestamp:new Date(time(2)),controlName:'Office controller',status:'online',temperature:null,battery:0,rssi:-59,controlSnapshot:captured},
 {nodeId:'n2',timestamp:new Date(time(3)),controlName:'Second controller',status:'offline',temperature:24,battery:0,rssi:-90,controlSnapshot:{desired_state:{power:true,mode:'heat',fan:'auto'}}}
];
const elements=new Map(),table={closest:()=>({scrollTop:80}),replaceChildren:fragment=>{context.tableRows=fragment.rows}};
Object.assign(context,{currentPeriod:'daily',currentPage:1,PAGE_SIZE:20,nodeDataLogs:records,controlNameMap:{},locationMap:{},globalAirconMap:{},
 populateDateRangeOptions(){},getFilteredLogs:()=>records,calculateStats:()=>({totalRecords:2,avgTemp:24,onlineNodes:1}),
 updateActiveFilterBadge(){},predictEnergyConsumption(){},getBatteryPercentage:()=>0,getSignalIcon:()=> '',
 document:{getElementById:id=>id==='logsTableBody'?table:elements.get(id)||elements.set(id,{}).get(id),
 createDocumentFragment:()=>({rows:[],appendChild(row){this.rows.push(row)}}),createElement:()=>({})}});
vm.runInContext(section('function locationLabel(', '// Get room name for a node'), context);
vm.runInContext(section('function render({','// ── REDESIGNED EXECUTIVE EXCEL'),context);context.render({preserveScroll:true});
const cells=html=>[...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(m=>m[1].trim());
for(const row of context.tableRows)assert.equal(cells(row.innerHTML).length,13);
assert.deepEqual([cells(context.tableRows[0].innerHTML)[7],cells(context.tableRows[0].innerHTML)[8]],['COOL','QUIET · TURBO']);
assert.deepEqual([cells(context.tableRows[1].innerHTML)[7],cells(context.tableRows[1].innerHTML)[8]],['Unavailable','Unavailable']);
assert(!context.tableRows.some(row=>/REQUESTED|TRANSMITTED/.test(row.innerHTML)));
checks.push('Actual history rows render thirteen aligned cells with separate recorded mode and fan values.');
Object.assign(context,{
 getEnergyPredictionForExport:()=>null,getActiveTariffRate:()=>null,getUtilityProvider:()=> 'Unavailable',
 getAnalyticsNodeId:log=>log.nodeId,calculateEnergyCost:()=>null,getAnalyticsChartSeries:()=>[],getDateRangeText:()=> 'Selected date',
 currentNodeFilter:'',startTimeFilter:'',endTimeFilter:'',globalInstallDateMap:{},getEnergySelectionKey:()=> 'fixture',energyPredictionPending:false
});
const report=context.buildLogsReportSnapshot();
for(let i=0;i<records.length;i++){
 const reading=report.rows[i];
 const tableCells=cells(context.tableRows[i].innerHTML);
 assert.deepEqual([reading.mode,reading.fan,reading.special],[tableCells[7],tableCells[8],tableCells[9]]);
}
for(const [start,end] of [['async function exportExcelLogs()','async function exportLogs()'],['async function exportLogs()','async function addExtraPdfSections(']]){
 const body=section(start,end);
 assert(body.includes('await prepareLogsReport()'),'Both actual export entry points consume the shared historical report snapshot');
}
checks.push('The shared production report snapshot preserves the same historical mode/fan values as the table and feeds both export entry points.');
fs.mkdirSync(path.join(root,'reports/analytics-climate-modes'),{recursive:true});
fs.writeFileSync(path.join(root,'reports/analytics-climate-modes/function-tests.json'),JSON.stringify({passed:checks.length,checks,live_hardware_tested:false},null,2));
console.log('Analytics climate modes: '+checks.length+' scenario groups passed.');
