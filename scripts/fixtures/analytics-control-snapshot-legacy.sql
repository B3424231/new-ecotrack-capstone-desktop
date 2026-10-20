-- Restore only the two previous telemetry snapshot function bodies; no data is deleted.
BEGIN;
CREATE OR REPLACE FUNCTION ecotrack_private.guard_ac_analytics_sample()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$
;
CREATE OR REPLACE FUNCTION public.ecotrack_snapshot_aircon_control()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare matches text[]; ac public.aircons%rowtype; observed_at timestamptz;
begin
  -- Bind by an exact ID/name relationship, never room or fuzzy name matching.
  select array_agg(distinct a.id) into matches from public.aircons a
    left join public.nodes n on n.id=a.node_id or n.id=a.controller_node_id
    where a.node_id=new.node_id or a.controller_node_id=new.node_id or n.name=new.node_id;
  new.aircon_id=null; new.control_snapshot=null;
  if cardinality(matches) is distinct from 1 then return new; end if;
  select * into ac from public.aircons where id=matches[1];
  observed_at=coalesce(new.created::timestamptz,clock_timestamp());
  new.aircon_id=ac.id;
  new.control_snapshot=jsonb_strip_nulls(jsonb_build_object(
    'desired_state',case when ac.commanded_at<=observed_at then ac.desired_state end,
    'command_id',case when ac.commanded_at<=observed_at then ac.command_id end,
    'command_status',case when ac.commanded_at<=observed_at then case when ac.command_status_at<=observed_at then ac.command_status else 'queued' end end,
    'commanded_at',case when ac.commanded_at<=observed_at then ac.commanded_at end,
    'reported_state',case when ac.reported_at<=observed_at then ac.reported_state end,
    'reported_at',case when ac.reported_at<=observed_at then ac.reported_at end));
  return new;
end $function$
;
COMMIT;
