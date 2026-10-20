/* Conditional future cost plans. No command dispatch, telemetry writes, or fabricated measurements. */
(function (root) {
  'use strict';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const copy = value => JSON.parse(JSON.stringify(value));
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = (value, digits = 2) => finite(value) ? value.toLocaleString('en-US', {maximumFractionDigits:digits}) : 'Unavailable';
  const money = value => finite(value) ? '₱' + value.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2}) : 'Unavailable';
  const today = (now = Date.now()) => new Date(now + 8 * 3600000).toISOString().slice(0,10);
  function dateValue(key) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key || '')) throw Error('Choose valid future dates.');
    const date = new Date(key + 'T00:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== key) throw Error('Choose valid future dates.');
    return date;
  }
  function addDays(key, count) { const date = dateValue(key); date.setUTCDate(date.getUTCDate() + count); return date.toISOString().slice(0,10); }
  function periodRange(period, now = Date.now()) {
    const current = today(now), next = addDays(current,1);
    if (period === 'tomorrow') return {from:next,to:next};
    if (period === 'week') return {from:next,to:addDays(next,6)};
    if (period === 'month') {
      const date = dateValue(current); date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth()+1);
      const from = date.toISOString().slice(0,10); date.setUTCMonth(date.getUTCMonth()+1); date.setUTCDate(0);
      return {from,to:date.toISOString().slice(0,10)};
    }
    throw Error('Choose a forecast period.');
  }
  function planDays(plan, now = Date.now()) {
    const from = dateValue(plan.from), to = dateValue(plan.to);
    if (plan.from <= today(now) || to < from || (to-from)/86400000 > 365) throw Error('Choose a future range of up to 366 days.');
    if (plan.hours === '' || plan.hours == null || typeof plan.hours === 'boolean' || !Number.isFinite(Number(plan.hours)) || Number(plan.hours)<0 || Number(plan.hours)>24) throw Error('Enter planned AC hours per day, from 0 to 24.');
    if (!['everyday','weekdays','weekends'].includes(plan.days)) throw Error('Choose operating days.');
    const rows = [];
    for (let date=plan.from;date<=plan.to;date=addDays(date,1)) {
      const weekday = dateValue(date).getUTCDay(), weekend = weekday===0 || weekday===6;
      rows.push({date,hours:(plan.days==='everyday' || (plan.days==='weekdays' ? !weekend : weekend)) ? Number(plan.hours) : 0});
    }
    return rows;
  }
  async function calculate(plan, context, options = {}) {
    const days = planDays(plan,options.now), source = context.source;
    if (!['sensor','controller'].includes(source)) throw Error('The forecast data source is unavailable.');
    const devices = (context.devices || []).filter(device => !plan.device || device.id===plan.device);
    if (!devices.length) throw Error('No AC units match this selection. Refresh the page or choose another device.');
    const ids = new Set();
    for (const device of devices) { if (!device.id || ids.has(device.id)) throw Error('Device identities are ambiguous. Refresh the page.'); ids.add(device.id); }
    const plannedHours = days.reduce((sum,day)=>sum+day.hours,0), outcomes = new Array(devices.length), cache = new Map(); let next=0;
    await Promise.all(Array.from({length:Math.min(3,devices.length)},async()=>{
      while(next<devices.length) {
        const index=next++,device=devices[index];
        if (options.signal?.aborted) throw new DOMException('Cancelled','AbortError');
        let rate=null,reason=device.reason || null,settings=null,model=null,coverage=null;
        try {
          if (source==='sensor') {
            if (finite(device.referenceKwh) && device.referenceKwh>=0 && finite(device.referenceSeconds) && device.referenceSeconds>0) {
              rate=device.referenceKwh/(device.referenceSeconds/3600);coverage=device.referenceSeconds/3600;model='XGBoost sensor-history average';reason=null;
            } else throw Error(reason || 'No covered sensor estimate in the selected observation period.');
          } else {
            settings={...device.settings};
            if (plan.target!=null && plan.target!=='') { delete settings.setpoint_c;delete settings.temperature;settings.temp=Number(plan.target); }
            if (plan.mode) { delete settings.operating_mode;settings.mode=plan.mode; }
            if (plan.fan) { delete settings.fan_command;settings.fan=plan.fan; }
            if (typeof context.predict!=='function') throw Error('The controller prediction service is unavailable.');
            const key=JSON.stringify(settings);
            if (!cache.has(key)) cache.set(key,Promise.resolve().then(()=>context.predict(settings,{signal:options.signal})));
            const prediction=await cache.get(key);
            if (!finite(prediction.kwh) || prediction.kwh<0 || prediction.output_unit!=='kWh' || prediction.horizon_hours!==1) throw Error('The model did not return a one-hour energy estimate.');
            rate=prediction.kwh;model='Histogram Gradient Boosting';settings=prediction.settings || settings;reason=null;
          }
        } catch(error) { if (options.signal?.aborted) throw error;reason=error.message; }
        outcomes[index]={id:device.id,name:device.name,rate,settings,model,coverage,reason,kwh:plannedHours===0?0:finite(rate)?rate*plannedHours:null};
      }
    }));
    const complete=outcomes.every(device=>finite(device.kwh));
    const tariff=finite(context.tariff) && context.tariff>=0 ? context.tariff : null;
    const rows=days.map(day=>{ const energy=day.hours===0?0:complete?outcomes.reduce((sum,device)=>sum+device.rate*day.hours,0):null;return {...day,kwh:energy,cost:energy!==null && tariff!==null?energy*tariff:null}; });
    const kwh=complete?rows.reduce((sum,row)=>sum+row.kwh,0):null;
    return {source,available:complete,from:plan.from,to:plan.to,scope:plan.device?devices[0].name:context.scope || 'Selected AC units',hoursPerDay:Number(plan.hours),operatingDays:plan.days,
      plannedUnitHours:plannedHours*devices.length,deviceCount:devices.length,tariff,kwh,cost:kwh!==null && tariff!==null?kwh*tariff:null,rows,devices:outcomes,
      reference:context.reference || '',generated:new Date().toISOString(),basis:source==='sensor'?'Historical modeled draw held constant over planned AC hours':'One-hour control-model estimate scaled by planned AC hours',
      limitation:source==='sensor'?'Conditional projection from covered sensor history; future temperatures and consumption are not forecast by the sensor model.':'Conditional reference-model projection; planned hours do not confirm future AC operation.',
      reason:complete?(tariff===null?'Set the electricity tariff to estimate cost.':''):outcomes.filter(device=>device.reason).map(device=>device.name+': '+device.reason).join(' ')};
  }
  function sensorDevices(nodes, energy) {
    const grouped=new Map();
    for(const node of nodes || []) {
      const key=node.aircon_id || node.id;
      if (!grouped.has(key)) grouped.set(key,{id:key,name:node.aircon_name || node.name,referenceKwh:0,referenceSeconds:0,missing:false});
      const item=grouped.get(key),reading=energy?.available && (energy.devices || []).find(device=>device.node_id===node.id && device.aircon_id===node.aircon_id);
      if (reading && finite(reading.energy_kwh) && reading.energy_kwh>=0 && finite(reading.estimated_seconds) && reading.estimated_seconds>0) {
        item.referenceKwh+=reading.energy_kwh;item.referenceSeconds+=reading.estimated_seconds;
      } else item.missing=true;
    }
    return [...grouped.values()].map(item=>item.referenceSeconds>0 ? item : {...item,referenceKwh:null,referenceSeconds:null,reason:'No eligible temperature-model coverage in the selected history.'});
  }
  let adapter=null,draft=null,touched=false,dialog=null,version=0,timer=null,abort=null,returnFocus=null,last=null,contextKey=null;
  const $=id=>root.document?.getElementById(id);
  function readPlan() {
    return {...draft,device:$('futureDevice').value,from:$('futureFrom').value,to:$('futureTo').value,hours:$('futureHours').value,days:$('futureDays').value,target:$('futureTarget')?.value ?? '',mode:$('futureMode')?.value ?? '',fan:$('futureFan')?.value ?? ''};
  }
  function context() { const data=adapter.context();return {...data,source:adapter.source}; }
  function resetResult(message) {
    last=null;
    if (!$('futureResult')) return;
    $('futureResult').innerHTML='<div class="fc-empty">'+esc(message)+'</div>';
    $('futurePdfNote').textContent='Results will be included by the page’s Export PDF button.';
  }
  function renderResult(result) {
    last=result;
    const cells=[['PREDICTED ENERGY',number(result.kwh,3)+' kWh'],['ESTIMATED COST',money(result.cost)],['PLANNED AC UNIT-HOURS',number(result.plannedUnitHours,2)+' hrs'],['AC UNITS INCLUDED',result.deviceCount]];
    const max=Math.max(1,...result.rows.map(row=>row.kwh || 0)),stride=Math.max(1,Math.ceil(result.rows.length/31));
    const bars=result.rows.filter((_,index)=>index%stride===0).map(row=>'<div class="fc-bar-column"><span>'+esc(number(row.kwh,2))+'</span><i style="height:'+Math.max(0,(row.kwh || 0)/max*110)+'px"></i><small>'+esc(row.date.slice(5))+'</small></div>').join('');
    $('futureResult').innerHTML='<div class="fc-kpis">'+cells.map(([label,value])=>'<section><small>'+label+'</small><strong>'+esc(value)+'</strong></section>').join('')+'</div>'+
      '<p class="fc-basis">'+esc(result.basis)+(result.reference?' · '+esc(result.reference):'')+'</p>'+
      (result.reason?'<p class="fc-message" role="status">'+esc(result.reason)+'</p>':'')+
      '<div class="fc-results-grid"><section class="fc-panel"><h3>Forecast Energy</h3>'+(result.available?'<div class="fc-chart" role="img" aria-label="Projected energy by date, in kWh">'+bars+'</div>':'<div class="fc-empty">No complete estimate available</div>')+'</section>'+
      '<section class="fc-panel"><h3>Daily Cost Breakdown</h3><div class="fc-table-scroll"><table><thead><tr><th>Date</th><th>Planned hours / AC</th><th>Energy</th><th>Est. cost</th></tr></thead><tbody>'+result.rows.map(row=>'<tr><td>'+row.date+'</td><td>'+number(row.hours)+'</td><td>'+number(row.kwh,3)+' kWh</td><td>'+money(row.cost)+'</td></tr>').join('')+'</tbody><tfoot><tr><th>Total</th><td></td><th>'+number(result.kwh,3)+' kWh</th><th>'+money(result.cost)+'</th></tr></tfoot></table></div></section></div>';
    $('futurePdfNote').textContent='Included in the page PDF report · '+(result.available?'Planned-use projection':'Unavailable inputs are identified');
  }
  async function update() {
    clearTimeout(timer);abort?.abort();abort=new AbortController();const signal=abort.signal,request=++version;
    if (!dialog?.open) return;
    draft=readPlan();resetResult('Updating estimate…');$('futureResult').setAttribute('aria-busy','true');
    try {
      const data=context();contextKey=JSON.stringify(data);
      const result=await calculate(copy(draft),data,{signal});
      if (request===version && dialog?.open && !signal.aborted) renderResult(result);
    } catch(error) { if (request===version && dialog?.open && !signal.aborted) resetResult(error.message); }
    finally { if (request===version && $('futureResult')) $('futureResult').setAttribute('aria-busy','false'); }
  }
  function changed() { touched=true;draft=readPlan();last=null;abort?.abort();++version;resetResult('Updating estimate…');clearTimeout(timer);timer=setTimeout(update,350); }
  function close() { clearTimeout(timer);abort?.abort();++version;dialog?.close();dialog?.remove();dialog=null;returnFocus?.focus(); }
  function open() {
    if (!adapter || dialog?.open) return;
    const data=context();if (!draft) draft={period:'week',...periodRange('week'),device:'',hours:'',days:'everyday',target:'',mode:'',fan:''};
    returnFocus=root.document.activeElement;dialog=root.document.createElement('dialog');dialog.id='futureCostDialog';dialog.className='fc-dialog';dialog.setAttribute('aria-labelledby','futureCostTitle');
    const control=adapter.source==='controller';
    dialog.innerHTML='<div class="fc-heading"><div><h2 id="futureCostTitle">Future Cost Estimate</h2><p>'+(control?'Controller model · Planned AC operation':'Sensor history · Planned-use projection')+'</p></div><button type="button" class="fc-close" aria-label="Close Future Cost">×</button></div>'+
      '<div class="fc-body"><div class="fc-periods" role="group" aria-label="Future period">'+[['tomorrow','Tomorrow'],['week','Next 7 Days'],['month','Next Month'],['custom','Custom']].map(([value,label])=>'<button type="button" data-fc-period="'+value+'" aria-pressed="'+(draft.period===value)+'">'+label+'</button>').join('')+'</div>'+
      '<form id="futureCostForm" class="fc-form"><label>From<input type="date" id="futureFrom" value="'+esc(draft.from)+'" min="'+addDays(today(),1)+'" required></label><label>Through<input type="date" id="futureTo" value="'+esc(draft.to)+'" min="'+addDays(today(),1)+'" required></label>'+
      '<label>AC unit<select id="futureDevice"><option value="">All selected AC units</option>'+data.devices.map(device=>'<option value="'+esc(device.id)+'" '+(device.id===draft.device?'selected':'')+'>'+esc(device.name)+'</option>').join('')+(draft.device && !data.devices.some(device=>device.id===draft.device)?'<option value="'+esc(draft.device)+'" selected>Selected AC unit unavailable</option>':'')+'</select></label>'+
      '<label>Planned AC hours / day<input id="futureHours" type="number" min="0" max="24" step="0.25" placeholder="Enter hours" value="'+esc(draft.hours)+'" required></label>'+
      '<label>Operating days<select id="futureDays">'+[['everyday','Every day'],['weekdays','Weekdays'],['weekends','Weekends']].map(([value,label])=>'<option value="'+value+'" '+(draft.days===value?'selected':'')+'>'+label+'</option>').join('')+'</select></label>'+
      (control?'<label>Target (°C)<input id="futureTarget" type="number" min="16" max="30" step="1" placeholder="Use saved" value="'+esc(draft.target)+'"></label><label>Mode<select id="futureMode">'+[['','Use saved'],['cool','Cool'],['auto','Auto'],['heat','Heat'],['dry','Dry'],['fan','Fan']].map(([value,label])=>'<option value="'+value+'" '+(draft.mode===value?'selected':'')+'>'+label+'</option>').join('')+'</select></label><label>Fan<select id="futureFan">'+[['','Use saved'],['auto','Auto'],['low','Low'],['medium','Medium'],['high','High'],['quiet','Quiet']].map(([value,label])=>'<option value="'+value+'" '+(draft.fan===value?'selected':'')+'>'+label+'</option>').join('')+'</select></label>':'')+
      '<label>Electricity rate<output id="futureTariff">'+(finite(data.tariff)?money(data.tariff)+' / kWh':'Set tariff on the page')+'</output></label></form>'+
      '<p class="fc-help">Planned AC hours are separate from ESP32 wake/sleep times. Results update automatically.</p><div id="futureResult" aria-live="polite"></div></div>'+
      '<footer><span id="futurePdfNote"></span><button type="button" id="futureDone">Close</button></footer>';
    root.document.body.appendChild(dialog);dialog.querySelector('.fc-close').addEventListener('click',close);$('futureDone').addEventListener('click',close);
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});dialog.addEventListener('click',event=>{if(event.target===dialog){const box=dialog.getBoundingClientRect();if(event.clientX<box.left || event.clientX>box.right || event.clientY<box.top || event.clientY>box.bottom)close();}});
    $('futureCostForm').addEventListener('submit',event=>event.preventDefault());$('futureCostForm').addEventListener('input',changed);
    dialog.querySelectorAll('[data-fc-period]').forEach(button=>button.addEventListener('click',()=>{
      draft.period=button.dataset.fcPeriod;if(draft.period!=='custom'){const range=periodRange(draft.period);$('futureFrom').value=range.from;$('futureTo').value=range.to;}
      dialog.querySelectorAll('[data-fc-period]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));changed();
    }));
    for(const id of ['futureFrom','futureTo']) $(id).addEventListener('input',()=>{draft.period='custom';dialog.querySelectorAll('[data-fc-period]').forEach(item=>item.setAttribute('aria-pressed',String(item.dataset.fcPeriod==='custom')));});
    dialog.showModal();void update();
  }
  function configure(value) { adapter=value;root.document?.getElementById('openFutureCostBtn')?.addEventListener('click',open); }
  function notify() {
    last=null;
    if(dialog?.open){
      const value=context();if(JSON.stringify(value)===contextKey)return;
      $('futureTariff').textContent=finite(value.tariff)?money(value.tariff)+' / kWh':'Set tariff on the page';
      const chosen=draft.device;
      $('futureDevice').innerHTML='<option value="">All selected AC units</option>'+value.devices.map(device=>'<option value="'+esc(device.id)+'">'+esc(device.name)+'</option>').join('');
      if(chosen && !value.devices.some(device=>device.id===chosen))$('futureDevice').insertAdjacentHTML('beforeend','<option value="'+esc(chosen)+'">Selected AC unit unavailable</option>');
      $('futureDevice').value=chosen;changed();
    }
  }
  function hasPlan() { return !!(adapter && draft && touched); }
  async function capture(options = {}) {
    if (!adapter || !draft || !touched) return null;
    const plan=copy(draft),data=options.context?{...options.context,source:adapter.source}:context(),key=JSON.stringify([plan,data.source,data.devices,data.tariff,data.reference]);
    try {
      const result=await calculate(plan,data,{signal:options.signal});
      if (options.context ? JSON.stringify(plan)!==JSON.stringify(draft) : key!==JSON.stringify([draft,...((value)=>[value.source,value.devices,value.tariff,value.reference])(context())])) throw Error('The future plan changed during export. Retry the page Export PDF button.');
      return copy(result);
    } catch(error) {
      if (options.signal?.aborted || /changed during export/.test(error.message)) throw error;
      return {source:adapter.source,available:false,from:plan.from,to:plan.to,reason:error.message,rows:[],devices:[],limitation:'A complete future-cost plan could not be evaluated.'};
    }
  }
  function appendPdf(doc,result) {
    if (!result) return;
    const width=doc.internal.pageSize.getWidth(),height=doc.internal.pageSize.getHeight(),margin=14;
    const safe=value=>String(value ?? 'Unavailable').replace(/₱/g,'PHP ').replace(/°/g,' deg ').replace(/[·•–—]/g,'-');
    const table=(head,body,startY,columnStyles={})=>doc.autoTable({head:[head.map(safe)],body:body.map(row=>row.map(safe)),startY,margin:{left:margin,right:margin,top:28,bottom:18},theme:'striped',styles:{font:'helvetica',fontSize:8.5,cellPadding:3,overflow:'linebreak'},columnStyles,headStyles:{fillColor:[23,56,47],textColor:255},alternateRowStyles:{fillColor:[245,248,247]}});
    const page=title=>{doc.addPage();doc.setFont('helvetica','bold');doc.setFontSize(17);doc.setTextColor(23,56,47);doc.text(title,margin,23);};
    page('Future Cost Projection - '+(result.source==='sensor'?'Sensor':'Controller'));
    table(['Plan / basis','Selected value'],[['Future period',result.from+' to '+result.to],['Source',result.source==='sensor'?'Recorded XGBoost sensor estimates':'Histogram Gradient Boosting control estimates'],['Method',result.basis || 'Unavailable'],['Reference history',result.reference || 'Not applicable'],['AC scope',result.scope || 'Unavailable'],['Planned hours / day',number(result.hoursPerDay)],['Operating days',result.operatingDays || 'Unavailable'],['Tariff (PHP / kWh)',number(result.tariff)],['Predicted energy (kWh)',number(result.kwh,4)],['Estimated cost (PHP)',number(result.cost)],['Planned AC unit-hours',number(result.plannedUnitHours)],['AC units included',result.deviceCount ?? 'Unavailable']],32);
    let y=doc.lastAutoTable.finalY+9;
    doc.setFont('helvetica','normal');doc.setFontSize(9);doc.setTextColor(100,116,139);
    const notes=doc.splitTextToSize(safe(result.limitation+(result.reason?' '+result.reason:'')),width-margin*2);
    if(y+notes.length*5>height-18){page('Future Cost Projection - Basis');y=34;}doc.text(notes,margin,y);
    if(result.devices?.length){
      page('Future Cost - AC Inputs and Coverage');
      const controls=settings=>{
        if(!settings)return 'Recorded temperature-model output';
        const flags=[['eco','Eco'],['turbo','Turbo'],['swing','Vertical swing'],['quiet','Quiet'],['horizontal_swing','Horizontal swing'],['display','Display']];
        return ['Target: '+(settings.setpoint_c??settings.temp??settings.temperature??'Not recorded')+' C','Mode: '+(settings.operating_mode??settings.mode??'Not recorded'),'Fan: '+(settings.fan_command??settings.fan??'Not recorded'),...flags.map(([key,label])=>label+': '+(settings[key]===true?'On':settings[key]===false?'Off':'Not recorded'))].join('\n');
      };
      const columns=Object.fromEntries([.16,.18,.15,.14,.24,.13].map((ratio,index)=>[index,{cellWidth:(width-margin*2)*ratio}]));
      table(['AC unit','Model / reference','Energy per planned hour (kWh)','Covered history (hours)','Control inputs','Availability'],result.devices.map(device=>[device.name,device.model,number(device.rate,4),result.source==='controller'?'Not applicable':number(device.coverage,3),controls(device.settings),device.reason || 'Available']),33,columns);
    }
    if(result.rows?.length){page('Future Cost - Daily Breakdown');table(['Date','Planned hours / AC','Predicted energy (kWh)','Estimated cost (PHP)'],[...result.rows.map(row=>[row.date,number(row.hours),number(row.kwh,4),number(row.cost)]),['TOTAL','',number(result.kwh,4),number(result.cost)]],33);}
  }
  root.EcoTrackFutureCost=Object.freeze({configure,open,notify,capture,hasPlan,appendPdf,calculate,periodRange,planDays,sensorDevices});
})(typeof window==='undefined'?globalThis:window);
