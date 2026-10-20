-- Stop routine AC analytics while its selected power setting is OFF.
-- Run this complete file as project owner in Supabase SQL Editor.
-- Heartbeats, IR observations and command receipts still use their existing tables.
-- Existing history is preserved. No firmware reflash is needed.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';
DO $$
BEGIN
 IF to_regclass('public.telemetry') IS NULL OR to_regclass('public.aircons') IS NULL
    OR to_regclass('public.ecotrack_device_state') IS NULL THEN
  RAISE EXCEPTION 'Install the EcoTrack cloud hardware migration first';
 END IF;
 -- Take the only altered table lock before DDL; never wait behind device traffic.
 BEGIN
  LOCK TABLE public.telemetry IN ACCESS EXCLUSIVE MODE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'Analytics table is busy. Retry this complete file in SQL Editor.'
   USING ERRCODE = '55P03';
 END;
END $$;
ALTER TABLE public.telemetry ADD COLUMN IF NOT EXISTS aircon_id text;
ALTER TABLE public.telemetry ADD COLUMN IF NOT EXISTS control_snapshot jsonb;

CREATE OR REPLACE FUNCTION ecotrack_private.analytics_state_time(value text)
RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
 RETURN coalesce(nullif(value,'')::timestamptz,'1970-01-01T00:00:00Z'::timestamptz);
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
 RETURN '1970-01-01T00:00:00Z'::timestamptz;
END $$;

CREATE OR REPLACE FUNCTION ecotrack_private.analytics_snapshot_power(snapshot jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE state_key text; time_key text; stamp timestamptz; best_time timestamptz;
 selected text; candidate jsonb;
BEGIN
 FOR state_key,time_key IN
  SELECT * FROM (VALUES ('configured_state',NULL::text),('desired_state','commanded_at'),
    ('reported_state','reported_at'),('observed_remote_state','observed_remote_at')) AS sources(state_key,time_key)
 LOOP
  candidate := snapshot->state_key->'power';
  IF candidate IS NULL OR candidate='null'::jsonb THEN CONTINUE; END IF;
  stamp := ecotrack_private.analytics_state_time(CASE WHEN state_key='observed_remote_state'
    THEN coalesce(snapshot->'observed_remote_field_at'->>'power',snapshot->>time_key)
    ELSE snapshot->>time_key END);
  IF best_time IS NULL OR stamp>=best_time THEN
   selected := lower(snapshot->state_key->>'power'); best_time := stamp;
  END IF;
 END LOOP;
 RETURN CASE WHEN selected IN ('true','on','1') THEN true
             WHEN selected IN ('false','off','0') THEN false ELSE NULL END;
END $$;

CREATE OR REPLACE FUNCTION ecotrack_private.guard_ac_analytics_sample()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE snapshot jsonb; profiles jsonb; profile jsonb; matches integer; device public.ecotrack_device_state;
 frame jsonb; seen timestamptz; captured numeric; selected_power boolean;
BEGIN
 -- This trigger only gates routine telemetry, not management or command audits.
 IF to_jsonb(NEW)->>'event_type'='schedule_updated' THEN RETURN NEW; END IF;
 IF lower(coalesce(NEW.status,'')) IN ('off','offline','disconnected','sleeping','asleep') THEN RETURN NULL; END IF;
 SELECT s.* INTO device FROM public.ecotrack_device_state s
 LEFT JOIN public.nodes n ON n.id=s.node_id
 WHERE s.node_id=NEW.node_id OR s.device_id=NEW.node_id OR n.name=NEW.node_id OR n.name=NEW.sensor_name
 ORDER BY CASE WHEN s.node_id=NEW.node_id OR s.device_id=NEW.node_id THEN 0 ELSE 1 END LIMIT 1;
 IF device.sleeping_until>now() THEN RETURN NULL; END IF;
 snapshot := NEW.control_snapshot::jsonb;
 -- An explicit historical snapshot belongs to that reading, not today's AC settings.
 IF snapshot IS NULL OR snapshot='null'::jsonb THEN
  SELECT count(*),jsonb_agg(to_jsonb(a)) INTO matches,profiles FROM public.aircons a
  WHERE (NEW.aircon_id IS NULL OR a.id=NEW.aircon_id)
   AND coalesce(nullif(a.controller_node_id,''),a.node_id) IN (coalesce(device.node_id,NEW.node_id),device.device_id,NEW.sensor_name);
  IF matches=1 THEN
   profile := profiles->0; NEW.aircon_id := profile->>'id';
   snapshot := jsonb_build_object('desired_state',profile->'desired_state','commanded_at',profile->'commanded_at',
    'reported_state',profile->'reported_state','reported_at',profile->'reported_at',
    'command_id',profile->'command_id','command_status',profile->'command_status');
   frame := device.latest_ir;
   IF frame->>'frame_kind'='settings_only' OR jsonb_typeof(frame->'state') IS DISTINCT FROM 'object'
    THEN frame:=frame->'last_decoded'; END IF;
   IF jsonb_typeof(frame->'state')='object' AND frame->>'frame_kind' IS DISTINCT FROM 'settings_only'
     AND coalesce(frame->>'protocol','') ~ '^[A-Z][A-Z0-9_]{1,48}$' AND frame->>'protocol'<>'UNKNOWN'
     AND (coalesce(frame->>'raw_data','') ~ '^[0-9]+(,[0-9]+)+$' OR coalesce(frame->>'raw_count','') ~ '^[1-9][0-9]*$') THEN
    seen := ecotrack_private.analytics_state_time(coalesce(frame->>'received_at',device.last_seen::text));
    BEGIN
     captured := (frame->>'captured_at_epoch_ms')::numeric;
     IF captured>0 AND captured<=8640000000000000 AND to_timestamp(captured/1000)<=seen+interval '5 seconds'
      THEN seen:=to_timestamp(captured/1000); END IF;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN NULL;
    END;
    snapshot := snapshot || jsonb_build_object('observed_remote_state',frame->'state',
     'observed_remote_at',seen,'observed_remote_protocol',frame->>'protocol',
     'observed_remote_field_at',(SELECT coalesce(jsonb_object_agg(f.key,
       CASE WHEN ecotrack_private.analytics_state_time(frame->'field_at'->>f.key)>'1970-01-01T00:00:00Z'::timestamptz
             AND ecotrack_private.analytics_state_time(frame->'field_at'->>f.key)<=seen+interval '5 seconds'
        THEN frame->'field_at'->f.key ELSE to_jsonb(seen) END),'{}'::jsonb)
      FROM jsonb_each(frame->'state') f WHERE f.key<>'source'));
   END IF;
   NEW.control_snapshot := snapshot;
  END IF;
 END IF;
 selected_power := coalesce(ecotrack_private.analytics_snapshot_power(snapshot),NEW.ac_on);
 IF selected_power IS DISTINCT FROM true THEN RETURN NULL; END IF;
 -- Requested/remote ON is a recording gate, not fabricated physical feedback.
 -- Keep ac_on and all hardware measurements exactly as supplied.
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ecotrack_private.analytics_state_time(text),
 ecotrack_private.analytics_snapshot_power(jsonb),ecotrack_private.guard_ac_analytics_sample()
 FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS ecotrack_guard_ac_analytics ON public.telemetry;
CREATE TRIGGER ecotrack_guard_ac_analytics BEFORE INSERT ON public.telemetry
 FOR EACH ROW EXECUTE FUNCTION ecotrack_private.guard_ac_analytics_sample();
NOTIFY pgrst,'reload schema';
COMMIT;
