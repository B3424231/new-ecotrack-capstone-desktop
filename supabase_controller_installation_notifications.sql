-- Apply after the existing auth, staff registration, controller-details/name and IR migrations.
-- Desktop inbox only. No historical backfill, mobile notification or push writes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
 IF to_regprocedure('public.ecotrack_finish_controller_registration(text,text,jsonb)') IS NULL
 OR to_regprocedure('public.ecotrack_staff_id()') IS NULL
 OR to_regclass('public.notifications') IS NULL THEN
  RAISE EXCEPTION 'Install authentication and verified controller registration before installation notifications';
 END IF;
END $$;

-- No cascading references: preserve installation facts after account/location/controller removal.
CREATE TABLE IF NOT EXISTS public.controller_installations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 node_id text NOT NULL, device_id text NOT NULL,
 attempt_id text NOT NULL, request_setup jsonb NOT NULL,
 installer_auth_user_id uuid NOT NULL, installer_profile_id text,
 installer_name text, installer_account_role text NOT NULL, installer_role text,
 controller_name text NOT NULL,
 room_id text NOT NULL, room_name text NOT NULL,
 floor_id text NOT NULL, floor_name text NOT NULL,
 building_id text NOT NULL, building_name text NOT NULL,
 aircon_id text NOT NULL, aircon_name text, aircon_type text,
 installed_at timestamptz NOT NULL,
 event_kind text NOT NULL CHECK(event_kind IN ('installation','reinstallation')),
 UNIQUE(node_id,attempt_id)
);
CREATE INDEX IF NOT EXISTS controller_installations_room_time ON public.controller_installations(room_id,installed_at DESC);
ALTER TABLE public.controller_installations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.controller_installations FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.controller_installations TO authenticated;
DROP POLICY IF EXISTS controller_installation_admin_read ON public.controller_installations;
CREATE POLICY controller_installation_admin_read ON public.controller_installations
 FOR SELECT TO authenticated USING(public.ecotrack_is_admin());

ALTER TABLE public.notifications
 ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'standard',
 ADD COLUMN IF NOT EXISTS node_id text,
 ADD COLUMN IF NOT EXISTS event_key text,
 ADD COLUMN IF NOT EXISTS installation_id uuid,
 ADD COLUMN IF NOT EXISTS installation jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS controller_installation_notification_unique
 ON public.notifications(installation_id) WHERE installation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.ecotrack_guard_installation_notification()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE e public.controller_installations%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.type='controller_installation' OR OLD.installation_id IS NOT NULL) THEN
  IF NEW.installation_id IS DISTINCT FROM OLD.installation_id OR NEW.type IS DISTINCT FROM OLD.type THEN
   RAISE EXCEPTION 'Installation notification identity cannot be changed' USING ERRCODE='42501';
  END IF;
 END IF;
 IF NEW.type='controller_installation' OR NEW.installation_id IS NOT NULL OR NEW.installation IS NOT NULL THEN
  SELECT * INTO e FROM public.controller_installations WHERE id=NEW.installation_id;
  IF NOT FOUND OR NEW.type IS DISTINCT FROM 'controller_installation'
    OR NEW.installation IS DISTINCT FROM to_jsonb(e)-'request_setup'-'attempt_id'
    OR NEW.node_id IS DISTINCT FROM e.node_id
    OR NEW.event_key IS DISTINCT FROM 'controller_installation:'||e.id::text THEN
   RAISE EXCEPTION 'Installation notification requires its verified installation record' USING ERRCODE='42501';
  END IF;
  IF NEW.room_id IS DISTINCT FROM e.room_id AND NOT (NEW.room_id IS NULL AND
    NOT EXISTS(SELECT 1 FROM public.rooms WHERE id=e.room_id)) THEN
   RAISE EXCEPTION 'Installation notification must stay in its saved room' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ecotrack_guard_installation_notification() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS ecotrack_installation_notification_guard ON public.notifications;
CREATE TRIGGER ecotrack_installation_notification_guard BEFORE INSERT OR UPDATE ON public.notifications
 FOR EACH ROW EXECUTE FUNCTION public.ecotrack_guard_installation_notification();

CREATE OR REPLACE FUNCTION public.ecotrack_record_controller_installation(p_node_id text,p_device_id text,p_setup jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE n public.nodes%ROWTYPE; ac public.aircons%ROWTYPE; r public.rooms%ROWTYPE;
 f public.floors%ROWTYPE; b public.buildings%ROWTYPE; e public.controller_installations%ROWTYPE;
 actor jsonb; account_role text; attempt text; issued timestamptz;
 request_data jsonb; saved_time timestamptz:=clock_timestamp(); title text;
BEGIN
 -- Keep only the registration contract, never arbitrary client fields or credentials.
 SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) INTO request_data FROM jsonb_each(p_setup)
  WHERE key IN ('controller_name','assignment_mode','aircon_id','asset_tag','aircon_name','room_id','brand','aircon_type','protocol_name');
 -- Called only by the verified finalizer, under its per-device transaction lock.
 SELECT * INTO n FROM public.nodes WHERE id=p_node_id;
 IF auth.uid() IS NULL OR n.admin_verified_by IS DISTINCT FROM auth.uid() OR n.admin_verified_at IS NULL THEN
  RAISE EXCEPTION 'Verified controller registration required' USING ERRCODE='42501';
 END IF;
 SELECT issued_at INTO issued FROM ecotrack_private.device_credentials WHERE node_id=p_node_id AND device_id=p_device_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Controller credential identity changed'; END IF;
 IF p_setup ? 'installation_attempt_id' THEN
  attempt:=p_setup->>'installation_attempt_id';
  IF jsonb_typeof(p_setup->'installation_attempt_id') IS DISTINCT FROM 'string'
    OR attempt !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' THEN
   RAISE EXCEPTION 'Invalid installation attempt identifier' USING ERRCODE='22023';
  END IF;
  attempt:=lower(attempt);
 ELSE
  -- Compatibility for installed older apps: identical finalizer retries share one event.
  attempt:='legacy:'||md5(p_device_id||':'||extract(epoch FROM issued)::text||':'||request_data::text);
 END IF;
 SELECT * INTO e FROM public.controller_installations WHERE node_id=p_node_id AND attempt_id=attempt;
 IF FOUND THEN
  IF e.installer_auth_user_id IS DISTINCT FROM auth.uid() OR e.request_setup IS DISTINCT FROM request_data THEN
   RAISE EXCEPTION 'This installation attempt already completed with different details. Reopen setup.' USING ERRCODE='40001';
  END IF;
  RETURN;
 END IF;
 SELECT * INTO r FROM public.rooms WHERE id=n.room_id;
 SELECT * INTO f FROM public.floors WHERE id=r.floor_id;
 SELECT * INTO b FROM public.buildings WHERE id=f.building_id;
 IF r.id IS NULL OR f.id IS NULL OR b.id IS NULL THEN
  RAISE EXCEPTION 'Choose an existing building, floor and room for this installation' USING ERRCODE='22023';
 END IF;
 SELECT * INTO ac FROM public.aircons WHERE controller_node_id=n.id AND room_id=r.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'The installed controller AC assignment was not confirmed'; END IF;
 IF public.ecotrack_is_admin() THEN
  SELECT to_jsonb(a) INTO actor FROM public.administrators a WHERE a.auth_user_id=auth.uid();
  account_role:='administrator';
 ELSE
  SELECT to_jsonb(s) INTO actor FROM public.staff s WHERE s.id=public.ecotrack_staff_id() AND s.auth_user_id=auth.uid();
  account_role:='staff';
 END IF;
 IF actor IS NULL THEN RAISE EXCEPTION 'Installer profile could not be verified. Sign in again.' USING ERRCODE='42501'; END IF;
 INSERT INTO public.controller_installations(node_id,device_id,attempt_id,request_setup,installer_auth_user_id,
  installer_profile_id,installer_name,installer_account_role,installer_role,controller_name,
  room_id,room_name,floor_id,floor_name,building_id,building_name,aircon_id,aircon_name,aircon_type,installed_at,event_kind)
 VALUES(n.id,p_device_id,attempt,request_data,auth.uid(),actor->>'id',
  coalesce(nullif(btrim(actor->>'name'),''),nullif(btrim(actor->>'username'),'')),account_role,actor->>'role',n.name,
  r.id,r.name,f.id,f.name,b.id,b.name,ac.id,coalesce(ac.name,ac.asset_tag),ac.aircon_type,saved_time,
  CASE WHEN EXISTS(SELECT 1 FROM public.controller_installations WHERE node_id=n.id) THEN 'reinstallation' ELSE 'installation' END)
 RETURNING * INTO e;
 title:=CASE e.event_kind WHEN 'reinstallation' THEN 'ESP32 Reinstalled' ELSE 'ESP32 Installed' END;
 INSERT INTO public.notifications(id,date,time,content,triggered,room_id,node_id,type,event_key,installation_id,installation,created,updated)
 VALUES('installation_'||e.id::text,to_char(saved_time AT TIME ZONE 'Asia/Singapore','YYYY-MM-DD'),
  to_char(saved_time AT TIME ZONE 'Asia/Singapore','HH24:MI:SS'),
  title||': '||n.name||' at '||b.name||' / '||f.name||' / '||r.name,true,r.id,n.id,'controller_installation',
  'controller_installation:'||e.id::text,e.id,to_jsonb(e)-'request_setup'-'attempt_id',saved_time,saved_time);
END $$;
REVOKE ALL ON FUNCTION public.ecotrack_record_controller_installation(text,text,jsonb) FROM PUBLIC,anon,authenticated;

-- Preserve the installed authorization, assignment, identity, locking and heartbeat logic.
-- Unknown versions stop the migration rather than replacing those safeguards.
DO $$
DECLARE definition text; marker text:='RETURN jsonb_build_object(''success'',true,''registered'',true';
BEGIN
 definition:=pg_get_functiondef('public.ecotrack_finish_controller_registration(text,text,jsonb)'::regprocedure);
 IF position('ecotrack_record_controller_installation' IN definition)=0 THEN
  IF position(marker IN definition)=0 OR position('registration_verify' IN definition)=0
    OR position('45 seconds' IN definition)=0 OR position('pg_advisory_xact_lock' IN definition)=0 THEN
   RAISE EXCEPTION 'Unrecognized registration finalizer. Install current controller details/name migrations first';
  END IF;
  definition:=replace(definition,marker,
   'PERFORM public.ecotrack_record_controller_installation(p_node_id,p_device_id,p_setup);'||chr(10)||' '||marker);
  EXECUTE definition;
 END IF;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;

SELECT to_regclass('public.controller_installations') AS installation_history,
 position('ecotrack_record_controller_installation' IN pg_get_functiondef(
  'public.ecotrack_finish_controller_registration(text,text,jsonb)'::regprocedure))>0 AS registration_hook_installed;
