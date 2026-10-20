-- Apply after authentication, cloud controller registration and AC display-name migrations.
-- Staff registration additionally requires the assigned-room registration patch.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
 IF to_regprocedure('public.ecotrack_finish_controller_registration(text,text,jsonb)') IS NULL
  OR to_regprocedure('public.ecotrack_can_access_room(text)') IS NULL
  OR to_regprocedure('public.ecotrack_staff_id()') IS NULL THEN
  RAISE EXCEPTION 'Install account authentication and cloud controller registration first';
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.ecotrack_ir_codes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 aircon_id text NOT NULL REFERENCES public.aircons(id) ON DELETE CASCADE,
 command_type text NOT NULL CHECK (command_type ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 protocol text NOT NULL CHECK (protocol ~ '^[A-Z][A-Z0-9_]{1,48}$'),
 raw_data text NOT NULL CHECK (length(raw_data) BETWEEN 5 AND 32768),
 capture jsonb NOT NULL DEFAULT '{}'::jsonb,
 source_platform text NOT NULL CHECK (source_platform IN ('mobile','desktop')),
 created_by uuid NOT NULL,
 updated_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (aircon_id, command_type)
);
ALTER TABLE public.ecotrack_ir_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ecotrack_ir_codes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ecotrack_ir_codes TO authenticated;
DROP POLICY IF EXISTS ecotrack_ir_codes_read ON public.ecotrack_ir_codes;
CREATE POLICY ecotrack_ir_codes_read ON public.ecotrack_ir_codes FOR SELECT TO authenticated
 USING (EXISTS (SELECT 1 FROM public.aircons a WHERE a.id=aircon_id AND public.ecotrack_can_access_room(a.room_id)));

-- Writes use validated RPCs. Staff may write only in their specific assigned room.
CREATE OR REPLACE FUNCTION public.ecotrack_can_write_ir_code(p_aircon_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT auth.uid() IS NOT NULL AND EXISTS (
  SELECT 1 FROM public.aircons a WHERE a.id=p_aircon_id AND (
   public.ecotrack_is_admin() IS TRUE OR EXISTS (
    SELECT 1 FROM public.staff s JOIN public.rooms r ON r.id=s.room_id
    WHERE s.id=public.ecotrack_staff_id() AND s.room_id=a.room_id
   )
  )
 );
$$;
REVOKE ALL ON FUNCTION public.ecotrack_can_write_ir_code(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.ecotrack_save_ir_code(
 p_aircon_id text,p_command_type text,p_capture jsonb,p_source text DEFAULT 'desktop')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE ac public.aircons%ROWTYPE; saved public.ecotrack_ir_codes%ROWTYPE;
 label text; proto text; raw text; timings text[];
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE='42501'; END IF;
 SELECT * INTO ac FROM public.aircons WHERE id=p_aircon_id FOR UPDATE;
 IF ac.id IS NULL OR public.ecotrack_can_write_ir_code(ac.id) IS NOT TRUE THEN
  RAISE EXCEPTION 'IR code access denied for this air conditioner' USING ERRCODE='42501';
 END IF;
 label:=upper(btrim(coalesce(p_command_type,'')));
 IF label !~ '^[A-Z][A-Z0-9_]{0,63}$' OR p_source IS NULL OR p_source NOT IN ('mobile','desktop') THEN
  RAISE EXCEPTION 'Enter a valid IR command name and source';
 END IF;
 IF jsonb_typeof(p_capture) IS DISTINCT FROM 'object' OR octet_length(p_capture::text)>65536 THEN
  RAISE EXCEPTION 'Invalid IR capture';
 END IF;
 proto:=upper(btrim(coalesce(p_capture->>'protocol',p_capture->>'raw_type','')));
 raw:=regexp_replace(btrim(coalesce(p_capture->>'raw_data','')),'[[:space:]]','','g');
 IF proto !~ '^[A-Z][A-Z0-9_]{1,48}$' OR length(raw) NOT BETWEEN 5 AND 32768
  OR raw !~ '^[0-9]+(,[0-9]+)+$' THEN
  RAISE EXCEPTION 'Supply actual captured IR timings and an exact protocol';
 END IF;
 timings:=string_to_array(raw,',');
 IF cardinality(timings) NOT BETWEEN 3 AND 4096 THEN RAISE EXCEPTION 'Invalid IR timing count'; END IF;
 IF EXISTS (SELECT 1 FROM unnest(timings) AS t(value) WHERE length(value)>7 OR value::numeric NOT BETWEEN 1 AND 1000000) THEN
  RAISE EXCEPTION 'Invalid IR timing duration';
 END IF;
 INSERT INTO public.ecotrack_ir_codes(aircon_id,command_type,protocol,raw_data,capture,source_platform,created_by,updated_by)
 VALUES(ac.id,label,proto,raw,(p_capture-'raw_data') || jsonb_build_object('protocol',proto,'raw_count',cardinality(timings)),p_source,auth.uid(),auth.uid())
 ON CONFLICT (aircon_id,command_type) DO UPDATE SET protocol=excluded.protocol,raw_data=excluded.raw_data,
  capture=excluded.capture,source_platform=excluded.source_platform,updated_by=auth.uid(),updated_at=clock_timestamp()
 RETURNING * INTO saved;
 RETURN to_jsonb(saved);
END $$;

CREATE OR REPLACE FUNCTION public.ecotrack_delete_ir_code(p_aircon_id text,p_command_type text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE ac public.aircons%ROWTYPE; removed uuid;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE='42501'; END IF;
 SELECT * INTO ac FROM public.aircons WHERE id=p_aircon_id FOR UPDATE;
 IF ac.id IS NULL OR public.ecotrack_can_write_ir_code(ac.id) IS NOT TRUE THEN
  RAISE EXCEPTION 'IR code access denied for this air conditioner' USING ERRCODE='42501';
 END IF;
 DELETE FROM public.ecotrack_ir_codes WHERE aircon_id=ac.id AND command_type=upper(btrim(p_command_type)) RETURNING id INTO removed;
 RETURN jsonb_build_object('deleted',removed IS NOT NULL,'id',removed,'aircon_id',ac.id);
END $$;

-- The existing finalizer retains its validation, room authorization, identity
-- locks and fresh-heartbeat checks. Both writes roll back if capture saving fails.
CREATE OR REPLACE FUNCTION public.ecotrack_finish_controller_registration_with_ir(
 p_node_id text,p_device_id text,p_setup jsonb,p_capture jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE result jsonb; saved jsonb; proto text;
BEGIN
 proto:=upper(btrim(coalesce(p_capture->>'protocol',p_capture->>'raw_type','')));
 IF proto='UNKNOWN' OR proto !~ '^[A-Z][A-Z0-9_]{1,48}$' THEN RAISE EXCEPTION 'Detect an exact remote protocol before registration'; END IF;
 IF coalesce(nullif(upper(p_setup->>'protocol_name'),'UNKNOWN'),proto) IS DISTINCT FROM proto THEN
  RAISE EXCEPTION 'Captured protocol differs from the selected AC protocol';
 END IF;
 result:=public.ecotrack_finish_controller_registration(p_node_id,p_device_id,p_setup || jsonb_build_object('protocol_name',proto));
 IF result->>'success' IS DISTINCT FROM 'true' OR result->'node'->>'id' IS DISTINCT FROM p_node_id
  OR result->'aircon'->>'id' IS NULL THEN RAISE EXCEPTION 'Registration was not confirmed'; END IF;
 saved:=public.ecotrack_save_ir_code(result->'aircon'->>'id','REMOTE_CAPTURE',p_capture,'mobile');
 RETURN result || jsonb_build_object('ir_code',saved);
END $$;
REVOKE ALL ON FUNCTION public.ecotrack_save_ir_code(text,text,jsonb,text),
 public.ecotrack_delete_ir_code(text,text),public.ecotrack_finish_controller_registration_with_ir(text,text,jsonb,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ecotrack_save_ir_code(text,text,jsonb,text),
 public.ecotrack_delete_ir_code(text,text),public.ecotrack_finish_controller_registration_with_ir(text,text,jsonb,jsonb) TO authenticated;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') AND NOT EXISTS(
  SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='ecotrack_ir_codes') THEN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.ecotrack_ir_codes;
 END IF;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
