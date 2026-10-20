'use strict';
// Exercise the production filter handlers, runtime, predictions, KPIs and chart data with isolated telemetry.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
process.env.TZ='Asia/Singapore';
const root=process.env.ECOTRACK_DESKTOP_ROOT||path.resolve(__dirname,'..');
const source=fs.readFileSync(process.env.ECOTRACK_LOGS_SOURCE||path.join(root,'public/js/logs.js'),'utf8').replace(/\r\n/g,'\n');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const section=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert(a>=0&&b>a,start);return source.slice(a,b)};
const fixed=Date.parse('2026-10-17T12:00:00+08:00');
class Clock extends Date{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed}}
const settings={power:true,temp:24,fan:'medium',mode:'cool',eco:false,turbo:false,swing_vertical:false,swing_horizontal:false,quiet:false,display:true};
const log=(date,hour,minute=0)=>({nodeId:'fixture-node',controlName:'Room controller',timestamp:new Clock(2026,9,date,hour,minute),acOn:true,intervalSeconds:3600,status:'online',temperature:24,
  controlSnapshot:{reported_state:settings,reported_at:new Clock(2026,9,date,hour,minute).toISOString()}});
function harness(){
  const elements=new Map(),charts=[];
  const element=id=>{if(!elements.has(id))elements.set(id,{id,value:'',textContent:'',innerHTML:'',dataset:{},style:{},handlers:{},classList:{contains:()=>false},
    addEventListener(name,fn){this.handlers[name]=fn},setCustomValidity(message){this.validationMessage=message},reportValidity(){},focus(){},
    getContext:()=>({createLinearGradient:()=>({addColorStop(){}})})});return elements.get(id)};
  const context=vm.createContext({Date:Clock,console,AbortController,setTimeout,clearTimeout,
    currentPeriod:'daily',currentNodeFilter:'',selectedDateKey:'',followLatestLogPeriod:true,currentPage:1,
    startTimeFilter:'',endTimeFilter:'',nodeDataLogs:[log(16,8)],globalNodeRecords:[{id:'fixture-node',name:'Room controller'}],controlNameMap:{},
    currentAnalyticsResult:null,currentEvaluatedKwh:null,currentEvaluatedCost:null,
    getAirconFleetCount:()=>({total:1,online:1}),getActiveTariffRate:()=>10,
    document:{getElementById:element,documentElement:{classList:{contains:()=>false}}},
    Chart:class{constructor(canvas,config){this.id=canvas.id;this.data=config.data;this.options=config.options;charts.push(this)}update(){}},
  });
  context.window=context;
  context.EcoTrackEnergyPrediction={normalizeSettings:state=>state,normalizeRecordedSettings:state=>state,
    predictRecorded:async()=>({kwh:2,reference_range_kwh:{min:2,max:2}})};
  vm.runInContext(read('public/js/aircon-state.js'),context);
  vm.runInContext(section('function getPeriodDateKey(', '// Initialize logs on page load'),context);
  vm.runInContext(section('// Get filtered logs based on current period', '// ─── ENERGY CONSUMPTION PREDICTION'),context);
  vm.runInContext(section('function calculateEnergyCost(', 'function saveTariffSettings('),context);
  vm.runInContext(section('let energyTrendChartInstance', '// ─── ENERGY CONSUMPTION PREDICTION'),context);
  vm.runInContext(section('function getConfirmedAcOnState(', '// Helper: Calculate previous period'),context);
  vm.runInContext(section('function getPreviousPeriodDateKey(', '// Helper: Get previous period runtime'),context);
  vm.runInContext(section('let currentPredictionSession', '// Convert 24-hour'),context);
  vm.runInContext(section('// Convert 24-hour', '// Render the page'),context);
  context.render=()=>{context.populateDateRangeOptions();context.lastFiltered=context.getFilteredLogs();context.pending=context.predictEnergyConsumption(context.calculateStats(),context.lastFiltered)};
  vm.runInContext(section("  const dateRangeSelect = document.getElementById('dateRangeSelect');",'  // Clear All Logs uses'),context);
  const change=(id,value)=>{const el=element(id);el.value=value;el.handlers.change({target:el});return context.pending};
  return {context,element,charts,change};
}
const close=(value,expected)=>assert(Math.abs(value-expected)<1e-9,`${value} != ${expected}`);
function chartTotal(charts){return charts.find(chart=>chart.id==='energyTrendChart').data.datasets[0].data.filter(Number.isFinite).reduce((sum,value)=>sum+value,0)}

async function explicitDate(){
  const app=harness(),{context,element}=app;
  context.render();await context.pending;assert.equal(context.selectedDateKey,'2026-10-16');close(context.currentEvaluatedKwh,2);close(chartTotal(app.charts),2);
  await app.change('dateRangeSelect','2026-10-17');
  assert.equal(context.selectedDateKey,'2026-10-17','Selecting today must not silently reset to yesterday when today has no samples');
  assert.equal(context.lastFiltered.length,0);assert.equal(context.currentEvaluatedKwh,null);assert.equal(element('kpiEnergyVal').textContent,'Unavailable');
  assert.equal(element('trendTotal').textContent,'Unavailable');assert(element('energyTrendSubtitle').textContent.includes('October 17, 2026'));
  assert.equal(context.nodeDataLogs.length,1,'Filtering must preserve recorded historical telemetry');
  await app.change('dateRangeSelect','2026-10-16');close(context.currentEvaluatedKwh,2);close(chartTotal(app.charts),2);
  await app.change('historyDatePicker','2026-10-14');
  assert.equal(context.selectedDateKey,'2026-10-14','An explicit empty historical date remains selected');assert.equal(context.currentEvaluatedKwh,null);
}

async function timeWindow(){
  const app=harness(),{context,element}=app;
  context.selectedDateKey='2026-10-16';context.followLatestLogPeriod=false;
  await app.change('startTimeFilter','08:00');await app.change('endTimeFilter','08:30');
  close(context.currentEvaluatedKwh,1);close(context.currentEvaluatedCost,10);close(context.currentAnalyticsResult.runtime.runtimeHrs,0.5);close(chartTotal(app.charts),1);
  close(context.getAnalyticsPeriodHours(),0.5);assert.equal(element('kpiAvgLoad').textContent,'2.0 kW');
  element('clearTimeFilterBtn').handlers.click();await context.pending;
  close(context.currentEvaluatedKwh,2);assert.equal(context.startTimeFilter,'');assert.equal(context.endTimeFilter,'');
  context.nodeDataLogs=[log(16,23),log(16,5),log(16,12),log(15,23),log(15,5),log(15,12)];
  await app.change('startTimeFilter','22:00');await app.change('endTimeFilter','06:00');
  assert.equal(context.getFilteredLogs().length,2);assert.equal(context.getPreviousAnalyticsLogs().length,2,'Previous comparisons must use the same overnight time window');
  close(context.getAnalyticsPeriodHours(),8);
}

async function pendingSelection(){
  const app=harness(),{context,element}=app;
  context.render();await context.pending;close(context.currentEvaluatedKwh,2);
  context.nodeDataLogs.push(log(15,8));let release;
  context.EcoTrackEnergyPrediction.predictRecorded=()=>new Promise(resolve=>{release=resolve});
  const pending=app.change('dateRangeSelect','2026-10-15');
  assert.equal(context.getEnergyPredictionForExport(),null);
  assert.equal(element('kpiEnergyVal').textContent,'Unavailable','A different selection cannot retain the previous date energy while its estimate is pending');
  assert.equal(element('trendTotal').textContent,'Unavailable');assert(element('energyTrendSubtitle').textContent.includes('October 15, 2026'));
  release({kwh:4,reference_range_kwh:{min:4,max:4}});await pending;close(context.currentEvaluatedKwh,4);close(chartTotal(app.charts),4);
}

(async()=>{const failures=[];for(const [name,test]of Object.entries({explicitDate,timeWindow,pendingSelection})){try{await test();console.log('PASS '+name)}catch(error){failures.push({name,error:error.message});console.error('FAIL '+name+': '+error.message)}}assert.equal(failures.length,0,JSON.stringify(failures));console.log('PASS: selected dates, no-data dates, times, overnight comparisons, current KPI/chart scope, and pending selection isolation.');})().catch(error=>{console.error(error);process.exitCode=1});
