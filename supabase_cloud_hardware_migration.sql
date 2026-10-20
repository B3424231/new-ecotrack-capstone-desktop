-- EcoTrack cloud hardware transport. Run once in Supabase SQL Editor.
-- Requires the existing ecotrack_is_admin() helper and nodes/aircons tables.
-- No Wi-Fi passwords or plaintext device tokens are stored in cloud tables.
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('public.ecotrack_is_admin()') IS NULL THEN
  RAISE EXCEPTION 'Install the existing EcoTrack administrator authentication first';
 END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS ecotrack_private;
REVOKE ALL ON SCHEMA ecotrack_private FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS ecotrack_private.device_credentials (
 device_id text PRIMARY KEY CHECK (device_id ~ '^esp32s3-[a-f0-9]{12}$'),
 node_id text NOT NULL UNIQUE REFERENCES public.nodes(id) ON DELETE CASCADE,
 token_hash bytea NOT NULL,
 issued_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON ecotrack_private.device_credentials FROM PUBLIC, anon, authenticated;
ALTER TABLE ecotrack_private.device_credentials ENABLE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS public.ecotrack_device_state (
 node_id text PRIMARY KEY REFERENCES public.nodes(id) ON DELETE CASCADE,
 device_id text NOT NULL UNIQUE,
 last_seen timestamptz,
 sleeping_until timestamptz,
 firmware_version text,
 wifi_ssid text,
 ip_address text,
 rssi integer,
 capabilities jsonb NOT NULL DEFAULT '{}',
 latest_ir jsonb,
 applied_config jsonb
);
CREATE TABLE IF NOT EXISTS public.ecotrack_device_commands (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 node_id text NOT NULL REFERENCES public.nodes(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('ping','learn_ir','configure','ac_intent')),
 payload jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','claimed','completed','failed','expired','superseded')),
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 claimed_at timestamptz,
 acknowledged_at timestamptz,
 result jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS ecotrack_hardware_identity_idx ON public.nodes(name) WHERE name ~ '^esp32s3-[a-f0-9]{12}$';
CREATE INDEX IF NOT EXISTS ecotrack_device_commands_poll_idx ON public.ecotrack_device_commands(node_id, created_at) WHERE status IN ('queued','claimed');
ALTER TABLE public.ecotrack_device_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ecotrack_device_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ecotrack_device_state, public.ecotrack_device_commands FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ecotrack_device_state, public.ecotrack_device_commands TO authenticated;
DROP POLICY IF EXISTS ecotrack_device_state_admin_read ON public.ecotrack_device_state;
CREATE POLICY ecotrack_device_state_admin_read ON public.ecotrack_device_state FOR SELECT TO authenticated USING (public.ecotrack_is_admin());
DROP POLICY IF EXISTS ecotrack_device_commands_admin_read ON public.ecotrack_device_commands;
CREATE POLICY ecotrack_device_commands_admin_read ON public.ecotrack_device_commands FOR SELECT TO authenticated USING (public.ecotrack_is_admin());

CREATE OR REPLACE FUNCTION public.ecotrack_register_cloud_device(p_device_id text, p_metadata jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n public.nodes; token text; target text;
BEGIN
 IF auth.uid() IS NULL OR NOT public.ecotrack_is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 IF p_device_id IS NULL OR p_device_id !~ '^esp32s3-[a-f0-9]{12}$' OR jsonb_typeof(p_metadata) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid device registration'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_device_id,0));
 SELECT node_id INTO target FROM ecotrack_private.device_credentials WHERE device_id=p_device_id;
 IF target IS NULL THEN
  SELECT id INTO target FROM public.nodes WHERE name=p_device_id;
 END IF;
 IF target IS NULL THEN
  INSERT INTO public.nodes(name,status,room_id,brand,aircon_type,temp,rssi,battery,ip_address,wifi_ssid,wake_time,sleep_time,interval_val,interval_unit)
  VALUES(p_device_id,'offline',nullif(p_metadata->>'room_id',''),nullif(p_metadata->>'brand',''),nullif(p_metadata->>'aircon_type',''),NULL,NULL,NULL,NULL,NULL,NULL,NULL,5,'Seconds') RETURNING * INTO n;
 ELSE
  UPDATE public.nodes SET room_id=nullif(p_metadata->>'room_id',''),brand=nullif(p_metadata->>'brand',''),aircon_type=nullif(p_metadata->>'aircon_type','') WHERE id=target RETURNING * INTO n;
 END IF;
 token := replace(gen_random_uuid()::text || gen_random_uuid()::text,'-','');
 INSERT INTO ecotrack_private.device_credentials(device_id,node_id,token_hash) VALUES(p_device_id,n.id,sha256(convert_to(token,'UTF8')))
 ON CONFLICT(device_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,issued_at=now();
 INSERT INTO public.ecotrack_device_state(node_id,device_id) VALUES(n.id,p_device_id)
 ON CONFLICT(node_id) DO NOTHING;
 RETURN jsonb_build_object('node',to_jsonb(n),'device_id',p_device_id,'device_token',token);
END $$;

CREATE OR REPLACE FUNCTION public.ecotrack_cloud_request(p_node_id text,p_kind text,p_payload jsonb,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n public.nodes; s public.ecotrack_device_state; c public.ecotrack_device_commands; ac public.aircons; seconds numeric; state jsonb; life interval; chosen_value numeric; chosen_unit text;
BEGIN
 IF auth.uid() IS NULL OR NOT public.ecotrack_is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 IF p_request_id IS NULL OR p_kind IS NULL OR p_kind NOT IN ('ping','learn_ir','configure','ac_intent') OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid hardware request'; END IF;
 SELECT * INTO n FROM public.nodes WHERE id=p_node_id FOR UPDATE;
 SELECT * INTO s FROM public.ecotrack_device_state WHERE node_id=p_node_id;
 IF n.id IS NULL OR s.node_id IS NULL THEN RAISE EXCEPTION 'Provision this controller through Bluetooth first'; END IF;
 SELECT * INTO c FROM public.ecotrack_device_commands WHERE id=p_request_id;
 IF c.id IS NOT NULL THEN
  IF c.node_id<>p_node_id OR c.kind<>p_kind OR c.payload<>p_payload OR c.created_by<>auth.uid() THEN RAISE EXCEPTION 'Request ID conflict'; END IF;
  RETURN to_jsonb(c);
 END IF;
 IF p_kind='configure' THEN
  IF jsonb_typeof(p_payload->'interval_seconds') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Invalid report interval'; END IF;
  seconds := (p_payload->>'interval_seconds')::numeric;
  IF seconds<1 OR seconds>86400 OR seconds<>trunc(seconds) THEN RAISE EXCEPTION 'Report interval must be 1..86400 seconds'; END IF;
  IF coalesce(p_payload->>'wake_time','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' OR coalesce(p_payload->>'sleep_time','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN RAISE EXCEPTION 'Invalid wake/sleep time'; END IF;
  chosen_value := seconds; chosen_unit := 'Seconds';
  IF p_payload ? 'interval_val' OR p_payload ? 'interval_unit' THEN
   IF jsonb_typeof(p_payload->'interval_val') IS DISTINCT FROM 'number' OR coalesce(p_payload->>'interval_unit','') NOT IN ('Seconds','Minutes','Hours') THEN RAISE EXCEPTION 'Invalid interval unit/value'; END IF;
   chosen_value := (p_payload->>'interval_val')::numeric; chosen_unit := p_payload->>'interval_unit';
   IF chosen_value<=0 OR chosen_value<>trunc(chosen_value) OR chosen_value * (CASE chosen_unit WHEN 'Seconds' THEN 1 WHEN 'Minutes' THEN 60 ELSE 3600 END) <> seconds THEN RAISE EXCEPTION 'Interval unit/value does not match seconds'; END IF;
  END IF;
  UPDATE public.nodes SET interval_val=chosen_value,interval_unit=chosen_unit,wake_time=p_payload->>'wake_time',sleep_time=p_payload->>'sleep_time',updated=now() WHERE id=n.id;
  life := interval '1 day';
 ELSIF p_kind='ac_intent' THEN
  IF coalesce((s.capabilities->>'ir_transmitter')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'This device is receiver-only; an IR transmitter is required'; END IF;
  SELECT * INTO ac FROM public.aircons WHERE id=p_payload->>'aircon_id' AND (node_id=n.id OR controller_node_id=n.id OR node_id=n.name) FOR UPDATE;
  state := p_payload->'state';
  IF ac.id IS NULL OR jsonb_typeof(state) IS DISTINCT FROM 'object' OR coalesce(p_payload->>'protocol','')='' OR
   coalesce(state->>'power','') NOT IN ('on','off') OR coalesce(state->>'mode','') NOT IN ('cool','dry','fan','auto','heat') OR
   jsonb_typeof(state->'temp') IS DISTINCT FROM 'number' OR coalesce(state->>'fan','') NOT IN ('auto','low','medium','high','quiet','silent','turbo') THEN RAISE EXCEPTION 'Invalid full AC state'; END IF;
  IF (state->>'temp')::numeric<16 OR (state->>'temp')::numeric>32 THEN RAISE EXCEPTION 'Invalid temperature'; END IF;
  UPDATE public.aircons SET desired_state=state,command_id=p_request_id,command_status='queued',command_status_at=now(),commanded_at=now() WHERE id=ac.id;
  life := interval '2 minutes';
 ELSIF p_kind='learn_ir' THEN
  IF coalesce((s.capabilities->>'ir_receiver')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'IR receiver capability has not been reported'; END IF;
  life := interval '30 seconds';
 ELSE life := interval '20 seconds';
 END IF;
 IF p_kind IN ('configure','ac_intent') THEN
  UPDATE public.ecotrack_device_commands SET status='superseded',result=jsonb_build_object('error','Replaced by newer settings') WHERE node_id=n.id AND kind=p_kind AND status IN ('queued','claimed');
 END IF;
 INSERT INTO public.ecotrack_device_commands(id,node_id,kind,payload,created_by,expires_at) VALUES(p_request_id,n.id,p_kind,p_payload,auth.uid(),now()+life) RETURNING * INTO c;
 RETURN to_jsonb(c);
END $$;

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

REVOKE ALL ON FUNCTION public.ecotrack_register_cloud_device(text,jsonb) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.ecotrack_cloud_request(text,text,jsonb,uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.ecotrack_device_exchange(text,text,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ecotrack_register_cloud_device(text,jsonb),public.ecotrack_cloud_request(text,text,jsonb,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ecotrack_device_exchange(text,text,jsonb,jsonb) TO anon,authenticated;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
  IF NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='ecotrack_device_state') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.ecotrack_device_state; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='ecotrack_device_commands') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.ecotrack_device_commands; END IF;
 END IF;
END $$;
NOTIFY pgrst, 'reload schema';
COMMIT;
