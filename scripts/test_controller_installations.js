'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const desktop=process.env.ECOTRACK_DESKTOP_ROOT||path.resolve(__dirname,'..');
const overlay=process.env.ECOTRACK_DESKTOP_OVERLAY||desktop;
const mobile=process.env.ECOTRACK_MOBILE_ROOT||path.resolve(desktop,'../EcoTrackAppMobileNew-master-control');
const {PGlite}=require(require.resolve('@electric-sql/pglite',{paths:[mobile]}));
const ui=require(path.join(overlay,'public/js/installation-notifications.js'));
const admin='11111111-1111-4111-8111-111111111111',alice='22222222-2222-4222-8222-222222222222',bob='33333333-3333-4333-8333-333333333333';
let db,sequence=0;
const load=relative=>fs.readFileSync(path.join(fs.existsSync(path.join(overlay,relative))?overlay:desktop,relative),'utf8').replace(/^\uFEFF/,'');
async function owner(sql,args=[]){await db.exec('RESET ROLE');return db.query(sql,args);}
async function user(id,sql,args=[]){await db.exec('RESET ROLE');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id||'']);await db.exec(id?'SET ROLE authenticated':'SET ROLE anon');return db.query(sql,args);}
async function rpc(id,name,args,casts){return (await user(id,`SELECT public.${name}(${args.map((_,i)=>'$'+(i+1)+'::'+casts[i]).join(',')}) AS result`,args)).rows[0].result;}
const finish=(id,n,d,s)=>rpc(id,'ecotrack_finish_controller_registration',[n,d,s],['text','text','jsonb']);
const capture={protocol:'DAIKIN216',raw_data:'3500,1750,450,1300',state:{power:false,temp:23}};
async function draft(id=alice,room='r1',options={}){
 const index=++sequence,device='esp32s3-'+index.toString(16).padStart(12,'0');
 const prepared=await rpc(id,'ecotrack_prepare_controller_registration',[device],['text']);
 if(options.online!==false)await owner('UPDATE ecotrack_device_state SET last_seen=clock_timestamp() WHERE node_id=$1',[prepared.node.id]);
 const setup={controller_name:'Fixture Controller '+index,assignment_mode:'new',asset_tag:'Fixture AC '+index,
  aircon_name:'Fixture AC '+index,room_id:room,brand:'Daikin',aircon_type:'Split',protocol_name:'DAIKIN216',
  installation_attempt_id:`aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12,'0')}`};
 return {device,node:prepared.node.id,setup};
}
const counts=async()=> (await owner('SELECT (SELECT count(*)::integer FROM controller_installations) AS history,(SELECT count(*)::integer FROM notifications) AS inbox')).rows[0];
before(async()=>{
 db=new PGlite();
 await db.exec(`
 CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 GRANT USAGE ON SCHEMA auth,public TO anon,authenticated;
 CREATE TABLE public.staff(id text PRIMARY KEY,auth_user_id uuid,name text,role text,room_id text,status text DEFAULT 'active',is_archived boolean DEFAULT false,force_logout boolean DEFAULT false);
 CREATE TABLE public.administrators(id text PRIMARY KEY,auth_user_id uuid,username text,role text,is_active boolean DEFAULT true);
 CREATE FUNCTION public.ecotrack_staff_id() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT id FROM public.staff WHERE auth_user_id=auth.uid() AND status='active' AND NOT is_archived AND NOT force_logout $$;
 CREATE FUNCTION public.ecotrack_is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.administrators WHERE auth_user_id=auth.uid() AND is_active) $$;
 CREATE TABLE public.buildings(id text PRIMARY KEY,name text);
 CREATE TABLE public.floors(id text PRIMARY KEY,name text,building_id text REFERENCES buildings(id));
 CREATE TABLE public.rooms(id text PRIMARY KEY,name text,floor_id text REFERENCES floors(id));
 CREATE FUNCTION public.ecotrack_can_access_room(p_room_id text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT public.ecotrack_is_admin() OR EXISTS(SELECT 1 FROM public.staff s WHERE s.id=public.ecotrack_staff_id() AND s.room_id=p_room_id) $$;
 CREATE TABLE public.nodes(id text PRIMARY KEY DEFAULT ('node_'||gen_random_uuid()),name text UNIQUE NOT NULL,status text DEFAULT 'offline',room_id text REFERENCES public.rooms(id),brand text,aircon_type text,protocol_name text,temp numeric,rssi numeric,battery numeric,ip_address text,wifi_ssid text,wake_time text,sleep_time text,interval_val integer,interval_unit text,created timestamptz DEFAULT now(),updated timestamptz DEFAULT now());
 CREATE TABLE public.aircons(id text PRIMARY KEY DEFAULT gen_random_uuid()::text,asset_tag text UNIQUE,brand text,model text,aircon_type text,room_id text,node_id text,controller_node_id text,protocol text,protocol_name text,status text,desired_state jsonb,command_id uuid,command_status text,command_status_at timestamptz,commanded_at timestamptz,reported_state jsonb,reported_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
 CREATE TABLE public.telemetry(id text PRIMARY KEY,node_id text,sensor_name text,room_name text,aircon_type text,temperature numeric,pressure numeric,battery numeric,rssi numeric,status text,created timestamptz,interval_seconds numeric,ac_on boolean);
 CREATE TABLE public.notifications(id text PRIMARY KEY,date text NOT NULL,time text NOT NULL,content text NOT NULL,triggered boolean DEFAULT false,room_id text REFERENCES rooms(id) ON DELETE SET NULL,created timestamptz DEFAULT now(),updated timestamptz DEFAULT now());
 CREATE TABLE public.mobile_notifications(id text PRIMARY KEY);
 CREATE TABLE public.ecotrack_push_deliveries(id text PRIMARY KEY);
 GRANT SELECT ON public.aircons,public.nodes TO authenticated;
 GRANT SELECT,INSERT,UPDATE,DELETE ON public.notifications TO authenticated;
 ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
 CREATE POLICY desktop_admin ON public.notifications TO authenticated USING(public.ecotrack_is_admin());
 INSERT INTO buildings VALUES('b1','Building One'),('b2','Building Two');
 INSERT INTO floors VALUES('f1','Floor 1','b1'),('f2','Floor 1','b2');
 INSERT INTO rooms VALUES('r1','Room 1','f1'),('r2','Room 1','f2');
 INSERT INTO staff(id,auth_user_id,name,role,room_id) VALUES('s1','${alice}','Fixture Technician','HVAC Technician','r1'),('s2','${bob}','Other Fixture Technician','Technician','r2');
 INSERT INTO administrators VALUES('a1','${admin}','Fixture Administrator','admin',true);
 `);
 for(const name of ['supabase_cloud_hardware_migration.sql','supabase_controller_registration_migration.sql','supabase_controller_details_migration.sql','supabase_aircon_names_migration.sql'])await db.exec(load(name));
 await db.exec(fs.readFileSync(path.join(mobile,'supabase/optional-migrations/202610140001_staff_controller_registration.sql'),'utf8'));
 await db.exec(load('supabase_ir_code_sync_migration.sql'));
 await db.exec(load('supabase_controller_installation_notifications.sql'));
 await db.exec(load('supabase_controller_installation_notifications.sql'));
});
after(async()=>{await db?.close();});

test('migration is repeatable and does not fabricate installation history',async()=>{
 assert.deepEqual(await counts(),{history:0,inbox:0});
 const definition=(await owner("SELECT pg_get_functiondef('public.ecotrack_finish_controller_registration(text,text,jsonb)'::regprocedure) AS body")).rows[0].body;
 assert.equal(definition.split('PERFORM public.ecotrack_record_controller_installation').length-1,1);
 assert.match(definition,/ecotrack_require_controller_registration/);assert.match(definition,/45 seconds/);
});
test('assigned staff installation creates one desktop event in the exact room with trusted identity and time',async()=>{
 const d=await draft();const started=Date.now();const saved=await finish(alice,d.node,d.device,d.setup);
 const history=(await owner('SELECT * FROM controller_installations WHERE node_id=$1',[d.node])).rows[0];
 const notification=(await user(admin,'SELECT * FROM notifications WHERE node_id=$1',[d.node])).rows[0];
 assert.equal(saved.node.id,d.node);assert.equal(history.room_id,'r1');assert.equal(notification.room_id,'r1');
 assert.equal(history.installer_auth_user_id,alice);assert.equal(history.installer_name,'Fixture Technician');assert.equal(history.installer_account_role,'staff');
 assert.equal(history.controller_name,d.setup.controller_name);assert.equal(history.building_name,'Building One');
 assert.equal(Date.parse(notification.installation.installed_at),new Date(history.installed_at).getTime());
 assert(Math.abs(new Date(history.installed_at).getTime()-started)<5000);assert.equal(notification.type,'controller_installation');
 assert.equal(notification.installation.room_id,'r1');assert(!('request_setup' in notification.installation));
 assert.equal((await user(alice,'SELECT * FROM controller_installations')).rows.length,0);
 assert.equal((await user(alice,'SELECT * FROM notifications')).rows.length,0);
});
test('duplicate and concurrent queued submissions retain one history record and inbox event',async()=>{
 const d=await draft(),first=await finish(alice,d.node,d.device,d.setup);
 // Single-instance PostgreSQL queues these calls; unique keys and the real per-device lock also remain in force.
 await db.exec('RESET ROLE');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[alice]);await db.exec('SET ROLE authenticated');
 await Promise.all([1,2].map(()=>db.query('SELECT public.ecotrack_finish_controller_registration($1,$2,$3::jsonb)',[d.node,d.device,JSON.stringify(d.setup)])));
 assert.equal((await owner('SELECT count(*)::integer AS count FROM controller_installations WHERE node_id=$1',[first.node.id])).rows[0].count,1);
 assert.equal((await owner('SELECT count(*)::integer AS count FROM notifications WHERE node_id=$1',[first.node.id])).rows[0].count,1);
});
test('changed details cannot reuse a successful attempt and leave the existing controller unchanged',async()=>{
 const d=await draft();await finish(alice,d.node,d.device,d.setup);
 await assert.rejects(finish(alice,d.node,d.device,{...d.setup,controller_name:'Should roll back'}),error=>error.code==='40001');
 assert.equal((await owner('SELECT name FROM nodes WHERE id=$1',[d.node])).rows[0].name,d.setup.controller_name);
});
test('deliberate reinstallation saves a new snapshot without moving the original event',async()=>{
 const d=await draft(admin);const first=await finish(admin,d.node,d.device,d.setup);
 const next={...d.setup,room_id:'r2',controller_name:'Moved Controller',installation_attempt_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
 await finish(admin,d.node,d.device,next);
 const history=(await owner('SELECT * FROM controller_installations WHERE node_id=$1 ORDER BY installed_at',[d.node])).rows;
 assert.equal(history.length,2);assert.equal(history[0].room_id,'r1');assert.equal(history[0].controller_name,d.setup.controller_name);
 assert.equal(history[1].room_id,'r2');assert.equal(history[1].event_kind,'reinstallation');assert.equal(history[1].installer_name,'Fixture Administrator');
 assert.equal(first.aircon.id,history[1].aircon_id);
 await owner("UPDATE nodes SET name='Later ordinary rename' WHERE id=$1",[d.node]);
 assert.equal((await owner('SELECT count(*)::integer AS count FROM controller_installations WHERE node_id=$1',[d.node])).rows[0].count,2);
});
test('failed heartbeat, identity, room scope and invalid attempt create no installation event',async()=>{
 const offline=await draft(alice,'r1',{online:false}),before=await counts();
 await assert.rejects(finish(alice,offline.node,offline.device,offline.setup),/Verification pending/);
 const d=await draft();
 await assert.rejects(finish(bob,d.node,d.device,{...d.setup,room_id:'r2'}),/outside your assigned room/);
 await assert.rejects(finish(alice,d.node,'esp32s3-ffffffffffff',d.setup),/identity/);
 await assert.rejects(finish(alice,d.node,d.device,{...d.setup,room_id:'r2'}),/assigned room/);
 await assert.rejects(finish(alice,d.node,d.device,{...d.setup,installation_attempt_id:'invalid'}),/attempt identifier/);
 const unassigned=await draft(admin);
 await assert.rejects(finish(admin,unassigned.node,unassigned.device,{...unassigned.setup,room_id:null}),/Choose an existing building/);
 assert.deepEqual(await counts(),before);
});
test('client-supplied installer/time and arbitrary credentials are excluded from saved snapshots',async()=>{
 const d=await draft();await finish(alice,d.node,d.device,{...d.setup,installer_name:'Forged Installer',installed_at:'1999-01-01',wifi_password:'fixture-only'});
 const e=(await owner('SELECT * FROM controller_installations WHERE node_id=$1',[d.node])).rows[0];
 assert.equal(e.installer_name,'Fixture Technician');assert(!JSON.stringify(e).includes('fixture-only'));assert(!('installed_at' in e.request_setup));
});
test('IR capture and notification are one transaction; a bad capture rolls back everything',async()=>{
 const d=await draft(),before=await counts();
 const ir=(setup,frame)=>rpc(alice,'ecotrack_finish_controller_registration_with_ir',[d.node,d.device,setup,frame],['text','text','jsonb','jsonb']);
 await assert.rejects(ir(d.setup,{...capture,raw_data:'invalid'}),/captured IR timings/);
 assert.deepEqual(await counts(),before);
 assert.equal((await owner('SELECT name FROM nodes WHERE id=$1',[d.node])).rows[0].name,d.device);
 const saved=await ir(d.setup,capture);assert(saved.ir_code.id);
 assert.deepEqual(await counts(),{history:before.history+1,inbox:before.inbox+1});
});
test('legacy clients produce an event and deduplicate identical finalizer retries',async()=>{
 const d=await draft();delete d.setup.installation_attempt_id;
 await finish(alice,d.node,d.device,d.setup);
 await owner("SET TIME ZONE 'UTC'");
 await finish(alice,d.node,d.device,d.setup);
 await owner("SET TIME ZONE 'Asia/Singapore'");
 assert.equal((await owner('SELECT count(*)::integer AS count FROM controller_installations WHERE node_id=$1',[d.node])).rows[0].count,1);
});
test('renamed installer, room and controller do not rewrite installation snapshots',async()=>{
 const d=await draft();await finish(alice,d.node,d.device,d.setup);
 await owner("UPDATE staff SET name='Renamed Technician' WHERE id='s1'");
 await owner("UPDATE rooms SET name='Renamed Room' WHERE id='r1'");
 await owner("UPDATE nodes SET room_id='r2',name='Renamed Controller' WHERE id=$1",[d.node]);
 const e=(await owner('SELECT installation FROM notifications WHERE node_id=$1',[d.node])).rows[0].installation;
 assert.equal(e.installer_name,'Fixture Technician');assert.equal(e.room_name,'Room 1');assert.equal(e.controller_name,d.setup.controller_name);assert.equal(e.room_id,'r1');
 await owner("UPDATE staff SET name='Fixture Technician' WHERE id='s1'");
 await owner("UPDATE rooms SET name='Room 1' WHERE id='r1'");
});
test('anonymous, inactive, direct helper and direct history writes cannot bypass registration guards',async()=>{
 const d=await draft();
 await assert.rejects(finish(null,d.node,d.device,d.setup),error=>error.code==='42501');
 await owner("UPDATE staff SET is_archived=true WHERE id='s1'");
 await assert.rejects(finish(alice,d.node,d.device,d.setup),error=>error.code==='42501');
 await owner("UPDATE staff SET is_archived=false WHERE id='s1'");
 await assert.rejects(rpc(admin,'ecotrack_record_controller_installation',[d.node,d.device,d.setup],['text','text','jsonb']),error=>error.code==='42501');
 await assert.rejects(user(admin,"UPDATE controller_installations SET room_id='r2'"),error=>error.code==='42501');
});
test('inbox removal retains history and retries do not recreate a removed notification',async()=>{
 const d=await draft();await finish(alice,d.node,d.device,d.setup);
 await user(admin,'DELETE FROM notifications WHERE node_id=$1',[d.node]);
 await finish(alice,d.node,d.device,d.setup);
 assert.equal((await owner('SELECT count(*)::integer AS count FROM controller_installations WHERE node_id=$1',[d.node])).rows[0].count,1);
 assert.equal((await owner('SELECT count(*)::integer AS count FROM notifications WHERE node_id=$1',[d.node])).rows[0].count,0);
});
test('installation notification routing and metadata cannot be altered or forged',async()=>{
 const d=await draft();await finish(alice,d.node,d.device,d.setup);
 await assert.rejects(user(admin,"UPDATE notifications SET room_id='r2' WHERE node_id=$1",[d.node]),error=>error.code==='42501');
 await assert.rejects(user(admin,"UPDATE notifications SET type='standard',installation_id=null,installation=null WHERE node_id=$1",[d.node]),error=>error.code==='42501');
 await assert.rejects(user(admin,"INSERT INTO notifications(id,date,time,content,type) VALUES('forged','2026-01-01','00:00','forged','controller_installation')"),error=>error.code==='42501');
});
test('desktop installation feature creates no mobile inbox records or push deliveries',async()=>{
 assert.equal((await owner('SELECT count(*)::integer AS count FROM mobile_notifications')).rows[0].count,0);
 assert.equal((await owner('SELECT count(*)::integer AS count FROM ecotrack_push_deliveries')).rows[0].count,0);
});
test('UI uses stored location and controller snapshots and a fixed Singapore timestamp',()=>{
 const installation={room_id:'r1',node_id:'n1',controller_name:'Snapshot Controller',installer_name:'Fixture Technician',installed_at:'2026-10-15T18:30:00Z',building_name:'Building One',floor_name:'Floor 1',room_name:'Room 1'};
 const msg=ui.toMessage({id:'notification-one',type:'controller_installation',room_id:'r1',node_id:'renamed',installation},{'notification-one':true});
 assert.equal(msg.room,'r1');assert.equal(msg.node,'n1');assert.deepEqual(msg.nodes,['Snapshot Controller']);
 assert.equal(msg.date,'2026-10-16');assert.match(msg.time,/02:30:00 AM/);assert(msg.read);
 assert.equal(ui.toMessage({type:'controller_installation',room_id:'r2',installation}),null);
 assert.equal(ui.toMessage({type:'controller_installation',installation:{...installation,installed_at:'invalid'}}),null);
});
test('installation details escape dynamic content rather than executing stored markup',()=>{
 const html=ui.renderDetails({controller_name:'<img src=x onerror=alert(1)>',installer_name:'<script>bad()</script>',room_name:'<b>Room</b>',installed_at:'2026-10-15T01:00:00Z'});
 assert(!html.includes('<img'));assert(!html.includes('<script>'));assert(html.includes('&lt;img'));assert(html.includes('SGT'));
});
