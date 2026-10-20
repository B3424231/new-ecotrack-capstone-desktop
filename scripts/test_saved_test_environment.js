const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.ECOTRACK_PROJECT_ROOT || path.resolve(__dirname, '..');
const harness = fs.readFileSync(path.join(root,'scripts/test_energy_assumptions.js'),'utf8');
const prefix = harness.slice(0,harness.indexOf('const tests = {};'));
const {fixture} = new Function('require','__dirname',prefix+'\nreturn {fixture};')(require,path.join(root,'scripts'));
const environment={scenario_id:'lab_hot',indoor_c:30,outdoor_c:35,relative_humidity_percent:60,source:'explicit_test_assumption'};
let passed=0;
(async()=>{
  const mutations = {
    'Synthetic fixture metadata is ignored': rows => rows.forEach(row => row.controlSnapshot.test_fixture = {synthetic:true,batch:'test',environment:{...environment}}),
    'Missing environment has no effect': rows => rows.forEach(row => row.controlSnapshot.test_fixture = {synthetic:true,batch:'test'}),
    'Conflicting batches have no effect': rows => rows.forEach((row,index) => row.controlSnapshot.test_fixture = {synthetic:true,batch:String(index),environment:{...environment}}),
    'Nonfinite sensor assumptions are not inputs': rows => rows.forEach(row => row.controlSnapshot.test_fixture = {synthetic:true,batch:'test',environment:{...environment,indoor_c:null}}),
    'Undocumented scenarios have no effect': rows => rows.forEach(row => row.controlSnapshot.test_fixture = {synthetic:true,batch:'test',environment:{...environment,scenario_id:'unrecognized'}}),
    'Different temperature and humidity assumptions have no effect': rows => rows.forEach(row => row.controlSnapshot.test_fixture = {synthetic:true,batch:'test',environment:{...environment,indoor_c:99,outdoor_c:-99,relative_humidity_percent:0}}),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const app = fixture(); mutate(app.context.rows); const before = JSON.stringify(app.context.rows);
    await app.run(); assert.equal(app.context.currentEvaluatedKwh, 2, name);
    assert.equal(app.context.currentAnalyticsResult.inputScope, 'controls_only');
    assert.equal(app.context.currentAnalyticsResult.coverage.confirmedSamples, 0);
    assert.equal(app.context.currentAnalyticsResult.runtime.totalRuntimeSum, 0);
    assert.equal(JSON.stringify(app.context.rows), before);
    assert.deepEqual(Object.keys(app.requests[0]).sort(), ['model','settings']);
    for (const key of ['indoor_c','outdoor_c','relative_humidity_percent']) assert.equal(app.requests[0].settings[key], undefined);
    passed++;
  }
  const elements=new Map(), charts=[];
  for(const id of ['energyTrendChart','estimatedCostChart','dualAxisChart'])elements.set(id,{getContext:()=>({createLinearGradient:()=>({addColorStop(){}})})});
  const chartContext=vm.createContext({console,currentPeriod:'daily',currentNodeFilter:'',controlNameMap:{},currentEvaluatedKwh:null,
    currentAnalyticsResult:{kwh:null,nodes:[]},getAnalyticsChartSeries:()=>Array(9).fill(null),getActiveTariffRate:()=>13.24,
    getFilteredLogs:()=>[],getDateRangeText:()=>'',formatAnalyticsNumber:value=>value,
    document:{documentElement:{classList:{contains:()=>true}},getElementById:id=>elements.get(id)||null},
    Chart:class {constructor(canvas,config){this.data=config.data;this.options=config.options;charts.push(this);}update(){}}
  });
  const source=fs.readFileSync(path.join(root,'public/js/logs.js'),'utf8');
  chartContext.calculateEnergyCost=(energy,rate)=>Number.isFinite(energy)?energy*rate:null;
  vm.runInContext(source.slice(source.indexOf('let energyTrendChartInstance'),source.indexOf('// ─── ENERGY CONSUMPTION PREDICTION',source.indexOf('let energyTrendChartInstance'))),chartContext);
  chartContext.updateAnalyticsCharts(null,null);
  for(const chart of charts){
    assert.equal(chart.options.plugins.tooltip.filter({raw:null}),false);
    assert.equal(chart.options.plugins.tooltip.filter({raw:NaN}),false);
    assert.equal(chart.options.plugins.tooltip.filter({raw:0}),true);
  }
  assert.equal(charts[1].options.plugins.tooltip.callbacks.label({raw:null}),' Cost: Unavailable');
  assert.equal(charts[2].options.plugins.tooltip.callbacks.label({raw:null,dataset:{yAxisID:'y1'}}),' Cost: Unavailable');
  assert(charts[1].options.plugins.tooltip.callbacks.label({raw:0}).includes('₱0.00'));
  passed++;
  console.log(`PASS ${passed} ignored sensor-assumption and missing-tooltip checks`);
})().catch(error=>{console.error(error);process.exitCode=1;});
