'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require(process.env.ECOTRACK_PLAYWRIGHT || 'playwright');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
module.exports=async function interactions(browser){
 const ctx=await browser.newContext({viewport:{width:1200,height:850},timezoneId:'Asia/Singapore'}),form=await ctx.newPage();
 try{
  await ctx.route('**/*',route=>route.abort());await form.setContent('<!doctype html><button id="openFutureCostBtn">Future Cost</button>');
  await form.addStyleTag({path:path.join(__dirname,'../public/css/future-cost.css')});await form.addScriptTag({path:path.join(__dirname,'../public/js/future-cost.js')});
  await form.evaluate(()=>{
   window.fixture={tariff:10,devices:[{id:'one',name:'First AC',settings:{temp:24,mode:'cool',fan:'auto'}},{id:'two',name:'Second AC',settings:{temp:26,mode:'cool',fan:'auto'}}]};window.blockPrediction=false;
   EcoTrackFutureCost.configure({source:'controller',context:()=>({...fixture,predict:async()=>{if(blockPrediction)await new Promise(resolve=>window.releasePrediction=resolve);return {kwh:1,output_unit:'kWh',horizon_hours:1};}})});
  });
  await form.locator('#openFutureCostBtn').click();await form.locator('#futureHours').fill('8');await wait(500);
  await form.locator('[data-fc-period="tomorrow"]').click();await wait(500);
  const tomorrow=await form.evaluate(async()=>({from:document.getElementById('futureFrom').value,to:document.getElementById('futureTo').value,active:document.querySelector('[data-fc-period][aria-pressed="true"]').dataset.fcPeriod,result:await EcoTrackFutureCost.capture()}));
  assert.equal(tomorrow.result.rows.length,1,JSON.stringify(tomorrow));
  await form.locator('[data-fc-period="week"]').click();await form.locator('#futureDays').selectOption('weekdays');await wait(500);assert.equal((await form.evaluate(()=>EcoTrackFutureCost.capture())).plannedUnitHours,80);
  await form.locator('#futureDevice').selectOption('two');await wait(500);assert.equal((await form.evaluate(()=>EcoTrackFutureCost.capture())).deviceCount,1);
  await form.evaluate(()=>{fixture.tariff=20;EcoTrackFutureCost.notify();});await wait(500);assert.equal((await form.evaluate(()=>EcoTrackFutureCost.capture())).cost,800);
  await form.locator('#futureHours').fill('25');await wait(500);assert.equal(await form.locator('.fc-kpis').count(),0);assert.match(await form.locator('#futureResult').innerText(),/0 to 24/);
  await form.locator('#futureHours').fill('8');await wait(500);
  await form.evaluate(()=>{fixture.devices=fixture.devices.filter(device=>device.id!=='two');EcoTrackFutureCost.notify();});await wait(500);assert.equal(await form.locator('#futureDevice').inputValue(),'two');assert.match(await form.locator('#futureResult').innerText(),/No AC units/);
  await form.locator('#futureDone').click();await form.locator('#openFutureCostBtn').click();assert.equal(await form.locator('#futureDevice').inputValue(),'two','Removed selection may not silently become All ACs');
  await form.locator('#futureDevice').selectOption('');await wait(500);
  const dates=await form.evaluate(()=>EcoTrackFutureCost.periodRange('week'));await form.locator('#futureTo').fill(dates.from);await wait(500);assert.equal(await form.locator('[data-fc-period="custom"]').getAttribute('aria-pressed'),'true');
  await form.evaluate(()=>{blockPrediction=true;window.pendingCapture=EcoTrackFutureCost.capture().then(()=> 'incorrectly resolved',error=>error.message);});
  await form.waitForFunction(()=>typeof releasePrediction==='function');await form.locator('#futureHours').fill('7');await form.evaluate(()=>{blockPrediction=false;releasePrediction();});assert.match(await form.evaluate(()=>pendingCapture),/changed during export/);
  await wait(500);await form.evaluate(()=>{blockPrediction=true;window.releasePrediction=null;});await form.locator('#futureHours').fill('6');await form.waitForFunction(()=>typeof releasePrediction==='function');await form.keyboard.press('Escape');await form.evaluate(()=>{blockPrediction=false;releasePrediction();});await wait(100);assert.equal(await form.locator('#futureCostDialog').count(),0);
 }finally{await ctx.close();}
};
if(require.main===module)(async()=>{const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});try{await module.exports(browser);console.log('PASS future modal presets, validation, selection changes, stale results and cancellation');}finally{await browser.close();}})().catch(error=>{console.error(error.stack);process.exitCode=1;});
