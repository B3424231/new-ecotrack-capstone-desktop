-- Add after supabase_controller_registration_migration.sql. Idempotent and additive.
-- Existing devices retain NULL until an admin actually saves/verifies them.
BEGIN;
ALTER TABLE public.nodes ADD COLUMN IF NOT EXISTS admin_verified_at timestamptz;
ALTER TABLE public.nodes ADD COLUMN IF NOT EXISTS admin_verified_by uuid;
ALTER TABLE public.nodes ADD COLUMN IF NOT EXISTS deployment_saved_at timestamptz;

CREATE OR REPLACE FUNCTION public.ecotrack_stamp_controller_deployment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.admin_verified_at IS NOT NULL OR NEW.admin_verified_by IS NOT NULL OR NEW.deployment_saved_at IS NOT NULL THEN
   RAISE EXCEPTION 'Use Save & Verify to record admin verification' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
 END IF;
 IF (NEW.admin_verified_at IS DISTINCT FROM OLD.admin_verified_at OR NEW.admin_verified_by IS DISTINCT FROM OLD.admin_verified_by)
    AND coalesce(current_setting('ecotrack.registration_verify',true),'')<>'on' THEN
   RAISE EXCEPTION 'Use Save & Verify to record admin verification' USING ERRCODE='42501';
 END IF;
 IF coalesce(current_setting('ecotrack.registration_verify',true),'')<>'on' THEN
   NEW.deployment_saved_at:=OLD.deployment_saved_at;
   IF NEW.room_id IS DISTINCT FROM OLD.room_id AND auth.uid() IS NOT NULL AND public.ecotrack_is_admin() THEN
     NEW.deployment_saved_at:=clock_timestamp();
   END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ecotrack_stamp_controller_deployment() FROM PUBLIC;
DROP TRIGGER IF EXISTS ecotrack_controller_deployment_stamp ON public.nodes;
CREATE TRIGGER ecotrack_controller_deployment_stamp BEFORE INSERT OR UPDATE ON public.nodes
 FOR EACH ROW EXECUTE FUNCTION public.ecotrack_stamp_controller_deployment();
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
 PERFORM set_config('ecotrack.registration_verify','on',true);
 UPDATE public.nodes SET admin_verified_at=clock_timestamp(),admin_verified_by=auth.uid(),deployment_saved_at=clock_timestamp(),name=btrim(p_setup->>'controller_name'),room_id=ac.room_id,brand=ac.brand,
  aircon_type=ac.aircon_type,protocol_name=ac.protocol_name,updated=clock_timestamp() WHERE id=p_node_id RETURNING * INTO n;
 RETURN jsonb_build_object('success',true,'registered',true,'connected',true,'node',to_jsonb(n),'aircon',to_jsonb(ac),'cloud_state',to_jsonb(state));
END $$;
REVOKE ALL ON FUNCTION public.ecotrack_finish_controller_registration(text,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ecotrack_finish_controller_registration(text,text,jsonb) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
