-- Run once as the project owner in Supabase SQL Editor.
-- Requires supabase_cloud_hardware_migration.sql. Does not delete pending valid commands.
-- Finished command receipts are kept for 1 hour; cleanup runs every 5 minutes.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_cron;
DO $$ BEGIN
 IF to_regclass('public.ecotrack_device_commands') IS NULL THEN
  RAISE EXCEPTION 'Install the EcoTrack cloud hardware migration first';
 END IF;
END $$;

ALTER TABLE public.ecotrack_device_commands ADD COLUMN IF NOT EXISTS finished_at timestamptz;
UPDATE public.ecotrack_device_commands
 SET finished_at=coalesce(acknowledged_at,CASE WHEN status='expired' THEN expires_at ELSE created_at END)
 WHERE status IN ('completed','failed','expired','superseded') AND finished_at IS NULL;

CREATE OR REPLACE FUNCTION ecotrack_private.stamp_finished_command()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
 IF NEW.status IN ('completed','failed','expired','superseded') THEN
  IF TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status OR NEW.finished_at IS NULL THEN
   NEW.finished_at := now();
  END IF;
 ELSE NEW.finished_at := NULL;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ecotrack_private.stamp_finished_command() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS ecotrack_stamp_finished_command ON public.ecotrack_device_commands;
CREATE TRIGGER ecotrack_stamp_finished_command
 BEFORE INSERT OR UPDATE OF status ON public.ecotrack_device_commands
 FOR EACH ROW EXECUTE FUNCTION ecotrack_private.stamp_finished_command();
CREATE INDEX IF NOT EXISTS ecotrack_finished_commands_cleanup_idx
 ON public.ecotrack_device_commands(finished_at)
 WHERE status IN ('completed','failed','expired','superseded');
CREATE INDEX IF NOT EXISTS ecotrack_expiring_commands_cleanup_idx
 ON public.ecotrack_device_commands(expires_at)
 WHERE status IN ('queued','claimed');

CREATE OR REPLACE FUNCTION public.ecotrack_device_exchange(p_device_id text,p_token text,p_status jsonb,p_ack jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE target text; n public.nodes; c public.ecotrack_device_commands; ack_id uuid; sleep_until timestamptz; latest jsonb; cfg jsonb; seconds numeric; ack_status text;
BEGIN
 SELECT node_id INTO target FROM ecotrack_private.device_credentials WHERE device_id=p_device_id AND p_token ~ '^[a-f0-9]{64}$' AND token_hash=sha256(convert_to(p_token,'UTF8'));
 IF target IS NULL THEN RAISE EXCEPTION 'Invalid device credential' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_status) IS DISTINCT FROM 'object' OR jsonb_typeof(p_status->'capabilities') IS DISTINCT FROM 'object' OR jsonb_typeof(p_status->'capabilities'->'ir_receiver') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_status->'capabilities'->'ir_transmitter') IS DISTINCT FROM 'boolean' OR octet_length(p_status::text)>16000 THEN RAISE EXCEPTION 'Invalid device status'; END IF;
 sleep_until := nullif(p_status->>'sleeping_until','')::timestamptz;
 IF sleep_until IS NOT NULL AND (sleep_until<now()-interval '5 seconds' OR sleep_until>now()+interval '1 day 5 minutes') THEN RAISE EXCEPTION 'Invalid sleep deadline'; END IF;
 IF p_status ? 'latest_ir' THEN
  latest := p_status->'latest_ir';
  IF jsonb_typeof(latest) IS DISTINCT FROM 'object' OR coalesce(latest->>'raw_data','') !~ '^[0-9]+(,[0-9]+)+$' OR coalesce(latest->>'protocol','')='' OR octet_length(latest::text)>12000 THEN RAISE EXCEPTION 'Invalid IR capture'; END IF;
  latest := latest || jsonb_build_object('received_at',now(),'node_id',target);
 END IF;
 IF p_ack IS NOT NULL AND p_ack<>'null'::jsonb THEN
  IF jsonb_typeof(p_ack) IS DISTINCT FROM 'object' OR jsonb_typeof(p_ack->'success') IS DISTINCT FROM 'boolean' OR octet_length(p_ack::text)>14000 THEN RAISE EXCEPTION 'Invalid device acknowledgement'; END IF;
  ack_id := (p_ack->>'command_id')::uuid;
  SELECT * INTO c FROM public.ecotrack_device_commands WHERE id=ack_id AND node_id=target FOR UPDATE;
  IF ack_id IS NULL THEN RAISE EXCEPTION 'Invalid device acknowledgement'; END IF;
  IF c.id IS NULL AND EXISTS(SELECT 1 FROM public.ecotrack_device_commands WHERE id=ack_id) THEN
   RAISE EXCEPTION 'Command does not belong to this device' USING ERRCODE='42501';
  END IF;
  -- A valid device may retry an old ACK after its terminal row was cleaned.
  -- An absent row is ignored; it cannot recreate a command or update an AC result.
  IF c.status='queued' THEN RAISE EXCEPTION 'Command has not been claimed'; END IF;
  IF c.status='claimed' AND c.expires_at>now() THEN
   IF c.kind='learn_ir' AND (p_ack->>'success')::boolean AND (coalesce(p_ack->>'raw_data','') !~ '^[0-9]+(,[0-9]+)+$' OR coalesce(p_ack->>'protocol','')='' OR coalesce(p_ack->>'hex','')='') THEN RAISE EXCEPTION 'Actual IR capture acknowledgement required'; END IF;
   IF c.kind='configure' AND (p_ack->>'success')::boolean AND (jsonb_typeof(p_ack->'interval_ms') IS DISTINCT FROM 'number' OR (p_ack->>'interval_ms')::numeric<>(c.payload->>'interval_seconds')::numeric*1000 OR p_ack->>'wake_time' IS DISTINCT FROM c.payload->>'wake_time' OR p_ack->>'sleep_time' IS DISTINCT FROM c.payload->>'sleep_time') THEN RAISE EXCEPTION 'Applied schedule acknowledgement does not match request'; END IF;
   IF c.kind='ac_intent' AND (p_ack->>'success')::boolean AND coalesce(p_ack->>'delivery_status','')<>'transmitted' THEN RAISE EXCEPTION 'IR transmission acknowledgement required'; END IF;
   ack_status := CASE WHEN (p_ack->>'success')::boolean THEN 'completed' ELSE 'failed' END;
   UPDATE public.ecotrack_device_commands SET status=ack_status,result=p_ack,acknowledged_at=now() WHERE id=c.id;
   IF c.kind='ac_intent' THEN
    UPDATE public.aircons SET command_status=CASE WHEN ack_status='completed' THEN 'transmitted' ELSE 'failed' END,command_status_at=now() WHERE id=c.payload->>'aircon_id' AND command_id::text=c.id::text;
   END IF;
  END IF;
 END IF;
 INSERT INTO public.ecotrack_device_state(node_id,device_id,last_seen,sleeping_until,firmware_version,wifi_ssid,ip_address,rssi,capabilities,latest_ir,applied_config)
 VALUES(target,p_device_id,now(),sleep_until,left(p_status->>'firmware_version',80),left(p_status->>'wifi_ssid',32),left(p_status->>'ip_address',64),(p_status->>'rssi')::integer,coalesce(p_status->'capabilities','{}'),latest,p_status->'applied_config')
 ON CONFLICT(node_id) DO UPDATE SET last_seen=now(),sleeping_until=EXCLUDED.sleeping_until,firmware_version=EXCLUDED.firmware_version,wifi_ssid=EXCLUDED.wifi_ssid,ip_address=EXCLUDED.ip_address,rssi=EXCLUDED.rssi,capabilities=EXCLUDED.capabilities,latest_ir=coalesce(EXCLUDED.latest_ir,ecotrack_device_state.latest_ir),applied_config=EXCLUDED.applied_config;
 UPDATE public.nodes SET status=CASE WHEN sleep_until IS NULL THEN 'online' ELSE 'offline' END,rssi=(p_status->>'rssi')::numeric,ip_address=nullif(p_status->>'ip_address',''),wifi_ssid=nullif(p_status->>'wifi_ssid',''),updated=now() WHERE id=target;
 UPDATE public.ecotrack_device_commands SET status='expired',result=jsonb_build_object('success',false,'error','Command expired before completion') WHERE node_id=target AND status IN ('queued','claimed') AND expires_at<=now();
 UPDATE public.aircons a SET command_status='failed',command_status_at=now() FROM public.ecotrack_device_commands d WHERE d.node_id=target AND d.kind='ac_intent' AND d.status='expired' AND a.id=d.payload->>'aircon_id' AND a.command_id::text=d.id::text AND a.command_status='queued';
 SELECT * INTO n FROM public.nodes WHERE id=target;
 seconds := n.interval_val * CASE lower(n.interval_unit) WHEN 'seconds' THEN 1 WHEN 'minutes' THEN 60 WHEN 'hours' THEN 3600 ELSE 0 END;
 IF seconds IS NULL OR seconds<1 OR seconds>86400 THEN seconds:=5; END IF;
 cfg := jsonb_build_object('interval_seconds',seconds::integer,'wake_time',n.wake_time,'sleep_time',n.sleep_time,'timezone_offset_seconds',28800);
 IF p_status ? 'report_id' THEN
  IF coalesce(p_status->>'report_id','') !~ ('^' || p_device_id || '-[0-9]{1,10}-[0-9]{1,10}$') THEN RAISE EXCEPTION 'Invalid connectivity report ID'; END IF;
  INSERT INTO public.telemetry(id,node_id,sensor_name,room_name,aircon_type,temperature,pressure,battery,rssi,status,created,interval_seconds,ac_on)
  VALUES('cloud_' || (p_status->>'report_id'),target,n.name,(SELECT name FROM public.rooms WHERE id=n.room_id),n.aircon_type,NULL,NULL,NULL,(p_status->>'rssi')::numeric,'online',now(),seconds,NULL)
  ON CONFLICT(id) DO NOTHING;
 END IF;
 c := NULL;
 IF sleep_until IS NULL THEN
  -- A single in-flight command per device; re-deliver after a reconnect until acknowledged.
  SELECT * INTO c FROM public.ecotrack_device_commands WHERE node_id=target AND status='claimed' ORDER BY created_at,id LIMIT 1 FOR UPDATE;
  IF c.id IS NULL THEN
   SELECT * INTO c FROM public.ecotrack_device_commands WHERE node_id=target AND status='queued' AND expires_at>now() ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED;
   IF c.id IS NOT NULL THEN UPDATE public.ecotrack_device_commands SET status='claimed',claimed_at=now() WHERE id=c.id RETURNING * INTO c; END IF;
  END IF;
 END IF;
 RETURN jsonb_build_object('success',true,'node_id',target,'server_time',now(),'config',cfg,'command',CASE WHEN c.id IS NULL THEN NULL ELSE to_jsonb(c) || jsonb_build_object('created_at_epoch_ms',(extract(epoch FROM c.created_at)*1000)::bigint) END);
END $$;

CREATE OR REPLACE FUNCTION ecotrack_private.cleanup_device_commands()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
SET lock_timeout = '2s' AS $$
DECLARE expired_count integer; deleted_count integer;
BEGIN
 -- Preserve a failure receipt first, including for a device that never reconnects.
 WITH overdue AS (
  SELECT id FROM public.ecotrack_device_commands
  WHERE status IN ('queued','claimed') AND expires_at<=now()
  ORDER BY expires_at,id LIMIT 5000 FOR UPDATE SKIP LOCKED
 ), expired AS (
  UPDATE public.ecotrack_device_commands c
  SET status='expired',result=jsonb_build_object('success',false,'command_id',c.id,'error','Command expired before completion')
  FROM overdue WHERE c.id=overdue.id RETURNING c.*
 ), affected_aircons AS (
  UPDATE public.aircons a SET command_status='failed',command_status_at=now()
  FROM expired c WHERE c.kind='ac_intent' AND a.id=c.payload->>'aircon_id'
  AND a.command_id::text=c.id::text AND a.command_status='queued'
  RETURNING a.id
 )
 SELECT count(*) INTO expired_count FROM expired;

 -- Keep the receipt long enough for UI polling, delayed notifications and acknowledgement retries.
 WITH stale AS (
  SELECT id FROM public.ecotrack_device_commands
  WHERE status IN ('completed','failed','expired','superseded')
  AND finished_at<now()-interval '1 hour'
  ORDER BY finished_at,id LIMIT 5000 FOR UPDATE SKIP LOCKED
 )
 DELETE FROM public.ecotrack_device_commands c USING stale WHERE c.id=stale.id;
 GET DIAGNOSTICS deleted_count=ROW_COUNT;

 -- Keep only seven days of this cleanup job's own run history.
 DELETE FROM cron.job_run_details d USING cron.job j
 WHERE d.jobid=j.jobid AND j.jobname='ecotrack-command-cleanup'
 AND d.end_time<now()-interval '7 days';
 RETURN jsonb_build_object('expired',expired_count,'deleted',deleted_count);
END $$;
REVOKE ALL ON FUNCTION ecotrack_private.cleanup_device_commands() FROM PUBLIC,anon,authenticated;

SELECT cron.schedule('ecotrack-command-cleanup','*/5 * * * *',
 'SELECT ecotrack_private.cleanup_device_commands();');
-- Remove already-old terminal rows now. The next runs do not depend on the desktop or ESP32.
SELECT ecotrack_private.cleanup_device_commands();
NOTIFY pgrst, 'reload schema';
COMMIT;
