-- Registration modal: validated assignment, metadata-safe credential refresh, atomic final save.
-- Prerequisites: supabase_cloud_hardware_migration.sql, supabase_device_nodes_sync_migration.sql,
-- and supabase_aircons_protocol_migration.sql. Uses existing tables and columns. Repeatable.
BEGIN;
DO $$ BEGIN
 IF to_regclass('ecotrack_private.device_credentials') IS NULL OR to_regclass('public.ecotrack_device_state') IS NULL THEN
  RAISE EXCEPTION 'Install the existing cloud hardware migration first';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='nodes' AND column_name='protocol_name')
  OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='aircons' AND column_name='controller_node_id') THEN
  RAISE EXCEPTION 'Install supabase_device_nodes_sync_migration.sql and supabase_aircons_protocol_migration.sql first';
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.ecotrack_validate_controller_assignment(p_device_id text,p_setup jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target text; n public.nodes; ac public.aircons; mode text; tag text; kind text; brand text; proto text; owner public.aircons;
BEGIN
 IF auth.uid() IS NULL OR NOT public.ecotrack_is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 IF coalesce(p_device_id,'') !~ '^esp32s3-[a-f0-9]{12}$' OR jsonb_typeof(p_setup) IS DISTINCT FROM 'object' OR octet_length(p_setup::text)>4000 THEN RAISE EXCEPTION 'Invalid controller setup'; END IF;
 IF length(btrim(coalesce(p_setup->>'controller_name',''))) NOT BETWEEN 1 AND 100 OR coalesce(p_setup->>'controller_name','') ~ '[[:cntrl:]<>]' THEN RAISE EXCEPTION 'Enter a valid controller name (1..100 characters)'; END IF;
 mode:=p_setup->>'assignment_mode'; tag:=btrim(coalesce(p_setup->>'asset_tag',''));
 kind:=btrim(coalesce(p_setup->>'aircon_type','')); brand:=btrim(coalesce(p_setup->>'brand','')); proto:=nullif(btrim(coalesce(p_setup->>'protocol_name','')),'');
 IF mode IS NULL OR mode NOT IN ('existing','new') THEN RAISE EXCEPTION 'Assign an air conditioner before saving'; END IF;
 IF length(kind) NOT BETWEEN 1 AND 100 OR kind='__custom__' OR kind ~ '[[:cntrl:]<>]' THEN RAISE EXCEPTION 'Enter a valid AC type (1..100 characters)'; END IF;
 IF length(brand)>80 OR brand ~ '[[:cntrl:]<>]' THEN RAISE EXCEPTION 'Invalid manufacturer'; END IF;
 IF proto IS NOT NULL AND proto !~ '^[A-Za-z0-9_]{1,64}$' THEN RAISE EXCEPTION 'Invalid IR protocol'; END IF;
 IF nullif(p_setup->>'room_id','') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.rooms WHERE id=p_setup->>'room_id') THEN RAISE EXCEPTION 'The selected room is no longer available'; END IF;
 SELECT node_id INTO target FROM ecotrack_private.device_credentials WHERE device_id=p_device_id;
 IF target IS NULL THEN SELECT node_id INTO target FROM public.ecotrack_device_state WHERE device_id=p_device_id; END IF;
 IF target IS NULL THEN SELECT id INTO target FROM public.nodes WHERE name=p_device_id; END IF;
 SELECT * INTO n FROM public.nodes WHERE id=target;
 IF EXISTS(SELECT 1 FROM public.nodes WHERE name=btrim(p_setup->>'controller_name') AND id IS DISTINCT FROM target) THEN RAISE EXCEPTION 'This controller name already exists'; END IF;
 IF mode='existing' THEN
  SELECT * INTO ac FROM public.aircons WHERE id=p_setup->>'aircon_id';
  IF ac.id IS NULL THEN RAISE EXCEPTION 'Select an available AC profile'; END IF;
  IF (nullif(ac.node_id,'') IS NOT NULL AND ac.node_id IS DISTINCT FROM target AND ac.node_id IS DISTINCT FROM p_device_id AND ac.node_id IS DISTINCT FROM n.name)
   OR (nullif(ac.controller_node_id,'') IS NOT NULL AND ac.controller_node_id IS DISTINCT FROM target) THEN
   RAISE EXCEPTION 'This AC profile is assigned to another controller';
  END IF;
 ELSE
  IF length(tag) NOT BETWEEN 1 AND 64 OR tag ~ '[[:cntrl:]<>]' THEN RAISE EXCEPTION 'Enter an AC name of 1..64 characters'; END IF;
  SELECT * INTO ac FROM public.aircons WHERE lower(asset_tag)=lower(tag) LIMIT 1;
  IF ac.id IS NOT NULL AND (target IS NULL OR ac.controller_node_id IS DISTINCT FROM target OR ac.asset_tag<>tag) THEN
   RAISE EXCEPTION 'This AC name already exists. Choose its existing profile or use another name';
  END IF;
 END IF;
 IF target IS NOT NULL THEN
  SELECT * INTO owner FROM public.aircons WHERE controller_node_id=target OR node_id IN(target,p_device_id,n.name) LIMIT 1;
  IF owner.id IS NOT NULL AND owner.id IS DISTINCT FROM ac.id THEN RAISE EXCEPTION 'Keep the AC already assigned to this controller, or unassign it first'; END IF;
 END IF;
 RETURN jsonb_build_object('valid',true,'node_id',target,'aircon_id',ac.id);
END $$;

CREATE OR REPLACE FUNCTION public.ecotrack_prepare_controller_registration(p_device_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n public.nodes; target text; token text;
BEGIN
 IF auth.uid() IS NULL OR NOT public.ecotrack_is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 IF coalesce(p_device_id,'') !~ '^esp32s3-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'Invalid controller identity'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_device_id,0));
 SELECT node_id INTO target FROM ecotrack_private.device_credentials WHERE device_id=p_device_id;
 IF target IS NULL THEN SELECT node_id INTO target FROM public.ecotrack_device_state WHERE device_id=p_device_id; END IF;
 IF target IS NULL THEN SELECT id INTO target FROM public.nodes WHERE name=p_device_id; END IF;
 IF target IS NULL THEN
  INSERT INTO public.nodes(name,status,room_id,brand,aircon_type,temp,rssi,battery,interval_val,interval_unit)
   VALUES(p_device_id,'offline',NULL,NULL,NULL,NULL,NULL,NULL,5,'Seconds') RETURNING * INTO n;
 ELSE SELECT * INTO n FROM public.nodes WHERE id=target FOR UPDATE;
 END IF;
 IF n.id IS NULL THEN RAISE EXCEPTION 'Controller registration was removed. Reconnect and retry'; END IF;
 token:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
 INSERT INTO ecotrack_private.device_credentials(device_id,node_id,token_hash)
  VALUES(p_device_id,n.id,sha256(convert_to(token,'UTF8')))
 ON CONFLICT(device_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,issued_at=clock_timestamp();
 INSERT INTO public.ecotrack_device_state(node_id,device_id) VALUES(n.id,p_device_id) ON CONFLICT(node_id) DO NOTHING;
 RETURN jsonb_build_object('node',to_jsonb(n),'device_id',p_device_id,'device_token',token);
END $$;

CREATE OR REPLACE FUNCTION public.ecotrack_finish_controller_registration(p_node_id text,p_device_id text,p_setup jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n public.nodes; ac public.aircons; state public.ecotrack_device_state; tag text; saved_brand text; kind text; proto text; owners integer;
BEGIN
 IF auth.uid() IS NULL OR NOT public.ecotrack_is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 -- This is the same lock used by credential issuance; concurrent retries retain one identity.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_device_id,0));
 IF NOT EXISTS(SELECT 1 FROM ecotrack_private.device_credentials WHERE device_id=p_device_id AND node_id=p_node_id) THEN RAISE EXCEPTION 'The controller identity does not match its cloud registration'; END IF;
 SELECT * INTO n FROM public.nodes WHERE id=p_node_id FOR UPDATE;
 IF n.id IS NULL THEN RAISE EXCEPTION 'The controller registration was removed'; END IF;
 PERFORM public.ecotrack_validate_controller_assignment(p_device_id,p_setup);
 IF p_setup->>'assignment_mode'='existing' THEN
  SELECT * INTO ac FROM public.aircons WHERE id=p_setup->>'aircon_id' FOR UPDATE;
 ELSE
  tag:=btrim(p_setup->>'asset_tag');
  PERFORM pg_advisory_xact_lock(hashtextextended('ac-name:'||lower(tag),0));
  SELECT * INTO ac FROM public.aircons WHERE lower(asset_tag)=lower(tag) FOR UPDATE;
 END IF;
 -- Recheck eligibility after the AC row/name lock; another controller may have claimed it.
 PERFORM public.ecotrack_validate_controller_assignment(p_device_id,p_setup);
 SELECT count(*) INTO owners FROM public.aircons WHERE (controller_node_id=p_node_id OR node_id IN(p_node_id,p_device_id,n.name)) AND id IS DISTINCT FROM ac.id;
 IF owners>0 THEN RAISE EXCEPTION 'This controller already has an AC assignment'; END IF;
 SELECT * INTO state FROM public.ecotrack_device_state WHERE node_id=p_node_id AND device_id=p_device_id;
 IF state.last_seen IS NULL OR state.last_seen<clock_timestamp()-interval '45 seconds' OR state.last_seen>clock_timestamp()+interval '5 seconds'
  OR state.sleeping_until>clock_timestamp() THEN RAISE EXCEPTION 'Verification pending: the ESP32 is not reporting an active cloud connection'; END IF;
 kind:=btrim(p_setup->>'aircon_type'); saved_brand:=coalesce(nullif(btrim(p_setup->>'brand'),''),ac.brand,'Unspecified');
 proto:=coalesce(nullif(btrim(p_setup->>'protocol_name'),''),ac.protocol_name,ac.protocol,'generic_ac');
 IF ac.id IS NULL THEN
  INSERT INTO public.aircons(asset_tag,brand,model,aircon_type,room_id,node_id,controller_node_id,protocol,protocol_name,status)
   VALUES(tag,saved_brand,kind,kind,nullif(p_setup->>'room_id',''),p_node_id,p_node_id,proto,proto,'online') RETURNING * INTO ac;
 ELSE
  UPDATE public.aircons SET brand=saved_brand,model=kind,aircon_type=kind,room_id=nullif(p_setup->>'room_id',''),
   node_id=p_node_id,controller_node_id=p_node_id,protocol=proto,protocol_name=proto,status='online',updated_at=clock_timestamp()
   WHERE id=ac.id RETURNING * INTO ac;
 END IF;
 UPDATE public.nodes SET name=btrim(p_setup->>'controller_name'),room_id=ac.room_id,brand=ac.brand,
  aircon_type=ac.aircon_type,protocol_name=ac.protocol_name,updated=clock_timestamp() WHERE id=p_node_id RETURNING * INTO n;
 RETURN jsonb_build_object('success',true,'registered',true,'connected',true,'node',to_jsonb(n),'aircon',to_jsonb(ac),'cloud_state',to_jsonb(state));
END $$;
REVOKE ALL ON FUNCTION public.ecotrack_validate_controller_assignment(text,jsonb),public.ecotrack_prepare_controller_registration(text),
 public.ecotrack_finish_controller_registration(text,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ecotrack_validate_controller_assignment(text,jsonb),public.ecotrack_prepare_controller_registration(text),
 public.ecotrack_finish_controller_registration(text,text,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.ecotrack_controller_registration_status(p_device_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, ecotrack_private AS $$
DECLARE device ecotrack_private.device_credentials%ROWTYPE; controller public.nodes%ROWTYPE;
  cloud public.ecotrack_device_state%ROWTYPE; assigned public.aircons%ROWTYPE; target text; needs_credentials boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.ecotrack_is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF coalesce(p_device_id,'') !~ '^esp32s3-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'Invalid controller identity'; END IF;
  SELECT * INTO device FROM ecotrack_private.device_credentials WHERE device_id=p_device_id;
  needs_credentials:=NOT FOUND;target:=device.node_id;
  IF target IS NULL THEN SELECT node_id INTO target FROM public.ecotrack_device_state WHERE device_id=p_device_id; END IF;
  IF target IS NULL THEN SELECT id INTO target FROM public.nodes WHERE name=p_device_id; END IF;
  SELECT * INTO controller FROM public.nodes WHERE id=target;
  IF NOT FOUND THEN RETURN jsonb_build_object('requires_credentials',true); END IF;
  SELECT * INTO cloud FROM public.ecotrack_device_state WHERE node_id=target AND device_id=p_device_id;
  SELECT * INTO assigned FROM public.aircons WHERE controller_node_id=target OR node_id IN(target,p_device_id,controller.name) LIMIT 1;
  RETURN jsonb_build_object('requires_credentials',needs_credentials,'node',to_jsonb(controller),'cloud_state',to_jsonb(cloud),'aircon',to_jsonb(assigned));
END $$;
REVOKE ALL ON FUNCTION public.ecotrack_controller_registration_status(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ecotrack_controller_registration_status(text) TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
