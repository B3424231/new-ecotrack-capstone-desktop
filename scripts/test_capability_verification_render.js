const {app,BrowserWindow,ipcMain}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {PGlite}=require('../scratch/cloud-db-test-runtime/node_modules/@electric-sql/pglite');
const root=path.resolve(__dirname,'..'),out=path.join(root,'reports/multi-brand-capabilities'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
app.setPath('userData',path.join(root,'scratch/capability-verification-electron'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 const db=new PGlite(),previous=read('scripts/test_cloud_hardware_database.js');await db.exec(previous.slice(previous.indexOf(' await db.exec(`')+16,previous.indexOf('`);')));
 await db.exec(`CREATE TABLE buildings(id text,name text);CREATE TABLE floors(id text,name text,building_id text);ALTER TABLE rooms ADD COLUMN IF NOT EXISTS name text,ADD COLUMN IF NOT EXISTS floor_id text;
 ALTER TABLE nodes ADD COLUMN protocol_name text;
 ALTER TABLE aircons ALTER COLUMN id SET DEFAULT ('ac_'||gen_random_uuid());
 ALTER TABLE aircons ADD COLUMN asset_tag text UNIQUE,ADD COLUMN brand text NOT NULL DEFAULT 'Unspecified',ADD COLUMN model text,ADD COLUMN aircon_type text,
 ADD COLUMN room_id text REFERENCES rooms(id),ADD COLUMN protocol text,ADD COLUMN protocol_name text,ADD COLUMN status text,ADD COLUMN updated_at timestamptz DEFAULT now();`);
 for(const f of ['supabase_cloud_hardware_migration.sql','supabase_ir_realtime_migration.sql','supabase_controller_registration_migration.sql','supabase_ac_capabilities_migration.sql','supabase_controller_details_migration.sql','supabase_aircon_names_migration.sql'])await db.exec(read(f));
 const call=async(name,args)=>(await db.query('SELECT public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') AS value',args)).rows[0].value;
 const id='esp32s3-001122334455',registered=await call('ecotrack_prepare_controller_registration',[id]),nid=registered.node.id;
 await call('ecotrack_device_exchange',[id,registered.device_token,{capabilities:{ir_receiver:true,ir_transmitter:true}},null]);
 const saved=await call('ecotrack_finish_controller_registration',[nid,id,{controller_name:'Office controller',assignment_mode:'new',asset_tag:'AC-Office',aircon_name:'Matrix',brand:'Matrix',aircon_type:'Split Type (Inverter)',protocol_name:'TCL112AC',room_id:null}]),aid=saved.aircon.id;
 await call('ecotrack_device_observe',[id,registered.device_token,{protocol:'TCL112AC',frame_kind:'full_state',raw_count:227,sequence:1,boot_count:1,state:{power:true,temp:25,mode:'cool',fan:'high',turbo:false,source:'ir_receiver'}}]);
 ipcMain.handle('capability-fixture-read',async(_e,table)=>{if(!['aircons','nodes','rooms','floors','buildings','ecotrack_device_state'].includes(table))throw Error('Unexpected fixture table');return (await db.query('SELECT * FROM public.'+table)).rows;});
 ipcMain.handle('capability-fixture-verify',(_e,args)=>call('ecotrack_verify_ac_capabilities',[args.p_aircon_id,args.p_expected_revision,args.p_profile]));
 ipcMain.handle('capability-fixture-edit',async(_e,args)=>{try{return {data:await call('ecotrack_admin_edit_controller',[args.p_node_id,args.p_changes]),error:null};}catch(error){return {data:null,error:{message:error.message,code:error.code}};}});
 ipcMain.handle('capability-fixture-control',(_e,payload)=>call('ecotrack_cloud_request',[nid,'ac_intent',payload,require('node:crypto').randomUUID()]));
 fs.mkdirSync(out,{recursive:true});fs.mkdirSync(path.join(root,'scratch'),{recursive:true});
 const preload=path.join(root,'scratch/capability-verification-preload.cjs');
 fs.writeFileSync(preload,"const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('fixtureApi',{read:t=>ipcRenderer.invoke('capability-fixture-read',t),verify:a=>ipcRenderer.invoke('capability-fixture-verify',a),edit:a=>ipcRenderer.invoke('capability-fixture-edit',a),control:p=>ipcRenderer.invoke('capability-fixture-control',p)});");
 const file=path.join(root,'scratch/capability-verification-fixture.html');fs.writeFileSync(file,'<!doctype html><html><head><meta charset="utf-8"><style>'+read('public/styles.css')+'</style></head><body><main style="margin:30px"><h1>AC capability verification</h1><p id="anchor">Matrix</p></main></body></html>');
 const win=new BrowserWindow({width:980,height:850,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,preload}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error'&&!e.message.includes('Content Security Policy')){errors.push(e.message);console.error('Renderer: '+e.message);}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_d,done)=>done({cancel:true}));await win.loadFile(file);
 await win.webContents.executeJavaScript(`
 localStorage.clear();
 window.supabaseClient={from(table){const filters=[];const q={select(){return q},order(){return q},eq(k,v){filters.push([k,v]);return q},async result(){return {data:(await fixtureApi.read(table)).filter(row=>filters.every(([k,v])=>row[k]===v)),error:null}},async maybeSingle(){const r=await q.result();return {...r,data:r.data[0]||null}},then(a,b){return q.result().then(a,b)}};return q;},
 async rpc(name,args){if(window.fixtureFail)throw Error('Supabase temporarily unavailable');if(name==='ecotrack_admin_edit_controller')return fixtureApi.edit(args);if(name!=='ecotrack_verify_ac_capabilities')throw Error('Unexpected RPC');return {data:await fixtureApi.verify(args),error:null};}};
 window.EcoTrackHardwareCloud={listStatus:async()=> (await fixtureApi.read('ecotrack_device_state')).map(row=>({...row,connection_status:'online'})),describe:()=> 'online',
 control:async(_node,payload)=>{const result=await fixtureApi.control(payload);return {command_id:result.id,commanded_at:result.created_at};}};
 `+read('public/js/aircon-system.js')+'\ntrue;');
 await win.webContents.executeJavaScript(`(async()=>{await EcoTrackAirconSystem.syncWithDatabase();const until=Date.now()+6000;while(!EcoTrackAirconSystem.AirconProfileManager.getById('AC-Office')){if(Date.now()>until)throw Error('Initial AC sync did not complete');await new Promise(r=>setTimeout(r,20));}return true;})()`);
 const checks=[];
 let result=await win.webContents.executeJavaScript("({panel:!!document.querySelector('.ac-capability-summary'),dialog:!!document.querySelector('dialog'),api:typeof window.EcoTrackCapabilityVerification})");
 assert(!result.panel&&!result.dialog);assert.equal(result.api,'undefined');
 checks.push('The removed verification component is absent; existing capability data and engine remain available.');
 // The normal command path still uses the real SQL RPC and cannot invent physical verification.
 await win.webContents.executeJavaScript("(async()=>{const result=await EcoTrackAirconSystem.CommandManager.dispatch({device_id:'AC-Office',command:'TURBO',value:true});if(!result.success)throw Error(result.message);return true;})()");
 let stored=(await db.query('SELECT capability_profile FROM aircons WHERE id=$1',[aid])).rows[0].capability_profile;
 assert.deepEqual(stored,{});assert.equal((await db.query('SELECT count(*) n FROM ecotrack_device_commands WHERE kind=\'ac_intent\'')).rows[0].n,1);
 checks.push('Normal control still queues an actual SQL-validated command without automatically marking physical support.');
 await win.webContents.executeJavaScript(`(async()=>{await EcoTrackAirconSystem.CapabilityEngine.verify('AC-Office',{protocol:'TCL112AC',remote_model:null,model_verified:false,ac_model:'',features:{turbo:{status:'verified_unsupported'}},options:{mode:{},fan:{}}},0);return true;})()`);
 stored=(await db.query('SELECT capability_profile,name,brand FROM aircons WHERE id=$1',[aid])).rows[0];
 assert.equal(stored.capability_profile.features.turbo.status,'verified_unsupported');assert.equal(stored.name,'Matrix');assert.equal(stored.brand,'Matrix');
 result=await win.webContents.executeJavaScript("({turbo:EcoTrackAirconSystem.CapabilityEngine.getCapabilities(EcoTrackAirconSystem.AirconProfileManager.getById('AC-Office')).turbo})");
 assert.equal(result.turbo,false);
 checks.push('Existing backend capability persistence still updates shared controls and preserves the custom name and manufacturer.');
 result=await win.webContents.executeJavaScript(`(async()=>{window.fixtureFail=true;try{await EcoTrackAirconSystem.CapabilityEngine.verify('AC-Office',{protocol:'TCL112AC',remote_model:null,model_verified:false,ac_model:'',features:{},options:{mode:{},fan:{}}},1);return {accepted:true};}catch(error){return {accepted:false,message:error.message};}finally{window.fixtureFail=false;}})()`);
 assert.equal(result.accepted,false);assert(result.message.includes('unavailable'));
 assert.equal((await db.query('SELECT capability_profile FROM aircons WHERE id=$1',[aid])).rows[0].capability_profile.revision,1);
 checks.push('Backend errors remain visible to callers and cannot mutate already saved results.');
 await win.webContents.executeJavaScript(`(async()=>{await EcoTrackAirconSystem.NodeService.editDevice('esp32s3-001122334455',{name:'Hall controller',aircon_name:'Matrix Hall',room_id:null,brand:'Matrix',aircon_type:'Split Type (Inverter)',protocol_name:'TCL112AC'});return true;})()`);
 result=await win.webContents.executeJavaScript("({controller:EcoTrackAirconSystem.NodeService.getNode('esp32s3-001122334455').name,ac:EcoTrackAirconSystem.AirconProfileManager.getById('AC-Office').name,binding:EcoTrackAirconSystem.AirconProfileManager.getById('AC-Office').node_id,turbo:EcoTrackAirconSystem.AirconProfileManager.getById('AC-Office').capabilities.turbo})");
 assert.equal(result.controller,'Hall controller');assert.equal(result.ac,'Matrix Hall');assert.equal(result.binding,id);assert.equal(result.turbo,false);
 result=await win.webContents.executeJavaScript(`(async()=>{try{await EcoTrackAirconSystem.NodeService.editDevice('esp32s3-001122334455',{name:'Should not save',aircon_name:'<invalid>',room_id:null,brand:'Matrix',aircon_type:'Split Type (Inverter)',protocol_name:'TCL112AC'});throw Error('Expected rejection');}catch(error){return {error:error.message,name:EcoTrackAirconSystem.NodeService.getNode('esp32s3-001122334455').name};}})()`);
 assert(result.error.includes('air conditioner name'));assert.equal(result.name,'Hall controller');assert.equal((await db.query('SELECT name FROM nodes WHERE id=$1',[nid])).rows[0].name,'Hall controller');
 checks.push('Shared controller edit persists distinct controller/AC names atomically, keeps bindings and verification, and rolls back invalid edits.');
 assert.deepEqual(errors,[]);win.destroy();await db.close();
 fs.writeFileSync(path.join(out,'verification-native-results.json'),JSON.stringify({passed:checks.length,checks,actual_isolated_postgresql:true,physical_hardware_tested:false},null,2));console.log('Retained capability backend: '+checks.length+' native/PostgreSQL scenarios passed.');app.exit(0);
}).catch(e=>{console.error(e);app.exit(1);});
