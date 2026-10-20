-- EcoTrack immediate IR observations and private hardware Broadcast.
-- Run after supabase_cloud_hardware_migration.sql. Safe to run again.
-- Existing heartbeat/command RPCs and old receiver sketches remain compatible.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.ecotrack_device_state') IS NULL OR to_regprocedure('public.ecotrack_is_admin()') IS NULL THEN
  RAISE EXCEPTION 'Install supabase_cloud_hardware_migration.sql first';
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.ecotrack_device_observe(p_device_id text,p_token text,p_observation jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE target text; current_state public.ecotrack_device_state; latest jsonb; field text; seen timestamptz;
BEGIN
 SELECT node_id INTO target FROM ecotrack_private.device_credentials
 WHERE device_id=p_device_id AND p_token ~ '^[a-f0-9]{64}$' AND token_hash=sha256(convert_to(p_token,'UTF8'));
 IF target IS NULL THEN RAISE EXCEPTION 'Invalid device credential' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_observation) IS DISTINCT FROM 'object' OR octet_length(p_observation::text)>4000
  OR p_observation ? 'raw_data' OR p_observation ? 'last_decoded'
  OR coalesce(p_observation->>'protocol','') !~ '^[A-Z][A-Z0-9_]{1,48}$' OR p_observation->>'protocol'='UNKNOWN'
  OR p_observation->>'frame_kind' IS DISTINCT FROM 'full_state'
  OR jsonb_typeof(p_observation->'raw_count') IS DISTINCT FROM 'number'
  OR coalesce(p_observation->>'raw_count','') !~ '^[1-9][0-9]{0,3}$'
  OR jsonb_typeof(p_observation->'sequence') IS DISTINCT FROM 'number'
  OR coalesce(p_observation->>'sequence','') !~ '^[0-9]{1,10}$'
  OR jsonb_typeof(p_observation->'boot_count') IS DISTINCT FROM 'number'
  OR coalesce(p_observation->>'boot_count','') !~ '^[0-9]{1,10}$'
  OR jsonb_typeof(p_observation->'state') IS DISTINCT FROM 'object'
  OR jsonb_typeof(p_observation->'state'->'power') IS DISTINCT FROM 'boolean'
  OR jsonb_typeof(p_observation->'state'->'temp') IS DISTINCT FROM 'number'
  OR coalesce(p_observation->'state'->>'mode','') NOT IN ('cool','dry','fan','auto','heat')
  OR coalesce(p_observation->'state'->>'fan','') NOT IN ('auto','low','medium','high','quiet','silent','turbo')
  OR p_observation->'state'->>'source' IS DISTINCT FROM 'ir_receiver' THEN
  RAISE EXCEPTION 'Invalid decoded IR observation';
 END IF;
 IF (p_observation->'state'->>'temp')::numeric NOT BETWEEN 0 AND 50 THEN RAISE EXCEPTION 'Invalid IR temperature'; END IF;
 FOREACH field IN ARRAY ARRAY['turbo','swing','eco','sleep'] LOOP
  IF p_observation->'state' ? field AND jsonb_typeof(p_observation->'state'->field) IS DISTINCT FROM 'boolean' THEN
   RAISE EXCEPTION 'Invalid IR feature';
  END IF;
 END LOOP;
 IF p_observation ? 'captured_at_epoch_ms' AND
  (jsonb_typeof(p_observation->'captured_at_epoch_ms') IS DISTINCT FROM 'number' OR
   coalesce(p_observation->>'captured_at_epoch_ms','') !~ '^[0-9]{13}$') THEN RAISE EXCEPTION 'Invalid IR capture timestamp'; END IF;
 SELECT * INTO current_state FROM public.ecotrack_device_state WHERE node_id=target AND device_id=p_device_id FOR UPDATE;
 IF current_state.node_id IS NULL THEN RAISE EXCEPTION 'Register this controller first'; END IF;
 -- Capture time also rejects an old boot's delayed upload after a newer boot has reported.
 IF coalesce(current_state.latest_ir->>'captured_at_epoch_ms','') ~ '^[0-9]{13}$'
  AND coalesce(p_observation->>'captured_at_epoch_ms','') ~ '^[0-9]{13}$'
  AND (current_state.latest_ir->>'captured_at_epoch_ms')::numeric > (p_observation->>'captured_at_epoch_ms')::numeric THEN
  RETURN jsonb_build_object('success',true,'node_id',target,'duplicate',true,'server_time',clock_timestamp());
 END IF;
 -- Retried or reordered uploads from one boot cannot roll back newer receiver state.
 IF current_state.latest_ir->>'boot_count'=p_observation->>'boot_count'
  AND coalesce(current_state.latest_ir->>'sequence','') ~ '^[0-9]{1,10}$'
  AND (current_state.latest_ir->>'sequence')::numeric >= (p_observation->>'sequence')::numeric THEN
  RETURN jsonb_build_object('success',true,'node_id',target,'duplicate',true,'server_time',clock_timestamp());
 END IF;
 seen := clock_timestamp();
 latest := p_observation || jsonb_build_object('received_at',seen,'node_id',target);
 UPDATE public.ecotrack_device_state SET latest_ir=latest,last_seen=seen,sleeping_until=NULL WHERE node_id=target;
 RETURN jsonb_build_object('success',true,'node_id',target,'server_time',seen);
END $$;
REVOKE ALL ON FUNCTION public.ecotrack_device_observe(text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ecotrack_device_observe(text,text,jsonb) TO anon,authenticated;

CREATE OR REPLACE FUNCTION public.ecotrack_broadcast_hardware_state()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE compact jsonb; payload jsonb;
BEGIN
 compact := NEW.latest_ir - 'raw_data';
 IF jsonb_typeof(compact->'last_decoded')='object' THEN
  compact := jsonb_set(compact,'{last_decoded}',(compact->'last_decoded')-'raw_data');
 END IF;
 payload := jsonb_build_object('version',1,'row',
  (to_jsonb(NEW)-'latest_ir') || jsonb_build_object('latest_ir',compact));
 BEGIN
  PERFORM realtime.send(payload,'device_state','ecotrack:hardware',true);
 EXCEPTION WHEN OTHERS THEN
  -- Persistence and Postgres Changes still work during a Broadcast service/configuration failure.
  RAISE WARNING 'EcoTrack hardware Broadcast unavailable: %',SQLERRM;
 END;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ecotrack_broadcast_hardware_state() FROM PUBLIC,anon,authenticated;

DO $$ BEGIN
 IF to_regclass('realtime.messages') IS NOT NULL AND
  to_regprocedure('realtime.send(jsonb,text,text,boolean)') IS NOT NULL AND
  to_regprocedure('realtime.topic()') IS NOT NULL THEN
  -- Supabase already owns/enables RLS on realtime.messages; only add scoped policies.
  DROP POLICY IF EXISTS ecotrack_hardware_broadcast_admin_read ON realtime.messages;
  CREATE POLICY ecotrack_hardware_broadcast_admin_read ON realtime.messages FOR SELECT TO authenticated
   USING (extension='broadcast' AND (select realtime.topic())='ecotrack:hardware' AND public.ecotrack_is_admin());
  DROP POLICY IF EXISTS ecotrack_hardware_broadcast_read_guard ON realtime.messages;
  CREATE POLICY ecotrack_hardware_broadcast_read_guard ON realtime.messages AS RESTRICTIVE FOR SELECT TO anon,authenticated
   USING ((select realtime.topic())<>'ecotrack:hardware' OR public.ecotrack_is_admin());
  DROP POLICY IF EXISTS ecotrack_hardware_broadcast_write_guard ON realtime.messages;
  CREATE POLICY ecotrack_hardware_broadcast_write_guard ON realtime.messages AS RESTRICTIVE FOR INSERT TO anon,authenticated
   WITH CHECK ((select realtime.topic())<>'ecotrack:hardware');
  DROP TRIGGER IF EXISTS ecotrack_hardware_broadcast ON public.ecotrack_device_state;
  CREATE TRIGGER ecotrack_hardware_broadcast AFTER INSERT OR UPDATE ON public.ecotrack_device_state
   FOR EACH ROW EXECUTE FUNCTION public.ecotrack_broadcast_hardware_state();
 ELSE
  RAISE NOTICE 'Supabase Broadcast is unavailable; immediate observations use Postgres Changes.';
 END IF;
END $$;
NOTIFY pgrst, 'reload schema';
COMMIT;
