const fs=require('node:fs'),assert=require('node:assert/strict');
const {PGlite}=require('../scratch/cloud-db-test-runtime/node_modules/@electric-sql/pglite');
const delivery=fs.readFileSync('reports/multi-brand-capabilities/APPLY_SUPABASE.sql','utf8');
async function fixture(prefix){
 const db=new PGlite(),previous=fs.readFileSync('scripts/test_cloud_hardware_database.js','utf8');
 await db.exec(previous.slice(previous.indexOf(' await db.exec(`')+16,previous.indexOf('`);')));
 await db.exec(`ALTER TABLE nodes ADD COLUMN protocol_name text;
 ALTER TABLE aircons ALTER COLUMN id SET DEFAULT ('ac_'||gen_random_uuid());
 ALTER TABLE aircons ADD COLUMN asset_tag text UNIQUE,ADD COLUMN brand text NOT NULL DEFAULT 'Unspecified',
 ADD COLUMN model text,ADD COLUMN aircon_type text,ADD COLUMN room_id text REFERENCES rooms(id),
 ADD COLUMN protocol text,ADD COLUMN protocol_name text,ADD COLUMN status text,
 ADD COLUMN updated_at timestamptz DEFAULT now(),ADD COLUMN name text;`);
 for(const file of ['supabase_cloud_hardware_migration.sql','supabase_ir_realtime_migration.sql','supabase_controller_registration_migration.sql'])await db.exec(fs.readFileSync(file,'utf8'));
 const call=async(name,args)=>(await db.query('SELECT public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') AS value',args)).rows[0].value;
 const device='esp32s3-9cd20604a7ac',prepared=await call('ecotrack_prepare_controller_registration',[device]);
 await call('ecotrack_device_exchange',[device,prepared.device_token,{capabilities:{ir_receiver:true,ir_transmitter:true}},null]);
 const saved=await call('ecotrack_finish_controller_registration',[prepared.node.id,device,{controller_name:device,assignment_mode:'new',asset_tag:'AC-'+device,brand:'TCL',aircon_type:'Split Type (Inverter)',protocol_name:'TCL112AC',room_id:null}]);
 await db.query('UPDATE aircons SET name=asset_tag WHERE id=$1',[saved.aircon.id]);
 if(prefix)await db.exec(fs.readFileSync('supabase_controller_details_migration.sql','utf8'));
 return {db,device,aid:saved.aircon.id,nid:prepared.node.id};
}
async function main(){
 const checks=[];
 for(const prefix of [false,true]){
  const {db,aid,nid}=await fixture(prefix),label=prefix?'Previously committed old prefix':'Fresh feature migration';
  const columns=async()=>JSON.stringify((await db.query("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name IN('nodes','aircons') ORDER BY table_name,ordinal_position")).rows);
  const oldColumns=await columns();
  const oldAc=(await db.query('SELECT * FROM aircons WHERE id=$1',[aid])).rows[0];
  const oldCredentials=(await db.query('SELECT node_id,device_id,token_hash FROM ecotrack_private.device_credentials WHERE node_id=$1',[nid])).rows[0];
  const originalRpc=(await db.query("SELECT pg_get_functiondef('public.ecotrack_finish_controller_registration(text,text,jsonb)'::regprocedure) AS source")).rows[0].source;
  // Force a real PostgreSQL error after all five sections, including the Matrix UPDATE.
  // This detects any premature COMMIT; no source-string lock assertions stand in for it.
  const broken=delivery.replace(/\nCOMMIT;\s*$/,'\nSELECT 1/0;\nCOMMIT;\n');
  await assert.rejects(()=>db.exec(broken),error=>error.code==='22012');
  await db.exec('ROLLBACK;');
  assert.equal(await columns(),oldColumns);
  assert.deepEqual((await db.query('SELECT * FROM aircons WHERE id=$1',[aid])).rows[0],oldAc);
  assert.equal((await db.query("SELECT pg_get_functiondef('public.ecotrack_finish_controller_registration(text,text,jsonb)'::regprocedure) AS source")).rows[0].source,originalRpc);
  assert.deepEqual((await db.query('SELECT node_id,device_id,token_hash FROM ecotrack_private.device_credentials WHERE node_id=$1',[nid])).rows[0],oldCredentials);
  assert.equal((await db.query("SELECT to_regprocedure('public.ecotrack_verify_ac_capabilities(text,integer,jsonb)') AS fn")).rows[0].fn,null);
  checks.push(label+': a late failure rolls back schema, RPC replacements and Matrix data changes while retaining credentials.');
  await db.exec(delivery);await db.exec(delivery);
  const actual=(await db.query('SELECT id,name,brand,asset_tag,controller_node_id,protocol_name,capability_profile FROM aircons WHERE id=$1',[aid])).rows[0];
  assert.equal(actual.name,'Matrix');assert.equal(actual.brand,'Matrix');assert.equal(actual.id,aid);
  assert.equal(actual.asset_tag,oldAc.asset_tag);assert.equal(actual.controller_node_id,nid);assert.equal(actual.protocol_name,'TCL112AC');
  assert.deepEqual(actual.capability_profile,{});
  assert.deepEqual((await db.query('SELECT node_id,device_id,token_hash FROM ecotrack_private.device_credentials WHERE node_id=$1',[nid])).rows[0],oldCredentials);
  assert.equal((await db.query('SELECT count(*) n FROM aircons')).rows[0].n,1);
  checks.push(label+': retry and repeated successful execution preserve AC identity, assignments and credentials.');
  await db.close();
 }
 const empty=new PGlite();
 await assert.rejects(()=>empty.exec(delivery),/Install the existing EcoTrack schema/);
 await empty.exec('ROLLBACK;');
 assert.equal((await empty.query("SELECT count(*) n FROM pg_proc WHERE proname LIKE 'ecotrack_%'")).rows[0].n,0);
 await empty.close();
 checks.push('Missing prerequisites stop before installing functions or changing data.');
 fs.mkdirSync('reports/migration-deadlock',{recursive:true});
 fs.writeFileSync('reports/migration-deadlock/transaction-results.json',JSON.stringify({passed:checks.length,checks,actual_isolated_postgresql:true,multi_session_contention_tested:false,live_database_modified:false},null,2));
 console.log('Supabase delivery safety: '+checks.length+' actual PostgreSQL scenarios passed.');
}
main().catch(error=>{console.error(error);process.exit(1);});
