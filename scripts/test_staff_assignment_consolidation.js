'use strict';
// Real PostgreSQL semantics in memory; no network or production records.
const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const mobile=process.env.ECOTRACK_MOBILE_ROOT||path.resolve(root,'../EcoTrackAppMobileNew-master-control');
const {PGlite}=require(require.resolve('@electric-sql/pglite',{paths:[mobile]}));
const migration=fs.readFileSync(path.join(root,'supabase/migrations/20261019180417_consolidate_staff_assignments.sql'),'utf8');
let db;
const schema=`
 CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 CREATE TABLE public.buildings(id text PRIMARY KEY);
 CREATE TABLE public.aircons(id text PRIMARY KEY);
 CREATE TABLE public.floors(id text PRIMARY KEY,building_id text);
 CREATE TABLE public.rooms(id text PRIMARY KEY,floor_id text REFERENCES floors);
 CREATE TABLE public.staff(id text PRIMARY KEY,room_id text,assignment_scope text NOT NULL DEFAULT 'room',
  assigned_floor_id text,assigned_building_id text,is_active boolean DEFAULT true,is_archived boolean DEFAULT false,created timestamptz NOT NULL);
 CREATE TABLE public.registration_tasks(id text PRIMARY KEY);
 CREATE TABLE public.staff_locations(id text PRIMARY KEY,staff_id text);
 CREATE FUNCTION public.resolve_room_maintainer(p_room_id text) RETURNS text LANGUAGE plpgsql AS $$
 DECLARE result text; BEGIN SELECT staff_id INTO result FROM public.staff_locations LIMIT 1; RETURN result; END; $$;
 REVOKE ALL ON FUNCTION public.resolve_room_maintainer(text) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION public.resolve_room_maintainer(text) TO authenticated,anon;
 INSERT INTO floors VALUES('f1','b1'),('f2','b1'),('f3','b2');
 INSERT INTO rooms VALUES('r1','f1'),('r2','f2'),('r3','f3');`;
async function fresh(){const instance=new PGlite();await instance.exec(schema);return instance;}
async function resolve(room='r1'){return (await db.query('SELECT public.resolve_room_maintainer($1) AS id',[room])).rows[0].id;}
async function staff(id,scope,room=null,floor=null,building=null,created='2026-01-01',active=true,archived=false){
 await db.query('INSERT INTO staff VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,room,scope,floor,building,active,archived,created]);
}
before(async()=>{db=await fresh();await db.exec(migration);});
beforeEach(async()=>{await db.exec('RESET ROLE; TRUNCATE staff;');});
after(async()=>{await db?.close();});

test('removes only legacy tables and preserves the invoker API and grants',async()=>{
 const result=(await db.query(`SELECT to_regclass('public.registration_tasks') AS tasks,to_regclass('public.staff_locations') AS locations,
  prosecdef,proconfig,has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
  EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute
 FROM pg_proc p WHERE p.oid='public.resolve_room_maintainer(text)'::regprocedure`)).rows[0];
 assert.equal(result.tasks,null);assert.equal(result.locations,null);assert.equal(result.prosecdef,false);
 assert.deepEqual(result.proconfig,['search_path=""']);assert.equal(result.anon_execute,true);assert.equal(result.authenticated_execute,true);assert.equal(result.public_execute,false);
 assert.equal((await db.query('SELECT count(*)::int AS count FROM rooms')).rows[0].count,3);
});
test('uses room, then floor, then building, then all-staff assignment',async()=>{
 await staff('default','room','r3',null,null,'2020-01-01');
 await staff('all','all',null,null,null,'2021-01-01');
 await staff('building','building',null,null,'b1','2022-01-01');
 await staff('floor','floor',null,'f1',null,'2023-01-01');
 await staff('room','room','r1',null,null,'2024-01-01');
 for(const id of ['room','floor','building','all','default']){assert.equal(await resolve(),id);await db.query('DELETE FROM staff WHERE id=$1',[id]);}
 assert.equal(await resolve(),null);
});
test('does not confuse different rooms, floors or buildings',async()=>{
 await staff('unrelated-room','room','r3',null,null,'2020-01-01');
 await staff('unrelated-floor','floor',null,'f3',null,'2021-01-01');
 await staff('unrelated-building','building',null,null,'b2','2022-01-01');
 await staff('matching-building','building',null,null,'b1','2023-01-01');
 assert.equal(await resolve(), 'matching-building');assert.equal(await resolve('r3'),'unrelated-room');
});
test('uses assignment_scope rather than stale narrower location fields',async()=>{
 await staff('stale-room','floor','r1','f3',null,'2020-01-01');
 await staff('actual-floor','floor',null,'f1',null,'2022-01-01');
 assert.equal(await resolve(),'actual-floor');
});
test('excludes archived and inactive staff even for exact room assignments',async()=>{
 await staff('archived','room','r1',null,null,'2020-01-01',true,true);
 await staff('inactive','room','r1',null,null,'2021-01-01',false,false);
 await staff('active','building',null,null,'b1','2023-01-01');assert.equal(await resolve(),'active');
});
test('preserves oldest-active fallback and resolves ties deterministically',async()=>{
 await staff('z','room','r3',null,null,'2020-01-01');await staff('a','room','r3',null,null,'2020-01-01');
 await staff('later','room','r3',null,null,'2022-01-01');assert.equal(await resolve(),'a');assert.equal(await resolve('unknown-room'),'a');
});
test('returns null when no active nonarchived staff is available',async()=>{
 await staff('inactive','all',null,null,null,'2020-01-01',false,false);assert.equal(await resolve(),null);
});
test('reapplying the migration preserves staff records and assignments',async()=>{
 await staff('retained','room','r1');const before=(await db.query('SELECT * FROM staff')).rows;
 await db.exec(migration);assert.deepEqual((await db.query('SELECT * FROM staff')).rows,before);assert.equal(await resolve(),'retained');
});
test('security invoker continues to enforce caller grants and row-level policies',async()=>{
 await staff('hidden-room','room','r1');await staff('visible','all');
 await db.exec(`ALTER TABLE staff ENABLE ROW LEVEL SECURITY; GRANT SELECT ON rooms,floors,staff TO authenticated;
  CREATE POLICY visible_staff ON staff TO authenticated USING(id='visible');SET ROLE authenticated;`);
 try{assert.equal(await resolve(),'visible');}finally{await db.exec('RESET ROLE');}
 await db.exec('SET ROLE anon');
 try{await assert.rejects(resolve(),/permission denied/);}finally{await db.exec('RESET ROLE;DROP POLICY visible_staff ON staff;ALTER TABLE staff DISABLE ROW LEVEL SECURITY;');}
});

async function blocked(setup,pattern){
 const instance=await fresh();
 try{
  await instance.exec(setup);
  const before=(await instance.query("SELECT pg_get_functiondef('public.resolve_room_maintainer(text)'::regprocedure) AS definition")).rows[0].definition;
  await assert.rejects(instance.exec(migration),pattern);await instance.exec('ROLLBACK');
  const after=(await instance.query("SELECT pg_get_functiondef('public.resolve_room_maintainer(text)'::regprocedure) AS definition")).rows[0].definition;
  assert.equal(after,before);
  assert.equal((await instance.query("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public' AND tablename IN ('registration_tasks','staff_locations')")).rows[0].count,2);
 }finally{await instance.close();}
}
test('aborts atomically if registration tasks gain records',()=>blocked("INSERT INTO registration_tasks VALUES('retained-task')",/nonempty legacy table public.registration_tasks/));
test('aborts atomically if legacy staff locations gain records',()=>blocked("INSERT INTO staff_locations VALUES('retained-location','staff')",/nonempty legacy table public.staff_locations/));
test('refuses an unexpected foreign-key dependency without cascading',()=>blocked('CREATE TABLE external_dependency(task_id text REFERENCES registration_tasks(id))',/depend/));
test('refuses an unexpected view dependency without cascading',()=>blocked('CREATE VIEW external_dependency AS SELECT * FROM staff_locations',/depend/));
test('refuses new routine references before replacing the resolver',()=>blocked("CREATE FUNCTION another_consumer() RETURNS bigint LANGUAGE plpgsql AS $$BEGIN RETURN (SELECT count(*) FROM public.staff_locations);END;$$",/routine still references/));
test('refuses an unexpected overloaded resolver dependency',()=>blocked("CREATE FUNCTION public.resolve_room_maintainer(integer) RETURNS text LANGUAGE plpgsql AS $$BEGIN RETURN (SELECT staff_id FROM public.staff_locations LIMIT 1);END;$$",/routine still references/));
test('refuses newly attached application triggers',()=>blocked("CREATE FUNCTION legacy_trigger() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW;END;$$;CREATE TRIGGER legacy_hook BEFORE INSERT ON staff_locations FOR EACH ROW EXECUTE FUNCTION legacy_trigger()",/application triggers/));
test('schema rollback restores empty legacy tables, RLS and original resolver without modifying staff',async()=>{
 const instance=await fresh();
 try{
  const before=(await instance.query("SELECT pg_get_functiondef('public.resolve_room_maintainer(text)'::regprocedure) AS definition")).rows[0].definition;
  await instance.exec(migration);
  await instance.exec(fs.readFileSync(path.join(root,'reports/database-table-consolidation/rollback.sql'),'utf8'));
  const restored=(await instance.query("SELECT tablename,rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename IN ('registration_tasks','staff_locations') ORDER BY tablename")).rows;
  assert.equal(restored.length,2);assert(restored.every(table=>table.rowsecurity));
  assert.equal((await instance.query('SELECT count(*)::int AS count FROM registration_tasks')).rows[0].count,0);
  assert.equal((await instance.query('SELECT count(*)::int AS count FROM staff_locations')).rows[0].count,0);
  const routine=(await instance.query("SELECT proconfig,prosrc FROM pg_proc WHERE oid='public.resolve_room_maintainer(text)'::regprocedure")).rows[0];
  assert.equal(routine.proconfig,null);assert(routine.prosrc.includes('FROM staff_locations'));assert(before.includes('staff_locations'));
 }finally{await instance.close();}
});
