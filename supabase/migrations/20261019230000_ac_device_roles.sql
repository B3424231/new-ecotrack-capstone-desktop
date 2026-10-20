-- Review/apply after controller registration, display-name and mobile staff registration migrations.
-- Does not issue credentials, fabricate readings, change hardware capabilities or rewrite history.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE public.nodes ADD COLUMN IF NOT EXISTS device_mode text NOT NULL DEFAULT 'controller'
 CHECK(device_mode IN ('monitoring','controller','both'));
ALTER TABLE public.nodes ADD COLUMN IF NOT EXISTS monitor_aircon_id text REFERENCES public.aircons(id) ON DELETE SET NULL;
ALTER TABLE public.nodes ADD COLUMN IF NOT EXISTS monitoring_id uuid UNIQUE;
ALTER TABLE public.nodes ADD COLUMN IF NOT EXISTS sensor_config jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS ecotrack_one_monitor_device_per_ac ON public.nodes(monitor_aircon_id)
 WHERE monitor_aircon_id IS NOT NULL AND device_mode IN ('monitoring','both');

CREATE OR REPLACE FUNCTION public.ecotrack_validate_ac_device_assignment(p_device_id text,p_setup jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE role_name text; target text; n public.nodes; ac public.aircons; config jsonb; low_pa numeric; high_pa numeric;
BEGIN
 IF to_regprocedure('public.ecotrack_require_controller_registration(text,jsonb)') IS NOT NULL THEN
  EXECUTE 'SELECT public.ecotrack_require_controller_registration($1,$2)' USING p_device_id,p_setup;
 ELSIF auth.uid() IS NULL OR public.ecotrack_is_admin() IS NOT TRUE THEN
  RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501';
 END IF;
 IF coalesce(p_device_id,'') !~ '^esp32s3-[a-f0-9]{12}$' OR jsonb_typeof(p_setup) IS DISTINCT FROM 'object'
  OR octet_length(p_setup::text)>4000 THEN RAISE EXCEPTION 'Invalid AC device setup'; END IF;
 role_name:=p_setup->>'device_mode';
 IF role_name IS NULL OR role_name NOT IN ('monitoring','controller','both') THEN RAISE EXCEPTION 'Choose an AC device type'; END IF;
 IF p_setup ? 'aircon_name' AND p_setup->'aircon_name'<>'null'::jsonb AND
  (jsonb_typeof(p_setup->'aircon_name')<>'string' OR length(btrim(p_setup->>'aircon_name')) NOT BETWEEN 1 AND 100 OR p_setup->>'aircon_name' ~ '[<>[:cntrl:]]') THEN RAISE EXCEPTION 'Enter a valid air conditioner name'; END IF;
 SELECT node_id INTO target FROM ecotrack_private.device_credentials WHERE device_id=p_device_id;
 IF target IS NULL THEN SELECT node_id INTO target FROM public.ecotrack_device_state WHERE device_id=p_device_id; END IF;
 SELECT * INTO n FROM public.nodes WHERE id=target;
 IF role_name<>'monitoring' THEN
  PERFORM public.ecotrack_validate_controller_assignment(p_device_id,p_setup);
 ELSE
  IF length(btrim(coalesce(p_setup->>'controller_name',''))) NOT BETWEEN 1 AND 100 OR p_setup->>'controller_name' ~ '[<>[:cntrl:]]'
   OR length(btrim(coalesce(p_setup->>'aircon_type',''))) NOT BETWEEN 1 AND 100 OR p_setup->>'aircon_type' ~ '[<>[:cntrl:]]'
   OR length(coalesce(p_setup->>'brand',''))>80 OR p_setup->>'brand' ~ '[<>[:cntrl:]]' THEN RAISE EXCEPTION 'Enter a valid device name, AC type and manufacturer'; END IF;
  IF EXISTS(SELECT 1 FROM public.nodes WHERE name=btrim(p_setup->>'controller_name') AND id IS DISTINCT FROM target) THEN RAISE EXCEPTION 'This device name already exists'; END IF;
  IF nullif(p_setup->>'room_id','') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.rooms WHERE id=p_setup->>'room_id') THEN RAISE EXCEPTION 'Choose an existing room'; END IF;
  IF EXISTS(SELECT 1 FROM public.aircons WHERE controller_node_id=target OR node_id IN(target,p_device_id,n.name)) THEN
   RAISE EXCEPTION 'Unassign this device from AC control before registering it for monitoring only'; END IF;
  IF p_setup->>'assignment_mode'='existing' THEN
   SELECT * INTO ac FROM public.aircons WHERE id=p_setup->>'aircon_id';
   IF ac.id IS NULL THEN RAISE EXCEPTION 'Select an existing AC'; END IF;
  ELSIF p_setup->>'assignment_mode'='new' THEN
   IF length(btrim(coalesce(p_setup->>'asset_tag',''))) NOT BETWEEN 1 AND 64 OR p_setup->>'asset_tag' ~ '[<>[:cntrl:]]' THEN RAISE EXCEPTION 'Enter an AC name'; END IF;
   IF EXISTS(SELECT 1 FROM public.aircons WHERE lower(asset_tag)=lower(btrim(p_setup->>'asset_tag')) AND id IS DISTINCT FROM n.monitor_aircon_id) THEN RAISE EXCEPTION 'This AC exists. Select its existing profile'; END IF;
  ELSE RAISE EXCEPTION 'Assign an air conditioner'; END IF;
 END IF;
 IF role_name IN ('monitoring','both') THEN
  config:=p_setup->'sensor_config';
  IF jsonb_typeof(config) IS DISTINCT FROM 'object' OR jsonb_typeof(config->'pressure_min_pa') IS DISTINCT FROM 'number'
   OR jsonb_typeof(config->'pressure_max_pa') IS DISTINCT FROM 'number' OR jsonb_typeof(config->'pressure_sensor') IS DISTINCT FROM 'string' OR config->>'pressure_sensor' ~ '[<>[:cntrl:]]' OR length(btrim(coalesce(config->>'pressure_sensor',''))) NOT BETWEEN 1 AND 80
   THEN RAISE EXCEPTION 'Enter the pressure sensor model and its measurement range'; END IF;
  low_pa:=(config->>'pressure_min_pa')::numeric; high_pa:=(config->>'pressure_max_pa')::numeric;
  IF low_pa < -100000 OR high_pa > 100000 OR low_pa>=high_pa THEN RAISE EXCEPTION 'Invalid pressure measurement range'; END IF;
  IF EXISTS(SELECT 1 FROM public.nodes WHERE monitor_aircon_id=p_setup->>'aircon_id' AND id IS DISTINCT FROM target AND device_mode IN ('monitoring','both')) THEN
   RAISE EXCEPTION 'This AC already has a monitoring device'; END IF;
 END IF;
 RETURN jsonb_build_object('valid',true,'node_id',target,'device_mode',role_name);
END $$;

CREATE OR REPLACE FUNCTION public.ecotrack_finish_ac_device_registration(p_node_id text,p_device_id text,p_setup jsonb,p_capture jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; n public.nodes; ac public.aircons; live public.ecotrack_device_state; role_name text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_device_id,0));
 PERFORM public.ecotrack_validate_ac_device_assignment(p_device_id,p_setup);
 role_name:=p_setup->>'device_mode';
 IF role_name<>'monitoring' THEN
  IF p_capture IS NOT NULL THEN
   IF to_regprocedure('public.ecotrack_finish_controller_registration_with_ir(text,text,jsonb,jsonb)') IS NULL THEN RAISE EXCEPTION 'Install the existing IR registration migration'; END IF;
   EXECUTE 'SELECT public.ecotrack_finish_controller_registration_with_ir($1,$2,$3,$4)' INTO result USING p_node_id,p_device_id,p_setup,p_capture;
  ELSE result:=public.ecotrack_finish_controller_registration(p_node_id,p_device_id,p_setup); END IF;
  SELECT * INTO ac FROM public.aircons WHERE id=result->'aircon'->>'id';
 ELSE
  IF p_capture IS NOT NULL THEN RAISE EXCEPTION 'Monitoring only does not register IR controls'; END IF;
  IF NOT EXISTS(SELECT 1 FROM ecotrack_private.device_credentials WHERE device_id=p_device_id AND node_id=p_node_id) THEN RAISE EXCEPTION 'Device identity mismatch'; END IF;
  SELECT * INTO n FROM public.nodes WHERE id=p_node_id FOR UPDATE;
  SELECT * INTO live FROM public.ecotrack_device_state WHERE node_id=p_node_id AND device_id=p_device_id;
  IF n.id IS NULL OR live.last_seen IS NULL OR live.last_seen<clock_timestamp()-interval '45 seconds'
   OR live.last_seen>clock_timestamp()+interval '5 seconds' OR live.sleeping_until>clock_timestamp() THEN RAISE EXCEPTION 'Wait for a fresh device heartbeat'; END IF;
  IF p_setup->>'assignment_mode'='existing' THEN SELECT * INTO ac FROM public.aircons WHERE id=p_setup->>'aircon_id' FOR UPDATE;
  ELSE
   PERFORM pg_advisory_xact_lock(hashtextextended('ac-name:'||lower(btrim(p_setup->>'asset_tag')),0));
   PERFORM public.ecotrack_validate_ac_device_assignment(p_device_id,p_setup);
   SELECT * INTO ac FROM public.aircons WHERE id=n.monitor_aircon_id AND lower(asset_tag)=lower(btrim(p_setup->>'asset_tag')) FOR UPDATE;
   IF ac.id IS NULL THEN
   INSERT INTO public.aircons(asset_tag,name,brand,model,aircon_type,room_id,node_id,controller_node_id,protocol,protocol_name,status)
    VALUES(btrim(p_setup->>'asset_tag'),coalesce(nullif(btrim(p_setup->>'aircon_name'),''),btrim(p_setup->>'asset_tag')),nullif(btrim(p_setup->>'brand'),''),p_setup->>'aircon_type',p_setup->>'aircon_type',nullif(p_setup->>'room_id',''),NULL,NULL,NULL,NULL,'unlinked') RETURNING * INTO ac;
   END IF;
  END IF;
  IF nullif(btrim(p_setup->>'aircon_name'),'') IS NOT NULL AND ac.name IS DISTINCT FROM btrim(p_setup->>'aircon_name') THEN
   UPDATE public.aircons SET name=btrim(p_setup->>'aircon_name'),updated_at=clock_timestamp() WHERE id=ac.id RETURNING * INTO ac;
  END IF;
  PERFORM set_config('ecotrack.registration_verify','on',true);
  UPDATE public.nodes SET name=btrim(p_setup->>'controller_name'),room_id=nullif(p_setup->>'room_id',''),brand=nullif(btrim(p_setup->>'brand'),''),
   aircon_type=p_setup->>'aircon_type',admin_verified_at=clock_timestamp(),admin_verified_by=auth.uid(),deployment_saved_at=clock_timestamp(),updated=clock_timestamp()
   WHERE id=p_node_id RETURNING * INTO n;
  result:=jsonb_build_object('success',true,'registered',true,'connected',true,'aircon',to_jsonb(ac),'cloud_state',to_jsonb(live));
 END IF;
 UPDATE public.nodes SET device_mode=role_name,monitor_aircon_id=CASE WHEN role_name='controller' THEN NULL ELSE ac.id END,
  monitoring_id=CASE WHEN role_name='controller' THEN monitoring_id ELSE coalesce(monitoring_id,gen_random_uuid()) END,
  sensor_config=CASE WHEN role_name='controller' THEN sensor_config ELSE p_setup->'sensor_config' END WHERE id=p_node_id RETURNING * INTO n;
 RETURN result||jsonb_build_object('node',to_jsonb(n));
END $$;
REVOKE ALL ON FUNCTION public.ecotrack_validate_ac_device_assignment(text,jsonb),public.ecotrack_finish_ac_device_registration(text,text,jsonb,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ecotrack_validate_ac_device_assignment(text,jsonb),public.ecotrack_finish_ac_device_registration(text,text,jsonb,jsonb) TO authenticated;

-- Enforce the chosen role for every command caller, including old clients.
CREATE OR REPLACE FUNCTION public.ecotrack_check_device_command_role() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.kind IN ('ac_intent','learn_ir') AND EXISTS(SELECT 1 FROM public.nodes WHERE id=NEW.node_id AND device_mode='monitoring') THEN
  RAISE EXCEPTION 'This AC device is registered for monitoring only'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ecotrack_device_command_role ON public.ecotrack_device_commands;
CREATE TRIGGER ecotrack_device_command_role BEFORE INSERT ON public.ecotrack_device_commands FOR EACH ROW EXECUTE FUNCTION public.ecotrack_check_device_command_role();
NOTIFY pgrst,'reload schema';
COMMIT;
