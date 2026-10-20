const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const data=JSON.parse(fs.readFileSync('config/ac-capabilities.json','utf8')),context={window:{}};
vm.runInNewContext(fs.readFileSync('public/js/ac-capability-registry.source.js','utf8').replace('/* AC_CAPABILITY_DATA */ {}',JSON.stringify(data))+';globalThis.caps=AcCapabilityRegistry;',context);
vm.runInNewContext(fs.readFileSync('public/js/aircon-state.js','utf8'),context);
const r=context.caps,h=context.window.EcoTrackAirconState,checks=[];
for(const [name,profile] of Object.entries(data.protocols)){
 assert.equal(r.protocol(name),name);
 const models=Object.keys(profile.models||{}).map(Number),unit={protocol_name:name,remote_model:models[0]||null,state:{mode:'cool'}},resolved=r.resolve(unit);
 const range=r.range(unit,'cool');
 assert.equal(resolved.feature_status.power.status,'library_unverified');
 if(resolved.can_transmit){assert(r.validateTemperature(unit,range.min,'cool').valid);assert(r.validateTemperature(unit,range.max,'cool').valid);assert(!r.validateTemperature(unit,range.min-range.step,'cool').valid);assert(!r.validateTemperature(unit,range.min+range.step/2,'cool').valid);}
}
checks.push('All 18 exact protocols resolve and validate audited boundaries and increments without clamping.');
assert.equal(r.protocol({brand:'TCL',model:'TCL',protocol_name:'UNKNOWN'}),'UNKNOWN');
assert.equal(r.resolve({brand:'Matrix',protocol_name:'TCL112AC'}).protocol,'TCL112AC');
assert.equal(r.resolve('TCL96AC').can_transmit,false);assert.equal(r.resolve('DAIKIN64').protocol,'DAIKIN64');
assert.equal(r.resolve({protocol_name:'FUJITSU_AC'}).can_transmit,false);
assert.equal(r.resolve({protocol_name:'FUJITSU_AC',remote_model:3}).features.turbo,true);
assert.equal(r.resolve({protocol_name:'FUJITSU_AC',remote_model:2}).features.turbo,false);
assert.equal(r.range({protocol_name:'WHIRLPOOL_AC',remote_model:2},'cool').min,16);
assert.equal(r.range({protocol_name:'WHIRLPOOL_AC',remote_model:1},'cool').min,18);
assert.equal(r.range('DAIKIN2','cool').min,18);assert.equal(r.range('DAIKIN2','heat').min,10);
assert.equal(r.range('TCL112AC','cool').step,.5);assert.equal(r.range({protocol_name:'FUJITSU_AC',remote_model:6},'cool').step,.5);
assert.equal(r.range({protocol_name:'FUJITSU_AC',remote_model:3},'cool').step,.25);
checks.push('Brand mismatches, exact variants, remote models, unknown-model fallback and mode-specific temperatures remain distinct.');
let unit={protocol_name:'TCL112AC',brand:'Matrix',capability_profile:{protocol:'TCL112AC',features:{turbo:{status:'verified_unsupported'}},temperature:{status:'verified_supported',min:18,max:30,step:1}},control_snapshot:{observed_remote_protocol:'TCL112AC',observed_remote_capabilities:{turbo:true}}};
assert.equal(r.resolve(unit).features.turbo,false);assert.equal(r.range(unit,'cool').min,18);
unit.control_snapshot.observed_remote_protocol='DAIKIN';
assert.equal(r.resolve(unit).verification_stale,true);assert.equal(r.range(unit,'cool').min,10);
assert.equal(r.resolve({...unit,protocol_name:'UNKNOWN',control_snapshot:{}}).features.turbo,false);
checks.push('Physical overrides outrank detection only for their matching identity; stale results do not leak into another protocol.');
const epoch=Date.now(),base=h.remoteObservation({protocol:'TCL112AC',frame_kind:'full_state',raw_count:227,sequence:1,captured_at_epoch_ms:epoch,state:{power:true,temp:25,mode:'cool',fan:'high',turbo:false}},new Date(epoch).toISOString());
const command={...base,desired_state:{power:'off',temp:25,mode:'cool',fan:'high'},commanded_at:new Date(epoch+2000).toISOString()};
const partial=h.remoteObservation({protocol:'TCL112AC',frame_kind:'partial_state',raw_count:80,sequence:2,captured_at_epoch_ms:epoch+3000,state:{quiet:true}},new Date(epoch+3000).toISOString(),command);
let selected=h.selectSettings({...command,...partial});assert.equal(selected.state.power,'off');assert.equal(selected.state.quiet,true);assert.equal(selected.source,'requested');
const cold=h.remoteObservation({protocol:'TCL112AC',frame_kind:'partial_state',raw_count:80,sequence:2,state:{power:true,temp:25,mode:'cool',fan:'high',quiet:true},field_at:{power:new Date(epoch).toISOString(),temp:new Date(epoch).toISOString(),mode:new Date(epoch).toISOString(),fan:new Date(epoch).toISOString(),quiet:new Date(epoch+3000).toISOString()},received_at:new Date(epoch+3000).toISOString()},new Date(epoch+3000).toISOString());
selected=h.selectSettings({...command,...cold});assert.equal(selected.state.power,'off');assert.equal(selected.state.quiet,true);
checks.push('Partial packets preserve reliable fields without replaying old power over a newer request, including cold reload from PostgreSQL field timestamps.');
fs.mkdirSync('reports/multi-brand-capabilities',{recursive:true});fs.writeFileSync('reports/multi-brand-capabilities/registry-results.json',JSON.stringify({passed:checks.length,checks},null,2));console.log('Multi-brand registry: '+checks.length+' scenario groups passed.');
