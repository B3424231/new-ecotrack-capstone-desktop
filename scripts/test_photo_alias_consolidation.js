'use strict';
// Isolated real PostgreSQL execution. No live Auth, Storage or database writes.
const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),mobile=path.resolve(root,'../EcoTrackAppMobileNew-master-control');
const {PGlite}=require(require.resolve('@electric-sql/pglite',{paths:[mobile]}));
const migration=fs.readFileSync(path.join(root,'supabase/migrations/20261019182804_consolidate_unused_photo_aliases.sql'),'utf8');
const original=fs.readFileSync(path.join(root,'scripts/fixtures/photo-alias-profile-functions.sql'),'utf8');
const rollback=fs.readFileSync(path.join(root,'reports/database-column-consolidation/rollback.sql'),'utf8');
const admin='11111111-1111-4111-8111-111111111111',staffId='22222222-2222-4222-8222-222222222222',outsider='33333333-3333-4333-8333-333333333333';
const adminImage=`storage://avatars/${admin}/old.png`,staffImage=`storage://avatars/${staffId}/old.png`;
const schema=`
 CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE SCHEMA auth;CREATE SCHEMA storage;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 GRANT USAGE ON SCHEMA auth TO anon,authenticated;GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated;
 CREATE TABLE storage.objects(bucket_id text,name text);
 CREATE TABLE public.administrators(id text PRIMARY KEY,username text,email text,phone text,avatar text DEFAULT 'default',photo_url text,avatar_url text,auth_user_id uuid,is_active boolean DEFAULT true,is_archived boolean DEFAULT false,updated timestamptz);
 CREATE TABLE public.staff(id text PRIMARY KEY,name text,email text,phone text,role text,status text DEFAULT 'Offline',avatar text DEFAULT 'default',photo_url text,avatar_url text,
  auth_user_id uuid,is_active boolean DEFAULT true,is_archived boolean DEFAULT false,room_id text,assignment_scope text DEFAULT 'room',assigned_floor_id text,assigned_building_id text,
  building_name text,floor_name text,room_name text,assignment text,is_online boolean,online_status text,updated timestamptz,password text,password_hash text);
 CREATE TABLE public.nodes(id text PRIMARY KEY,name text,photo_url text,image_url text);
 CREATE TABLE public.buildings(id text PRIMARY KEY,name text);
 CREATE TABLE public.floors(id text PRIMARY KEY,name text,building_id text);
 CREATE TABLE public.rooms(id text PRIMARY KEY,name text,floor_id text);
 CREATE FUNCTION public.ecotrack_is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT EXISTS(SELECT 1 FROM public.administrators WHERE auth_user_id=auth.uid() AND is_active AND NOT is_archived)$$;
 CREATE FUNCTION public.ecotrack_staff_id() RETURNS text LANGUAGE sql STABLE AS $$SELECT id FROM public.staff WHERE auth_user_id=auth.uid() AND is_active AND NOT is_archived LIMIT 1$$;`;
let db;
async function fresh(){const instance=new PGlite();await instance.exec(schema);await instance.exec(original);
 await instance.exec(`REVOKE ALL ON FUNCTION public.ecotrack_update_profile(text,text,text,text),public.ecotrack_my_profile(),public.ecotrack_admin_edit_staff(text,jsonb,jsonb,boolean) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION public.ecotrack_update_profile(text,text,text,text),public.ecotrack_my_profile(),public.ecotrack_admin_edit_staff(text,jsonb,jsonb,boolean) TO authenticated,service_role;
 INSERT INTO buildings VALUES('b','Building');INSERT INTO floors VALUES('f','Floor','b');INSERT INTO rooms VALUES('r','Room','f');
 INSERT INTO administrators(id,username,email,phone,avatar,avatar_url,auth_user_id) VALUES('a','Admin','admin@example.test','09111111111','custom','${adminImage}','${admin}');
 INSERT INTO staff(id,name,email,phone,role,avatar,photo_url,avatar_url,auth_user_id,room_id,assignment_scope,assigned_floor_id,assigned_building_id,assignment,password)
 VALUES('s','Technician','staff@example.test','09222222222','Technician','custom','${staffImage}','${staffImage}','${staffId}','r','room','f','b','Legacy room','fixture-private');
 INSERT INTO nodes VALUES('n','Sensor',NULL,'https://fixture.invalid/node.png');
 INSERT INTO storage.objects VALUES('avatars','${admin}/old.png'),('avatars','${staffId}/old.png');`);return instance;}
async function rpc(id,name,args=[],casts=[]){await db.exec('RESET ROLE');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id||'']);await db.exec(id?'SET ROLE authenticated':'SET ROLE anon');try{return (await db.query(`SELECT public.${name}(${args.map((_,i)=>'$'+(i+1)+'::'+casts[i]).join(',')}) AS profile`,args)).rows[0].profile;}finally{await db.exec('RESET ROLE');}}
const update=(id,avatar,photo,name='Updated profile')=>rpc(id,'ecotrack_update_profile',[name,'09111111111',avatar,photo],['text','text','text','text']);
before(async()=>{db=await fresh();await db.exec(migration);});
beforeEach(async()=>{await db.exec('RESET ROLE');});after(async()=>{await db?.close();});

test('backfills canonical image values and removes only the two unsupported aliases',async()=>{
 const columns=(await db.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('avatar','photo_url','avatar_url','image_url')")).rows;
 assert(!columns.some(c=>c.table_name==='administrators'&&c.column_name==='avatar_url'));assert(!columns.some(c=>c.table_name==='nodes'&&c.column_name==='image_url'));
 assert(columns.some(c=>c.table_name==='staff'&&c.column_name==='avatar_url'));assert(columns.some(c=>c.table_name==='administrators'&&c.column_name==='avatar'));
 assert.equal((await db.query('SELECT photo_url FROM administrators')).rows[0].photo_url,adminImage);
 assert.equal((await db.query('SELECT photo_url FROM nodes')).rows[0].photo_url,'https://fixture.invalid/node.png');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM staff')).rows[0].n,1);
});
test('administrator profile response retains the same photoUrl and identity contract',async()=>{
 const profile=await rpc(admin,'ecotrack_my_profile');assert.equal(profile.id,'a');assert.equal(profile.photoUrl,adminImage);assert.equal(profile.avatar,'custom');assert.equal(profile.password,undefined);
});
test('administrator profile updates use an owned image with the canonical field',async()=>{
 const name=`${admin}/new.png`;await db.query('INSERT INTO storage.objects VALUES($1,$2)',['avatars',name]);
 const profile=await update(admin,'custom','storage://avatars/'+name);assert.equal(profile.photoUrl,'storage://avatars/'+name);
 assert.equal((await db.query('SELECT username FROM administrators')).rows[0].username,'Updated profile');
});
test('default avatar selection remains distinct from a custom photo',async()=>{
 const profile=await update(admin,'male',null);assert.equal(profile.avatar,'male');assert.equal(profile.photoUrl,null);
});
test('staff profiles, stored photo alias and installed mobile explicit selects remain compatible',async()=>{
 const profile=await rpc(staffId,'ecotrack_my_profile');assert.equal(profile.photoUrl,staffImage);assert.equal(profile.assignment,'Building • Floor • Room');
 const updated=await update(staffId,'custom',staffImage,'Staff updated');assert.equal(updated.photoUrl,staffImage);
 const selected=(await db.query('SELECT id,avatar,photo_url,avatar_url FROM staff')).rows[0];assert.equal(selected.photo_url,selected.avatar_url);assert.equal(selected.photo_url,staffImage);
});
test('staff editor retains its avatar_url optimistic-version contract and private-field filtering',async()=>{
 const versionKeys=['name','email','phone','role','room_id','assignment_scope','assigned_floor_id','assigned_building_id','avatar','photo_url','avatar_url'];
 const row=(await db.query('SELECT * FROM staff')).rows[0],expected=Object.fromEntries(versionKeys.map(key=>[key,row[key]??null]));
 const changes={name:'Edited staff',phone:'09222222222',role:'Technician',assignment_scope:'room',assigned_building_id:'b',assigned_floor_id:'f',room_id:'r'};
 const saved=await rpc(admin,'ecotrack_admin_edit_staff',['s',changes,expected,true],['text','jsonb','jsonb','boolean']);
 assert.equal(saved.profile.avatar_url,staffImage);assert.equal(saved.profile.photo_url,staffImage);assert.equal(saved.profile.name,'Edited staff');assert.equal(saved.profile.password,undefined);
 await assert.rejects(rpc(admin,'ecotrack_admin_edit_staff',['s',changes,expected,true],['text','jsonb','jsonb','boolean']),/changed/);
});
test('profile ownership and storage verification are unchanged',async()=>{
 await assert.rejects(update(staffId,'custom',adminImage),/owned storage/);
 await assert.rejects(update(admin,'custom',`storage://avatars/${admin}/missing.png`),/owned storage/);
 await assert.rejects(update(admin,'invalid',null),/Invalid profile/);
 await assert.rejects(rpc(outsider,'ecotrack_my_profile'),/Active account/);
 await assert.rejects(rpc(null,'ecotrack_my_profile'),/permission denied/);
});
test('function execute grants, fixed search paths and existing privileged mode are retained',async()=>{
 const rows=(await db.query("SELECT proname,prosecdef,proconfig,has_function_privilege('anon',oid,'EXECUTE') AS anon_exec,has_function_privilege('authenticated',oid,'EXECUTE') AS auth_exec FROM pg_proc WHERE oid IN ('public.ecotrack_my_profile()'::regprocedure,'public.ecotrack_update_profile(text,text,text,text)'::regprocedure)")).rows;
 assert.equal(rows.length,2);for(const r of rows){assert.equal(r.prosecdef,true);assert.deepEqual(r.proconfig,['search_path=""']);assert.equal(r.anon_exec,false);assert.equal(r.auth_exec,true);}
});
async function blocked(setup,pattern){const instance=await fresh();try{
 await instance.exec(setup);const before=(await instance.query('SELECT id,photo_url,avatar_url FROM administrators')).rows;
 await assert.rejects(instance.exec(migration),pattern);await instance.exec('ROLLBACK');
 assert.deepEqual((await instance.query('SELECT id,photo_url,avatar_url FROM administrators')).rows,before);
 assert.equal((await instance.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND ((table_name='administrators' AND column_name='avatar_url') OR (table_name='nodes' AND column_name='image_url'))")).rows[0].n,2);
}finally{await instance.close();}}
test('conflicting administrator images stop the transaction',()=>blocked("UPDATE administrators SET photo_url='https://fixture.invalid/other.png'",/Conflicting image/));
test('node owner metadata cannot be overwritten by a different image alias',()=>blocked("UPDATE nodes SET photo_url='{\"addedByUserId\":\"fixture\"}'",/Conflicting image/));
test('new database routine consumers stop the migration',()=>blocked("CREATE FUNCTION legacy_consumer() RETURNS text LANGUAGE plpgsql AS $$BEGIN RETURN (SELECT image_url FROM nodes LIMIT 1);END;$$",/new routine/));
test('column view dependencies refuse the drop and roll back backfills',()=>blocked('CREATE VIEW image_consumer AS SELECT avatar_url FROM administrators',/depend/));
test('schema rollback preserves canonical images and restores the previous profile functions',async()=>{
 const instance=await fresh();try{await instance.exec(migration);await instance.exec(rollback);
 const row=(await instance.query('SELECT photo_url,avatar_url FROM administrators')).rows[0];assert.equal(row.photo_url,adminImage);assert.equal(row.avatar_url,adminImage);
 assert.equal((await instance.query('SELECT count(*)::int AS n FROM nodes')).rows[0].n,1);
 assert.equal((await instance.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='nodes' AND column_name='image_url'")).rows[0].n,1);
}finally{await instance.close();}});
