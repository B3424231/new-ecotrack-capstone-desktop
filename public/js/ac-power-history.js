/* Read-only daily AC power history shared by Analytics and Control Dashboard. */
(function (root) {
  'use strict';
  const DAY=86400000,ZONE='Asia/Singapore';
  const measurementEvents=new Set(['telemetry','measurement','power_feedback','sensor_reading','heartbeat']);
  let viewSequence=0;
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const today=(now=Date.now())=>new Date(now+8*3600000).toISOString().slice(0,10);
  function dayStart(date){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw Error('Choose a valid history date.');
    const stamp=Date.parse(date+'T00:00:00+08:00');
    if(!Number.isFinite(stamp)||today(stamp)!==date)throw Error('Choose a valid history date.');
    return stamp;
  }
  const dateAfter=(date,days)=>today(dayStart(date)+days*DAY);
  const clock=stamp=>Number.isFinite(stamp)?new Date(stamp).toLocaleTimeString('en-US',{timeZone:ZONE,hour:'2-digit',minute:'2-digit',hour12:true}):'Unavailable';
  function duration(seconds){
    if(!Number.isFinite(seconds))return 'Unavailable';
    if(seconds===0)return '0m';
    const minutes=Math.floor(seconds/60),hours=Math.floor(minutes/60);
    return minutes===0?'<1m':(hours?hours+'h ':'')+(minutes%60)+'m';
  }
  function recordedTime(row){
    const value=row.observed_at??row.created;
    // An unqualified clock string cannot establish a UTC+08:00 historical time.
    return typeof value==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)?Date.parse(value):NaN;
  }
  function feedback(row){
    if(row.event_type && !measurementEvents.has(row.event_type))return null;
    if(row.clock_quality && row.clock_quality!=='synchronized')return null;
    if(row.observed_at && !['power_meter','isolated_contact'].includes(row.state_source))return null;
    // Explicit historical feedback only. Desired/reported IR settings are never used.
    return row.ac_on===true||row.ac_on===1?true:row.ac_on===false||row.ac_on===0?false:null;
  }
  function cadence(row){
    const value=row.interval_seconds;
    if(value!=null && value!=='' && typeof value!=='boolean' && Number.isFinite(Number(value)) && Number(value)>0 && Number(value)<=86400)return Number(value)*1000;
    return 0;
  }
  function analyze(rows,date,now=Date.now()){
    const start=dayStart(date),end=start+DAY,through=Math.max(start,Math.min(end,now));
    const streams=new Map(),points=new Map();let discarded=0;
    for(const row of rows){
      if(row.event_type && !measurementEvents.has(row.event_type))continue;
      const time=recordedTime(row);if(!Number.isFinite(time)){discarded++;continue;}
      if(time<start-DAY||time>=through)continue;
      const key=String(row.node_id||row.sensor_name||'recorded-device');
      if(!streams.has(key))streams.set(key,new Map());
      const groups=streams.get(key);if(!groups.has(time))groups.set(time,[]);groups.get(time).push(row);
    }
    const changes=new Map([[start,[]],[through,[]]]);let sequence=0;
    const edge=(time,event)=>{if(!changes.has(time))changes.set(time,[]);changes.get(time).push(event);};
    for(const groups of streams.values()){
      const stamps=[...groups.keys()].sort((a,b)=>a-b);
      stamps.forEach((time,index)=>{
        const samples=groups.get(time),states=new Set(samples.map(feedback)),value=states.size===1?[...states][0]:null;
        const validCadences=samples.map(cadence),span=validCadences.every(Boolean)?Math.min(...validCadences):0;
        if(time>=start){if(!points.has(time))points.set(time,[]);points.get(time).push(value);}
        const from=Math.max(start,time),to=Math.min(through,time+span,stamps[index+1]??through);
        if(to<=from)return;
        const id=sequence++;edge(from,{id,value});edge(to,{id,remove:true});
      });
    }
    const times=[...changes.keys()].sort((a,b)=>a-b),active=new Map(),segments=[];
    for(let index=0;index<times.length-1;index++){
      const from=times[index],to=times[index+1];
      for(const event of changes.get(from)){if(event.remove)active.delete(event.id);else active.set(event.id,event.value);}
      const known=new Set([...active.values()].filter(value=>typeof value==='boolean'));
      const state=known.size===1?([...known][0]?'on':'off'):'unknown',previous=segments.at(-1);
      if(previous?.state===state && previous.to===from)previous.to=to;else segments.push({from,to,state});
    }
    const on=segments.filter(segment=>segment.state==='on'),off=segments.filter(segment=>segment.state==='off');
    const knownSeconds=[...on,...off].reduce((sum,segment)=>sum+(segment.to-segment.from)/1000,0);
    const events=segments.map(segment=>({...segment,seconds:(segment.to-segment.from)/1000,source:segment.state==='unknown'?'Readings missing or unconfirmed':'Power feedback'}));
    // Isolated feedback points are visible, but never invent a duration when cadence is missing.
    for(const [time,values] of points){
      const states=new Set(values.filter(value=>typeof value==='boolean'));
      if(states.size!==1)continue;
      const state=[...states][0]?'on':'off';
      if(!segments.some(segment=>segment.state===state && segment.from<=time && segment.to>time))events.push({from:time,to:time,state,seconds:null,source:'Power feedback · cadence unavailable'});
    }
    events.sort((a,b)=>a.from-b.from || Number(a.state==='unknown')-Number(b.state==='unknown'));
    const firstOn=events.find(event=>event.state==='on')?.from??null,lastOff=events.filter(event=>event.state==='off').at(-1)?.from??null;
    return {date,start,end,through,segments,events,firstOn,lastOff,onSeconds:knownSeconds?on.reduce((sum,segment)=>sum+(segment.to-segment.from)/1000,0):null,knownSeconds,discarded};
  }
  function backend(){
    const value=new URL(root.ECOTRACK_CONFIG?.backendUrl||root.electron?.env?.BACKEND_URL||'http://localhost:5000');
    if(!['http:','https:'].includes(value.protocol)||!['localhost','127.0.0.1','[::1]'].includes(value.hostname))throw Error('AC power history requires the local backend.');
    return value.origin;
  }
  async function read(path,signal){
    const abort=new AbortController(),cancel=()=>abort.abort();
    if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
    signal?.addEventListener('abort',cancel,{once:true});const timer=setTimeout(cancel,10000);
    try{const response=await root.fetch(backend()+path,{signal:abort.signal,cache:'no-store'});const data=await response.json();if(!response.ok)throw Error(data.error||'Power history could not be loaded.');return data;}
    catch(error){if(abort.signal.aborted&&!signal?.aborted)throw Error('Power history timed out. Refresh after the local backend reconnects.');throw error;}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
  }
  async function units(source,signal){
    if(source==='monitoring'){
      const data=await read('/api/monitoring/devices',signal),grouped=new Map();
      if(!Array.isArray(data.items))throw Error('The monitoring registry returned an invalid response.');
      for(const node of data.items.filter(node=>node.active)){
        const id=node.aircon_id||node.id;if(!id)continue;
        if(!grouped.has(id))grouped.set(id,{id,airconId:node.aircon_id,name:node.aircon_name||node.name,nodeIds:[]});grouped.get(id).nodeIds.push(node.id);
      }
      return [...grouped.values()];
    }
    let metadata=null,timer;
    if(root.electron?.invoke){try{metadata=await Promise.race([root.electron.invoke('scheduler-fetch-data'),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),4000);})]);}catch(_){}finally{clearTimeout(timer);}}
    if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
    const nodes=metadata?.success?metadata.nodes:root.EcoTrackAirconSystem?.NodeService?.getDevices?.()||[];
    const profiles=metadata?.success?metadata.aircons:root.EcoTrackAirconSystem?.AirconProfileManager?.getAll?.()||[];
    const result=nodes.filter(node=>node.device_mode!=='monitoring').map(node=>{
      const id=node.db_id||node.id,aliases=[...new Set([id,node.id,node.node_id].filter(Boolean))];
      const matches=profiles.filter(ac=>ac.controller_node_id?ac.controller_node_id===id:aliases.includes(ac.node_id));
      const profile=matches.length===1?matches[0]:null;
      return {id,name:profile?.name||node.name||id,airconId:profile?.aircon_id||profile?.id,nodeIds:aliases,monitoringId:node.monitoring_id};
    }).filter(unit=>unit.id);
    if(!metadata?.success && !result.length)throw Error('Registered AC devices are unavailable. Refresh after the database reconnects.');
    return result;
  }
  async function monitoringRows(unit,date,signal,now){
    const from=dayStart(date)-DAY,to=Math.min(dayStart(date)+DAY,now);if(to<=from)return [];
    const params=new URLSearchParams({from:new Date(from).toISOString(),to:new Date(to).toISOString(),per_page:'200'});
    if(unit.airconId)params.set('aircon_id',unit.airconId);else params.set('node_id',unit.monitoringId||unit.nodeIds[0]);
    const rows=new Map();let total=null;
    for(let page=1;page<=1000;page++){
      params.set('page',String(page));const result=await read('/api/monitoring/telemetry?'+params,signal);
      if(!Array.isArray(result.items)||!Number.isInteger(result.total)||result.total<0)throw Error('The power history response is invalid.');
      if(total!==null && total!==result.total)throw Error('History changed while loading. Refresh to read a complete day.');total=result.total;
      for(const row of result.items){if(!row.id)throw Error('A feedback record has no identity.');rows.set(row.id,row);}
      if(page*200>=total){if(rows.size!==total)throw Error('History changed while loading. Refresh to read a complete day.');return [...rows.values()];}
      if(!result.items.length)throw Error('Power history is incomplete. Refresh and retry.');
    }
    throw Error('This history is too large to load completely. Select a single AC device.');
  }
  async function records(source,unit,date,signal,now){
    if(source==='monitoring')return monitoringRows(unit,date,signal,now);
    const clauses=unit.nodeIds.map(id=>'node_id = '+JSON.stringify(id));
    if(unit.airconId)clauses.push('aircon_id = '+JSON.stringify(unit.airconId));
    const data=await read('/api/telemetry?'+new URLSearchParams({perPage:'0',sort:'created',filter:'('+clauses.join(' || ')+')'}),signal);
    if(!Array.isArray(data.items)||data.items.length!==data.totalItems)throw Error('The controller history is incomplete. Refresh and retry.');
    let rows=data.items.filter(row=>!unit.airconId||!row.aircon_id||row.aircon_id===unit.airconId);
    if(unit.monitoringId){
      // A Both-role ESP32 can report physical power through its explicitly linked monitor.
      const linked=await monitoringRows({...unit,nodeIds:[unit.monitoringId]},date,signal,now);
      rows=[...rows,...linked];
    }
    return rows;
  }
  function mount(host,{source='monitoring',getNodeFilter=()=>''}={}){
    let date=today(),unitId='',page=1,revision=0,abort=null,disposed=false,last=null;
    host.classList.add('aph-panel');host.setAttribute('aria-label','Daily AC ON/OFF history');
    host.innerHTML='<div class="aph-heading"><div><h2>AC Operating History</h2><p>Recorded power feedback · UTC+08:00</p></div><span class="aph-chip">ON/OFF history</span></div><div class="aph-controls"><label>AC unit<select data-aph="unit" aria-label="AC history unit"><option value="">Loading devices…</option></select></label><div class="aph-date"><button type="button" data-aph="previous" aria-label="Previous history day">‹</button><label>Date<input data-aph="date" type="date" aria-label="AC history date" value="'+date+'" max="'+date+'"></label><button type="button" data-aph="next" aria-label="Next history day">›</button></div><button type="button" data-aph="refresh">Refresh</button></div><div data-aph="result" aria-live="polite"></div>';
    const find=id=>host.querySelector('[data-aph="'+id+'"]');
    find('unit').id='aph-unit-'+(++viewSequence);
    const message=text=>{last=null;find('result').innerHTML='<div class="aph-message" role="status">'+esc(text)+'</div>';};
    function paint(){
      const result=last;if(!result)return;
      const bars=result.segments.map(segment=>'<span tabindex="0" class="aph-segment '+segment.state+'" style="left:'+((segment.from-result.start)/DAY*100)+'%;width:'+((segment.to-segment.from)/DAY*100)+'%" aria-label="'+esc(segment.state==='unknown'?'No data':segment.state.toUpperCase())+' '+clock(segment.from)+' to '+clock(segment.to)+'" title="'+esc((segment.state==='unknown'?'No data':segment.state.toUpperCase())+' · '+clock(segment.from)+'–'+clock(segment.to))+'"></span>').join('');
      const events=result.events.slice((page-1)*50,page*50),stateName=state=>({on:'ON',off:'OFF',unknown:'No data'}[state]);
      const summary=[['First confirmed ON',clock(result.firstOn)],['Last confirmed OFF',clock(result.lastOff)],['Confirmed ON time',duration(result.onSeconds)]];
      find('result').innerHTML='<div class="aph-summary">'+summary.map(([label,value])=>'<section><h3>'+label+'</h3><strong>'+value+'</strong></section>').join('')+'</div><div class="aph-chart" role="group" aria-label="24-hour AC power timeline"><div class="aph-track">'+bars+(result.through<result.end?'<span class="aph-segment future" style="left:'+((result.through-result.start)/DAY*100)+'%;width:'+((result.end-result.through)/DAY*100)+'%" title="Not elapsed"></span>':'')+'</div><div class="aph-ticks">'+['00:00','04:00','08:00','12:00','16:00','20:00','24:00'].map(text=>'<span>'+text+'</span>').join('')+'</div></div><div class="aph-legend"><span><i class="on"></i>Confirmed ON</span><span><i class="off"></i>Confirmed OFF</span><span><i class="unknown"></i>No data</span>'+(result.through<result.end?'<span><i class="future"></i>Not elapsed</span>':'')+'</div><div class="aph-table-scroll" tabindex="0" role="region" aria-label="Power feedback event table"><table><thead><tr><th>Time</th><th>Event</th><th>Source</th><th>Covered duration</th></tr></thead><tbody>'+events.map(event=>'<tr><td>'+clock(event.from)+'</td><td><span class="aph-state '+event.state+'">'+stateName(event.state)+'</span></td><td>'+esc(event.source)+'</td><td>'+duration(event.seconds)+'</td></tr>').join('')+'</tbody></table></div><div class="aph-foot"><span>'+duration(result.onSeconds)+' confirmed ON · gaps excluded'+(result.discarded?' · Some timestamps unavailable':'')+'</span><div><button type="button" data-aph="prevPage" '+(page<=1?'disabled':'')+'>Previous</button><span>'+page+' / '+Math.max(1,Math.ceil(result.events.length/50))+'</span><button type="button" data-aph="nextPage" '+(page*50>=result.events.length?'disabled':'')+'>Next</button></div></div>';
      find('prevPage').onclick=()=>{page--;paint();};find('nextPage').onclick=()=>{page++;paint();};
    }
    async function refresh(){
      abort?.abort();abort=new AbortController();const signal=abort.signal,request=++revision;page=1;last=null;
      host.setAttribute('aria-busy','true');find('refresh').disabled=true;
      find('result').innerHTML='<div class="aph-loading" role="status" aria-label="Loading AC power history"><div class="aph-loading-cards">'+[1,2,3].map(()=>'<div class="eco-skeleton"></div>').join('')+'</div><div class="eco-skeleton aph-loading-bar"></div></div>';
      try{
        find('date').max=today();date=find('date').value;dayStart(date);if(date>today())throw Error('Choose today or an earlier history date.');
        const list=await units(source,signal);if(request!==revision||disposed)return;
        const filter=getNodeFilter(),filtered=filter?list.filter(unit=>unit.nodeIds.includes(filter)):list;
        find('unit').innerHTML=filtered.length?filtered.map(unit=>'<option value="'+esc(unit.id)+'">'+esc(unit.name)+'</option>').join(''):'<option value="">No registered AC units</option>';
        const chosen=filtered.find(unit=>unit.id===unitId)||filtered[0];unitId=chosen?.id||'';find('unit').value=unitId;
        if(!chosen){message('No registered AC units are available for this selection.');return;}
        const now=Date.now(),rows=await records(source,chosen,date,signal,now);if(request!==revision||disposed)return;
        last=analyze(rows,date,now);paint();
      }catch(error){if(request===revision&&!disposed&&!signal.aborted)message(error.message||'Power history is unavailable. Refresh and retry.');else if(request===revision&&!disposed)message('Power history timed out. Refresh and retry.');}
      finally{if(request===revision&&!disposed){host.setAttribute('aria-busy','false');find('refresh').disabled=false;find('next').disabled=date>=today();}}
    }
    find('unit').onchange=()=>{unitId=find('unit').value;void refresh();};find('date').onchange=()=>void refresh();find('refresh').onclick=()=>void refresh();
    find('previous').onclick=()=>{find('date').value=dateAfter(date,-1);void refresh();};find('next').onclick=()=>{if(date<today()){find('date').value=dateAfter(date,1);void refresh();}};
    return {refresh,dispose(){disposed=true;++revision;abort?.abort();}};
  }
  function openModal(button,{source=button?.dataset.powerHistorySource||'controller',getNodeFilter=()=>''}={}){
    if(root.document.getElementById('acPowerHistoryDialog'))return;
    const prior=root.document.activeElement,dialog=root.document.createElement('dialog');dialog.id='acPowerHistoryDialog';dialog.className='aph-dialog';dialog.setAttribute('aria-labelledby','aphDialogTitle');
    const panelId=source==='monitoring'?'monitoringPowerHistory':'controllerPowerHistory';
    dialog.innerHTML='<div class="aph-modal-heading"><h2 id="aphDialogTitle">Daily ON/OFF History</h2><button type="button" aria-label="Close power history">×</button></div><div class="aph-modal-body"><div id="'+panelId+'"></div></div><footer><button type="button">Close</button></footer>';
    root.document.body.appendChild(dialog);const view=mount(dialog.querySelector('#'+panelId),{source,getNodeFilter});
    const close=()=>{view.dispose();dialog.close();dialog.remove();(prior||button)?.focus();};
    dialog.querySelector('.aph-modal-heading button').onclick=close;dialog.querySelector('footer button').onclick=close;dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    dialog.addEventListener('click',event=>{if(event.target===dialog){const box=dialog.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)close();}});
    dialog.showModal();void view.refresh();
  }
  root.EcoTrackPowerHistory=Object.freeze({analyze,feedback,cadence,dayStart,today,mount,openModal});
  root.document?.addEventListener('DOMContentLoaded',()=>{const button=root.document.getElementById('openAcPowerHistoryBtn');button?.addEventListener('click',()=>openModal(button,{getNodeFilter:()=>root.document.getElementById('sensorSelect')?.value||''}));});
})(typeof window==='undefined'?globalThis:window);
