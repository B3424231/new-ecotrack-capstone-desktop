-- Apply after supabase_controller_details_migration.sql. Display name does not change IDs or assignments.
BEGIN;
ALTER TABLE public.aircons ADD COLUMN IF NOT EXISTS name text;
CREATE OR REPLACE FUNCTION public.ecotrack_validate_aircon_display_name()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.name IS NOT NULL AND (length(btrim(NEW.name)) NOT BETWEEN 1 AND 100 OR NEW.name ~ '[<>[:cntrl:]]') THEN RAISE EXCEPTION 'Enter a valid air conditioner name'; END IF;
 IF TG_OP='UPDATE' AND NEW.name IS DISTINCT FROM OLD.name AND auth.uid() IS NOT NULL AND NOT public.ecotrack_is_admin() THEN
  RAISE EXCEPTION 'Administrator required to rename an AC' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ecotrack_aircon_name_validate ON public.aircons;
CREATE TRIGGER ecotrack_aircon_name_validate BEFORE INSERT OR UPDATE ON public.aircons FOR EACH ROW EXECUTE FUNCTION public.ecotrack_validate_aircon_display_name();
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
 IF p_setup ? 'aircon_name' AND p_setup->'aircon_name'<>'null'::jsonb AND
   (jsonb_typeof(p_setup->'aircon_name')<>'string' OR length(btrim(p_setup->>'aircon_name')) NOT BETWEEN 1 AND 100 OR p_setup->>'aircon_name' ~ '[<>[:cntrl:]]') THEN RAISE EXCEPTION 'Enter a valid air conditioner name (1..100 characters)'; END IF;
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
  INSERT INTO public.aircons(asset_tag,name,brand,model,aircon_type,room_id,node_id,controller_node_id,protocol,protocol_name,status)
   VALUES(tag,coalesce(nullif(btrim(p_setup->>'aircon_name'),''),tag),saved_brand,kind,kind,nullif(p_setup->>'room_id',''),p_node_id,p_node_id,proto,proto,'online') RETURNING * INTO ac;
 ELSE
  UPDATE public.aircons SET name=coalesce(nullif(btrim(p_setup->>'aircon_name'),''),ac.name,ac.asset_tag),brand=saved_brand,model=kind,aircon_type=kind,room_id=nullif(p_setup->>'room_id',''),
   node_id=p_node_id,controller_node_id=p_node_id,protocol=proto,protocol_name=proto,status='online',updated_at=clock_timestamp()
   WHERE id=ac.id RETURNING * INTO ac;
 END IF;
 PERFORM set_config('ecotrack.registration_verify','on',true);
 UPDATE public.nodes SET admin_verified_at=clock_timestamp(),admin_verified_by=auth.uid(),deployment_saved_at=clock_timestamp(),name=btrim(p_setup->>'controller_name'),room_id=ac.room_id,brand=ac.brand,
  aircon_type=ac.aircon_type,protocol_name=ac.protocol_name,updated=clock_timestamp() WHERE id=p_node_id RETURNING * INTO n;
 RETURN jsonb_build_object('success',true,'registered',true,'connected',true,'node',to_jsonb(n),'aircon',to_jsonb(ac),'cloud_state',to_jsonb(state));
END $$;
CREATE OR REPLACE FUNCTION public.ecotrack_admin_edit_controller(p_node_id text,p_changes jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n public.nodes; saved jsonb; linked_count integer; label text; proto text; state public.ecotrack_device_state;
BEGIN
 IF auth.uid() IS NULL OR NOT public.ecotrack_is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_changes) IS DISTINCT FROM 'object' OR octet_length(p_changes::text)>2000 OR
  EXISTS(SELECT 1 FROM jsonb_object_keys(p_changes) AS keys(item) WHERE item NOT IN ('name','room_id','brand','aircon_type','protocol_name','aircon_name')) THEN RAISE EXCEPTION 'Invalid controller changes'; END IF;
 SELECT * INTO n FROM public.nodes WHERE id=p_node_id FOR UPDATE;
 IF n.id IS NULL THEN RAISE EXCEPTION 'Controller no longer exists'; END IF;
 label:=btrim(p_changes->>'name');proto:=btrim(p_changes->>'protocol_name');
 IF length(label) NOT BETWEEN 1 AND 100 OR label ~ '[<>[:cntrl:]]' THEN RAISE EXCEPTION 'Enter a valid controller display name'; END IF;
 IF EXISTS(SELECT 1 FROM public.nodes WHERE name=label AND id<>n.id) THEN RAISE EXCEPTION 'Controller display name already exists'; END IF;
 IF nullif(p_changes->>'room_id','') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.rooms WHERE id=p_changes->>'room_id') THEN RAISE EXCEPTION 'Selected room no longer exists'; END IF;
 IF length(coalesce(p_changes->>'brand',''))>80 OR coalesce(p_changes->>'brand','') ~ '[<>[:cntrl:]]' OR
  length(btrim(coalesce(p_changes->>'aircon_type',''))) NOT BETWEEN 1 AND 100 OR p_changes->>'aircon_type' ~ '[<>[:cntrl:]]' OR
  coalesce(proto,'') !~ '^[A-Za-z0-9_]{1,64}$' THEN RAISE EXCEPTION 'Invalid manufacturer, AC type or protocol'; END IF;
 IF nullif(p_changes->>'aircon_name','') IS NOT NULL AND
  (length(btrim(p_changes->>'aircon_name'))>100 OR p_changes->>'aircon_name' ~ '[<>[:cntrl:]]') THEN RAISE EXCEPTION 'Invalid air conditioner name'; END IF;
 SELECT * INTO state FROM public.ecotrack_device_state WHERE node_id=n.id;
 IF nullif(state.latest_ir->>'protocol','UNKNOWN') IS NOT NULL AND proto IS DISTINCT FROM n.protocol_name AND proto IS DISTINCT FROM state.latest_ir->>'protocol' THEN RAISE EXCEPTION 'Protocol differs from the actual receiver'; END IF;
 PERFORM 1 FROM public.aircons WHERE controller_node_id=n.id OR node_id IN(n.id,n.name,state.device_id) FOR UPDATE;
 SELECT count(*) INTO linked_count FROM public.aircons WHERE controller_node_id=n.id OR node_id IN(n.id,n.name,state.device_id);
 IF linked_count>1 AND nullif(p_changes->>'aircon_name','') IS NOT NULL THEN RAISE EXCEPTION 'Choose an individual AC profile before renaming multiple assigned units'; END IF;
 UPDATE public.aircons SET node_id=n.id,controller_node_id=n.id,name=coalesce(nullif(btrim(p_changes->>'aircon_name'),''),name,asset_tag),
  room_id=nullif(p_changes->>'room_id',''),brand=coalesce(nullif(btrim(p_changes->>'brand'),''),'Unspecified'),
  model=btrim(p_changes->>'aircon_type'),aircon_type=btrim(p_changes->>'aircon_type'),
  protocol=proto,protocol_name=proto,updated_at=clock_timestamp()
 WHERE controller_node_id=n.id OR node_id IN(n.id,n.name,state.device_id);
 SELECT coalesce(jsonb_agg(to_jsonb(a)),'[]') INTO saved FROM public.aircons a WHERE controller_node_id=n.id OR node_id IN(n.id,n.name,state.device_id);
 UPDATE public.nodes SET name=label,room_id=nullif(p_changes->>'room_id',''),brand=nullif(btrim(p_changes->>'brand'),''),
  aircon_type=btrim(p_changes->>'aircon_type'),protocol_name=proto,updated=clock_timestamp()
 WHERE id=n.id RETURNING * INTO n;
 RETURN jsonb_build_object('success',true,'node',to_jsonb(n),'aircons',saved);
END $$;
REVOKE ALL ON FUNCTION public.ecotrack_admin_edit_controller(text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ecotrack_admin_edit_controller(text,jsonb) TO authenticated;

REVOKE ALL ON FUNCTION public.ecotrack_finish_controller_registration(text,text,jsonb),public.ecotrack_validate_aircon_display_name() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ecotrack_finish_controller_registration(text,text,jsonb) TO authenticated;
-- User-requested data correction for this registered controller only. This is data, not a UI default.
UPDATE public.aircons a SET name='Matrix',brand=CASE WHEN a.brand IS NULL OR a.brand IN('TCL','Unspecified','') THEN 'Matrix' ELSE a.brand END WHERE (a.name IS NULL OR a.name=a.asset_tag OR a.name='Matrix')
 AND EXISTS(SELECT 1 FROM public.ecotrack_device_state s JOIN public.nodes n ON n.id=s.node_id
 WHERE s.device_id='esp32s3-9cd20604a7ac' AND (a.controller_node_id=n.id OR a.node_id IN(n.id,n.name,s.device_id)));
NOTIFY pgrst,'reload schema';
COMMIT;
