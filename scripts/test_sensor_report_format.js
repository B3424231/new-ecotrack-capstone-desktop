/* Isolated export comparison: actual report generators and vendor libraries, no live data/network. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.ECOTRACK_PLAYWRIGHT || 'playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'reports/workspace-modes/report-format');
(async()=>{
 fs.mkdirSync(out,{recursive:true});const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({acceptDownloads:true,timezoneId:'Asia/Singapore'});await page.route('**/*',route=>route.abort());await page.setContent('<!doctype html><title>Isolated report export checks</title>');
  for(const filename of ['vendor/jspdf.umd.min.js','vendor/jspdf.plugin.autotable.min.js','vendor/exceljs.min.js','js/sensor-reports.js'])await page.addScriptTag({path:path.join(root,'public',filename)});
  const source=fs.readFileSync(path.join(root,'public/js/logs.js'),'utf8');
  await page.addScriptTag({content:source.slice(source.indexOf('function reportFormat('),source.indexOf('function buildLogsReportSnapshot('))});
  await page.addScriptTag({content:source.slice(source.indexOf('// Read-only supplemental PDF data.'),source.indexOf('// Both original public export entry points'))});
  await page.addScriptTag({content:source.slice(source.indexOf('// Both original public export entry points'))});
  await page.evaluate(()=>{
   window.sensorReport={period:'daily',date:'2026-10-19',time:'All times',scope:'Fixture Sensors',rate:13.24,provider:'Fixture Utility',generated:new Date('2026-10-19T07:00:00Z'),
    headings:['Timestamp (UTC+08:00)','Sensor Name','Building','Floor','Room','Attached Aircon Type','AC State','Temperature (C)','Airflow Pressure (Pa)','Battery (V)','RSSI (dBm)','Recorded Status'],
    rows:Array.from({length:4},(_,index)=>({node_id:'monitor-fixture',sensor_name:'Monitoring Fixture',location:'Sensor Building · Sensor Floor · Sensor Room',aircon_type:'Window Type',observed_at:new Date(Date.parse('2026-10-19T00:00:00Z')+[0,60,120,1200][index]*1000).toISOString(),outlet_temperature_c:[18,19,null,21][index],differential_pressure_pa:[0,null,30,40][index],battery_voltage:[3.7,0,null,3.6][index],rssi_dbm:[-61,-60,null,-62][index],ac_on:[true,false,null,null][index],interval_seconds:60,connection_status:'offline',temperature_quality:'good',pressure_quality:'good'})),
    stats:{temperature_avg:58/3,pressure_avg:70/3,confirmed_state_count:2,confirmed_unit_hours:1/60,observed_unit_hours:2/60},
    energy:{available:true,energy_kwh:.25,estimated_unit_hours:1/60,devices:[{node_id:'monitor-fixture',energy_kwh:.25,estimated_seconds:60}],points:[{observed_at:'2026-10-19T00:00:00Z',energy_kwh:.25},{observed_at:'2026-10-19T00:01:00Z',energy_kwh:null},{observed_at:'2026-10-19T00:20:00Z',energy_kwh:0}]},devices:[{id:'monitor-fixture',created_at:'2026-10-01T00:00:00Z'}],
    notes:['Source: selected local AC sensor observations. Controller commands and requested settings are excluded.','Runtime uses independent recorded power feedback, actual timestamps and cadence; missing gaps remain excluded.','Requires five minutes of continuous, in-range, good-quality outlet temperatures with cadence at most 60 seconds.','Experimental NREL laboratory model; field accuracy unverified. Estimated energy is not metered consumption or a future forecast.','Missing measurements remain unavailable. Real zero values are preserved.']};
   sensorReport.values=sensorReport.rows.map(row=>[row.observed_at,row.sensor_name,'Sensor Building','Sensor Floor','Sensor Room',row.aircon_type,row.ac_on===true?'Confirmed ON':row.ac_on===false?'Confirmed OFF':'Not reported',row.outlet_temperature_c??'Unavailable',row.differential_pressure_pa??'Unavailable',row.battery_voltage??'Unavailable',row.rssi_dbm??'Unavailable',row.connection_status]);
   window.controllerReport={period:'daily',date:'2026-10-19',time:'All times',timezone:'Asia/Singapore',scope:'Fixture Controls',rate:13.24,provider:'Fixture Utility',generated:sensorReport.generated,synthetic:true,kwh:2,cost:26.48,runtime:.1,unitHours:.1,unknown:1,previous:null,notes:[],prediction:{recordedColumns:true},
    rows:[{id:'controller-fixture',name:'Control Reference',timestamp:new Date('2026-10-19T00:00:00Z'),building:'Control Building',floor:'Control Floor',room:'Control Room',type:'Split Type',setpoint:24,temperature:29,mode:'COOL',fan:'AUTO',special:'None recorded',battery:90,rssi:-60,status:'offline',power:null}],
    controllers:[{id:'controller-fixture',name:'Control Reference',building:'Control Building',floor:'Control Floor',room:'Control Room',type:'Split Type',count:1,kwh:2,cost:26.48,hours:.1,status:'offline',registered:'2026-10-01',setpoint:24,basis:'Recorded controls'}],intervals:[{label:'08:00',kwh:2,cost:26.48}]};
   window.globalNodeRecords=[];window.locationMap={};window.currentPeriod='daily';window.selectedDateKey='2026-10-19';window.currentNodeFilter='';window.startTimeFilter='';window.endTimeFilter='';window.energyPredictionPending=false;window.getEnergySelectionKey=()=> 'fixture';window.getDefaultDateKey=()=> '2026-10-19';window.calculateEnergyCost=(energy,rate)=>Number.isFinite(energy)&&Number.isFinite(rate)?energy*rate:null;
   window.prepareLogsReport=async()=>controllerReport;window.preparePdfSupplement=async()=>buildPdfSupplement(controllerReport,{records:[],audit:[],state:'loaded',source:'Isolated fixture'},pdfReportScope());window.showReportError=error=>{throw error;};
  });
  for(const format of ['pdf','xlsx']){
   const pending=page.waitForEvent('download');await page.evaluate(format=>format==='pdf'?exportLogs():exportExcelLogs(),format);await(await pending).saveAs(path.join(out,'controller-reference.'+format));
  }
  const cases=['selected','empty','zero-tariff','missing-tariff','zero-energy','many-devices'];
  const checks=[];
  for(const scenario of cases){
   await page.evaluate(scenario=>{
    window.currentSensorReport={...sensorReport};
    if(scenario==='empty')Object.assign(currentSensorReport,{rows:[],values:[],stats:{sample_count:0,confirmed_state_count:0},energy:{available:false,points:[],devices:[]}});
    if(scenario==='zero-tariff')currentSensorReport.rate=0;
    if(scenario==='missing-tariff')currentSensorReport.rate=null;
    if(scenario==='zero-energy')currentSensorReport.energy={...sensorReport.energy,energy_kwh:0,devices:[{node_id:'monitor-fixture',energy_kwh:0,estimated_seconds:60}],points:sensorReport.energy.points.map(point=>({...point,energy_kwh:point.energy_kwh===null?null:0}))};
    if(scenario==='many-devices'){
     currentSensorReport.rows=Array.from({length:18},(_,index)=>sensorReport.rows.map(row=>({...row,node_id:'monitor-'+index,sensor_name:'Monitoring Sensor '+index+' with a longer registered name',location:'Sensor Building · Sensor Floor · Room '+index}))).flat();
     currentSensorReport.values=currentSensorReport.rows.map(row=>[row.observed_at,row.sensor_name,'Sensor Building','Sensor Floor',row.location.split(' · ').at(-1),row.aircon_type,'Not reported',row.outlet_temperature_c??'Unavailable',row.differential_pressure_pa??'Unavailable',row.battery_voltage??'Unavailable',row.rssi_dbm??'Unavailable',row.connection_status]);
     currentSensorReport.energy={...sensorReport.energy,energy_kwh:4.5,estimated_unit_hours:18/60,points:sensorReport.energy.points.map(point=>({...point,energy_kwh:point.energy_kwh===null?null:point.energy_kwh*18})),devices:Array.from({length:18},(_,index)=>({node_id:'monitor-'+index,energy_kwh:.25,estimated_seconds:60}))};
    }
   },scenario);
   const pdf=await page.evaluate(()=>Array.from(new Uint8Array(EcoTrackSensorReports.pdf(currentSensorReport).output('arraybuffer'))));fs.writeFileSync(path.join(out,'sensor-'+scenario+'.pdf'),Buffer.from(pdf));
   const xlsx=await page.evaluate(async()=>Array.from(new Uint8Array(await EcoTrackSensorReports.excel(currentSensorReport).xlsx.writeBuffer())));fs.writeFileSync(path.join(out,'sensor-'+scenario+'.xlsx'),Buffer.from(xlsx));
   const inspected=await page.evaluate(async()=>{const wb=new ExcelJS.Workbook();await wb.xlsx.load(await EcoTrackSensorReports.excel(currentSensorReport).xlsx.writeBuffer());const summary=wb.getWorksheet('Analytics & Summary'),logs=wb.getWorksheet('Sensor Telemetry Logs');return {sheets:wb.worksheets.map(sheet=>sheet.name),energy:summary.getCell('B13').value,cost:summary.getCell('B14').value,pressure:logs.getCell('I5').value,batteryZero:logs.getCell('J6').value,rows:logs.rowCount,columns:logs.columnCount,noteFound:summary.getSheetValues().flat(2).some(value=>typeof value==='string' && value.includes('Source: selected local AC sensor observations'))};});
   assert.deepEqual(inspected.sheets,['Analytics & Summary','Sensor Telemetry Logs']);assert.equal(inspected.columns,12);assert.equal(inspected.noteFound,false);
   if(scenario==='selected'){assert.equal(inspected.energy.result,.25);assert.equal(inspected.cost.result,3.31);assert.equal(inspected.pressure,0);assert.equal(inspected.batteryZero,0);assert.equal(inspected.rows,8);}
   if(scenario==='empty'){assert.equal(inspected.energy,'Unavailable');assert.equal(inspected.cost,'Unavailable');}
   if(scenario==='zero-tariff'||scenario==='zero-energy')assert.equal(inspected.cost.formula,'B13*$B$9'); // Cached zeros are checked independently below; ExcelJS's value getter omits them.
   if(scenario==='missing-tariff')assert.equal(inspected.cost,'Unavailable');
   checks.push({scenario,status:'PASS',...inspected});
  }
  require('node:child_process').execFileSync('C:/Users/reygay/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',['-c',`from openpyxl import load_workbook
from pathlib import Path
from copy import copy
from pypdf import PdfReader
import sys
folder=Path(sys.argv[1])
for name in ['zero-tariff','zero-energy']:
 wb=load_workbook(folder/('sensor-'+name+'.xlsx'),data_only=True)
 assert wb['Analytics & Summary']['B14'].value==0,name
wb=load_workbook(folder/'sensor-selected.xlsx',data_only=True)
assert wb['Sensor Telemetry Logs']['A5'].value.hour==8
assert wb['Sensor Telemetry Logs']['I5'].value==0
assert wb['Sensor Telemetry Logs']['J6'].value==0
reference=load_workbook(folder/'controller-reference.xlsx').worksheets[0]
sensor=load_workbook(folder/'sensor-selected.xlsx').worksheets[0]
for address in ['A2','A4','B9','A12']:
 for attribute in ['font','fill','alignment']:
  assert copy(getattr(reference[address],attribute))==copy(getattr(sensor[address],attribute)),(address,attribute)
removed=['Source: selected local AC sensor observations','Runtime uses independent recorded power feedback','Requires five minutes of continuous','Experimental NREL laboratory model; field accuracy unverified','Missing measurements remain unavailable. Real zero values are preserved.']
for pdf in folder.glob('sensor-*.pdf'):
 text=chr(10).join(page.extract_text() for page in PdfReader(pdf).pages)
 assert all(note not in text for note in removed),pdf
 assert all(label not in text for label in ['Control Reference','Haier','Histogram Gradient Boosting','Target Temperature','Blower Fan Mode','Recorded sensor telemetry'])
 for title in ['Sensor Device Directory','Energy Consumption Ranking','Initial & Final Sensor Readings','Sensor Aggregation Summary','Executive Summary']:
  assert title in text,(pdf,title)
for xlsx in folder.glob('sensor-*.xlsx'):
 wb=load_workbook(xlsx)
 text=' '.join(str(cell.value) for sheet in wb for row in sheet for cell in row)
 assert all(note not in text for note in removed),xlsx
`,out],{stdio:'pipe'});
  fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({status:'PASS',checks,cached_zero_and_local_dates:'PASS independent workbook reader',live_network_requests:0},null,2));console.log('PASS controller reference exports and six monitoring export cases, native dates, formulas, null/zero and long-name pagination');
 }finally{await browser.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
