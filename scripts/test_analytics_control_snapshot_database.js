'use strict';
// Actual trigger integration in disposable PostgreSQL; never sends hardware commands or connects to production.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const {PGlite}=require(path.join(root,'scratch/cloud-db-test-runtime/node_modules/@electric-sql/pglite'));
const read=file=>fs.readFileSync(path.join(root,file),'utf8').replace(/^\uFEFF/,'');
async function main(){
 const db=new PGlite(),checks=[];
 try{
  const setup=read('scripts/test_cloud_hardware_database.js').match(/await db.exec\(`([\s\S]*?)`\);/)[1];
  await db.exec(setup);
  await db.exec('ALTER TABLE telemetry ADD COLUMN floor_name text, ADD COLUMN building_name text');
  await db.exec(read('supabase_cloud_hardware_migration.sql'));
  await db.exec(read('supabase_ac_recording_migration.sql'));
  await db.exec(read('scripts/fixtures/analytics-control-snapshot-legacy.sql'));
  await db.exec('CREATE TRIGGER ecotrack_telemetry_control_snapshot BEFORE INSERT ON telemetry FOR EACH ROW EXECUTE FUNCTION public.ecotrack_snapshot_aircon_control()');
  const call=async(name,args)=>(await db.query('SELECT public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') AS value',args)).rows[0].value;
  const device=await call('ecotrack_register_cloud_device',['esp32s3-001122334455',{}]);
  const controls={power:true,temp:24,mode:'cool',fan:'medium',eco:false,turbo:true,swing:true,
   swing_vertical:true,swing_horizontal:false,quiet:false,display:true,filter:false,sleep:false,clean:false,beep:false,i_feel:false};
  await db.query("INSERT INTO aircons(id,node_id,desired_state,commanded_at,command_status) VALUES('ac-one',$1,$2,clock_timestamp()-interval '1 minute','transmitted')",[device.node.id,controls]);
  let seq=0;
  const frame=state=>({protocol:'TCL112AC',raw_data:'3500,1750,450',raw_count:3,frame_kind:'full_state',
   sequence:++seq,state:{...state,source:'ir_receiver'},field_at:{temp:'2020-01-01T00:00:00Z'}});
  const exchange=latest=>call('ecotrack_device_exchange',[device.device_id,device.device_token,
   {capabilities:{ir_receiver:true,ir_transmitter:true},rssi:-62,report_id:device.device_id+'-1-'+seq,latest_ir:latest},null]);
  const newest=async()=>(await db.query('SELECT * FROM telemetry ORDER BY created DESC,id DESC LIMIT 1')).rows[0];
  await exchange(frame(controls));
  const broken=await newest();
  assert.equal(broken.control_snapshot.observed_remote_state,undefined);
  checks.push('Reproduced the deployed trigger order: the legacy snapshot function erased decoded IR fields.');
  const migration=read('supabase_analytics_control_snapshot_migration.sql');
  await db.exec(migration);await db.exec(migration);
  checks.push('The guarded migration applies twice with existing triggers and without clearing any history.');
  await exchange(frame(controls));
  let row=await newest();
  assert.deepEqual(row.control_snapshot.observed_remote_state,{...controls,source:'ir_receiver'});
  assert.deepEqual(row.control_snapshot.desired_state,controls);
  assert.equal(row.aircon_id,'ac-one');assert.equal(row.ac_on,null);assert.equal(row.temperature,null);assert.equal(row.battery,null);
  assert(row.control_snapshot.observed_remote_field_at.eco);
  assert.equal(row.control_snapshot.observed_remote_field_at.temp,'2020-01-01T00:00:00Z');
  checks.push('Temperature setpoint, operating mode, blower fan and every recorded special-function key survive; false flags and per-field timestamps remain explicit.');
  const savedId=row.id,originalSnapshot=row.control_snapshot;
  for(const change of [{temp:22},{mode:'dry'},{fan:'quiet'},{eco:true,turbo:false,display:false,swing_horizontal:true}]){
   await exchange(frame({...controls,...change}));row=await newest();
   for(const [field,value] of Object.entries(change))assert.equal(row.control_snapshot.observed_remote_state[field],value);
  }
  assert.deepEqual((await db.query('SELECT control_snapshot FROM telemetry WHERE id=$1',[savedId])).rows[0].control_snapshot,originalSnapshot);
  checks.push('Successive IR setting changes produce distinct historical snapshots; later settings do not rewrite older readings.');
  const historical={desired_state:{power:true,temp:19,mode:'fan',fan:'low',eco:false},commanded_at:'2000-01-01T00:00:00Z'};
  await db.query("INSERT INTO telemetry(id,node_id,created,status,control_snapshot,aircon_id) VALUES('historical',$1,'2000-01-02','online',$2,'ac-one')",[device.node.id,historical]);
  assert.deepEqual((await db.query("SELECT control_snapshot FROM telemetry WHERE id='historical'")).rows[0].control_snapshot,historical);
  checks.push('An explicit imported historical snapshot is retained verbatim, rather than replaced with current Supabase settings.');
  await db.query("INSERT INTO telemetry(id,node_id,created,status,ac_on) VALUES('backfilled',$1,'1999-01-01','online',true)",[device.node.id]);
  const backfill=(await db.query("SELECT * FROM telemetry WHERE id='backfilled'")).rows[0];
  assert.equal(backfill.control_snapshot.desired_state,undefined);
  assert.equal(backfill.control_snapshot.observed_remote_state,undefined);
  assert.equal(backfill.ac_on,true);
  checks.push('Current commands and future IR observations are not attached to a backdated sample; supplied physical feedback stays intact.');
  const retained=frame(controls);
  await exchange({...retained,frame_kind:'settings_only',state:undefined,last_decoded:retained});
  assert.deepEqual((await newest()).control_snapshot.observed_remote_state,retained.state);
  checks.push('Legacy auxiliary packets retain their last actual decoded AC state, without treating raw noise as settings.');
  const beforeOff=(await db.query('SELECT count(*)::int AS count FROM telemetry')).rows[0].count;
  await exchange(frame({...controls,power:false}));
  assert.equal((await db.query('SELECT count(*)::int AS count FROM telemetry')).rows[0].count,beforeOff);
  assert.equal((await db.query('SELECT status FROM nodes WHERE id=$1',[device.node.id])).rows[0].status,'online');
  checks.push('OFF recording policy and controller heartbeat remain unchanged; no physical ON state is invented.');
  await db.query("INSERT INTO aircons(id,node_id) VALUES('ambiguous-ac',$1)",[device.node.id]);
  await db.query("INSERT INTO telemetry(id,node_id,status,created,ac_on) VALUES('ambiguous',$1,'online',clock_timestamp(),true)",[device.node.id]);
  const ambiguous=(await db.query("SELECT * FROM telemetry WHERE id='ambiguous'")).rows[0];
  assert.equal(ambiguous.aircon_id,null);assert.equal(ambiguous.control_snapshot,null);
  assert.equal(ambiguous.ac_on,true);
  checks.push('Ambiguous AC bindings stay unassigned instead of attaching another AC\'s controls.');
  const report={passed:checks.length,checks,engine:'PGlite PostgreSQL',live_supabase_modified:false,
   cloudFixture:(await db.query('SELECT * FROM telemetry WHERE id=$1',[savedId])).rows[0]};
  if(process.env.ECOTRACK_ANALYTICS_TEST_OUTPUT)fs.writeFileSync(process.env.ECOTRACK_ANALYTICS_TEST_OUTPUT,JSON.stringify(report,null,2));
  console.log('Analytics control snapshot: '+checks.length+' integration scenarios passed.');
 }finally{await db.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
