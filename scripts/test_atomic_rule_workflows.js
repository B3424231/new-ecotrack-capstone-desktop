'use strict';
// PostgreSQL transactions and authorization in memory. No live records or network.
const {test,before,after,beforeEach}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),{PGlite}=require('@electric-sql/pglite');
const api=require('../public/js/rule-persistence');let db;
before(async()=>{
 db=new PGlite();await db.exec(`
 CREATE ROLE anon;CREATE ROLE authenticated;CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 CREATE FUNCTION public.ecotrack_is_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT current_setting('request.jwt.claim.admin',true)='true' $$;
 CREATE TABLE nodes(id text PRIMARY KEY);
 CREATE TABLE rules(id text PRIMARY KEY DEFAULT 'rule_'||gen_random_uuid()::text,type text NOT NULL,condition text NOT NULL,value numeric NOT NULL,unit text NOT NULL,enabled boolean NOT NULL DEFAULT true,message text,duration integer DEFAULT 5,start_date text,start_time text,end_date text,end_time text,room_id text,building_id text,floor_id text,created timestamptz DEFAULT now(),updated timestamptz DEFAULT now());
 CREATE TABLE rule_nodes(id text PRIMARY KEY DEFAULT gen_random_uuid()::text,rule_id text REFERENCES rules(id),node_id text REFERENCES nodes(id) CHECK(node_id<>'rejected-node'),created timestamptz DEFAULT now(),updated timestamptz DEFAULT now());
 GRANT USAGE ON SCHEMA auth TO authenticated;GRANT SELECT ON nodes TO authenticated;GRANT SELECT,INSERT,UPDATE,DELETE ON rules,rule_nodes TO authenticated;
 ALTER TABLE nodes ENABLE ROW LEVEL SECURITY;ALTER TABLE rules ENABLE ROW LEVEL SECURITY;ALTER TABLE rule_nodes ENABLE ROW LEVEL SECURITY;
 CREATE POLICY node_admin ON nodes TO authenticated USING(ecotrack_is_admin());CREATE POLICY rule_admin ON rules TO authenticated USING(ecotrack_is_admin()) WITH CHECK(ecotrack_is_admin());CREATE POLICY links_admin ON rule_nodes TO authenticated USING(ecotrack_is_admin()) WITH CHECK(ecotrack_is_admin());
 INSERT INTO nodes VALUES('old-node'),('new-node'),('rejected-node');`);
 await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261020085939_atomic_rule_workflows.sql'),'utf8'));
});
beforeEach(async()=>{await db.exec(`RESET ROLE;SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);SELECT set_config('request.jwt.claim.admin','true',false);DELETE FROM rule_nodes;DELETE FROM rules;INSERT INTO rules(id,type,condition,value,unit) VALUES('existing-rule','temperature','above',30,'C'),('second-rule','temperature','above',31,'C');INSERT INTO rule_nodes(rule_id,node_id) VALUES('existing-rule','old-node');`);});
after(async()=>{await db?.close();});
const fields={type:'temperature',condition:'above',value:25,unit:'C',enabled:true,duration:5,room_id:null};
async function save(targets=['new-node'],id='existing-rule',rule=fields){return (await db.query('SELECT ecotrack_save_rule($1::jsonb,$2::text[],$3::text) AS receipt',[JSON.stringify(rule),targets,id])).rows[0].receipt;}
test('rule fields and replacement targets commit together with a complete receipt',async()=>{
 await db.exec('SET ROLE authenticated');const receipt=await save();assert.deepEqual(receipt,{rule_id:'existing-rule',target_nodes:['new-node']});
 assert.equal((await db.query("SELECT value::float FROM rules WHERE id='existing-rule'")).rows[0].value,25);
 assert.deepEqual((await db.query("SELECT node_id FROM rule_nodes WHERE rule_id='existing-rule'")).rows,[{node_id:'new-node'}]);
});
test('a rejected target insertion rolls back deleted links and edited rule fields',async()=>{
 await assert.rejects(save(['rejected-node']));
 assert.equal((await db.query("SELECT value::float FROM rules WHERE id='existing-rule'")).rows[0].value,30);
 assert.deepEqual((await db.query("SELECT node_id FROM rule_nodes WHERE rule_id='existing-rule'")).rows,[{node_id:'old-node'}]);
});
test('new rule creation is also rolled back if target persistence fails',async()=>{await assert.rejects(save(['rejected-node'],null));assert.equal((await db.query('SELECT count(*)::int AS n FROM rules')).rows[0].n,2);});
test('a new rule receives its canonical identity and targets in the same transaction',async()=>{
 await db.exec('SET ROLE authenticated');const receipt=await save(['new-node'],null);
 assert.match(receipt.rule_id,/^rule_/);assert.deepEqual(receipt.target_nodes,['new-node']);
 assert.equal((await db.query('SELECT value::float FROM rules WHERE id=$1',[receipt.rule_id])).rows[0].value,25);
 assert.deepEqual((await db.query('SELECT node_id FROM rule_nodes WHERE rule_id=$1',[receipt.rule_id])).rows,[{node_id:'new-node'}]);
});
test('missing devices and missing edited rules cannot remove prior assignments',async()=>{await assert.rejects(save(['missing-node']));await assert.rejects(save(['new-node'],'missing-rule'));assert.equal((await db.query('SELECT count(*)::int AS n FROM rule_nodes')).rows[0].n,1);});
test('an intentional room-wide empty selection is supported',async()=>{assert.deepEqual((await save([])).target_nodes,[]);});
test('duplicate targets are normalized and forbidden fields are rejected',async()=>{assert.deepEqual((await save(['new-node','new-node'])).target_nodes,['new-node']);await assert.rejects(save(['old-node'],null,{...fields,id:'injected-rule'}));});
test('anonymous and non-administrator sessions cannot mutate rules',async()=>{
 await db.exec('SET ROLE anon');await assert.rejects(save());await db.exec("RESET ROLE;SELECT set_config('request.jwt.claim.admin','false',false);SET ROLE authenticated");await assert.rejects(save());
});
test('the new functions use invoker privileges and deny anonymous execution',async()=>{
 const result=await db.query("SELECT proname,prosecdef,has_function_privilege('anon',oid,'EXECUTE') AS anon_access FROM pg_proc WHERE proname IN ('ecotrack_save_rule','ecotrack_set_rules_enabled')");
 assert.equal(result.rows.length,2);for(const row of result.rows){assert.equal(row.prosecdef,false);assert.equal(row.anon_access,false);}
});
test('bulk status changes are atomic if one selected rule is missing',async()=>{
 await assert.rejects(db.query('SELECT ecotrack_set_rules_enabled($1::text[],$2)',[['existing-rule','missing-rule'],false]));assert.equal((await db.query("SELECT enabled FROM rules WHERE id='existing-rule'")).rows[0].enabled,true);
});
test('bulk status success returns every changed identity and boolean',async()=>{
 await db.exec('SET ROLE authenticated');const data=(await db.query('SELECT ecotrack_set_rules_enabled($1::text[],$2) AS receipt',[['existing-rule','second-rule'],false])).rows[0].receipt;
 assert.equal(api.assertToggle(data,['existing-rule','second-rule'],false).length,2);
});
test('shared persistence rejects returned database errors and incomplete receipts',async()=>{
 await assert.rejects(api.save({rpc:async()=>({error:{message:'Denied'},data:null})},fields,['new-node']),/Denied/);
 await assert.rejects(api.save({rpc:async()=>({data:{rule_id:'existing-rule',target_nodes:[]}})},fields,['new-node'],'existing-rule'),/every selected device/);
 await assert.rejects(api.setEnabled({rpc:async()=>({data:[]})},['existing-rule'],false),/every rule status/);
});
