from pathlib import Path
s=Path('supabase_controller_details_migration.sql').read_text(encoding='utf-8')
a=s.index('CREATE OR REPLACE FUNCTION public.ecotrack_finish_controller_registration');b=s.index('END $$;',a)+len('END $$;')
fn=s[a:b]
fn=fn.replace(" INSERT INTO public.aircons(asset_tag,brand,"," INSERT INTO public.aircons(asset_tag,name,brand,")
fn=fn.replace("VALUES(tag,saved_brand,","VALUES(tag,coalesce(nullif(btrim(p_setup->>'aircon_name'),''),tag),saved_brand,")
fn=fn.replace(" UPDATE public.aircons SET brand="," UPDATE public.aircons SET name=coalesce(nullif(btrim(p_setup->>'aircon_name'),''),ac.name,ac.asset_tag),brand=")
fn=fn.replace(" PERFORM public.ecotrack_validate_controller_assignment(p_device_id,p_setup);",""" IF p_setup ? 'aircon_name' AND p_setup->'aircon_name'<>'null'::jsonb AND
   (jsonb_typeof(p_setup->'aircon_name')<>'string' OR length(btrim(p_setup->>'aircon_name')) NOT BETWEEN 1 AND 100 OR p_setup->>'aircon_name' ~ '[<>[:cntrl:]]') THEN RAISE EXCEPTION 'Enter a valid air conditioner name (1..100 characters)'; END IF;
 PERFORM public.ecotrack_validate_controller_assignment(p_device_id,p_setup);""",1)
sql="""-- Apply after supabase_controller_details_migration.sql. Display name does not change IDs or assignments.
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
"""
sql+=fn+"\nCREATE OR REPLACE FUNCTION public.ecotrack_admin_edit_controller(p_node_id text,p_changes jsonb)\nRETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$\nDECLARE n public.nodes; saved jsonb; linked_count integer; label text; proto text; state public.ecotrack_device_state;\nBEGIN\n IF auth.uid() IS NULL OR NOT public.ecotrack_is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;\n IF jsonb_typeof(p_changes) IS DISTINCT FROM 'object' OR octet_length(p_changes::text)>2000 OR\n  EXISTS(SELECT 1 FROM jsonb_object_keys(p_changes) AS keys(item) WHERE item NOT IN ('name','room_id','brand','aircon_type','protocol_name','aircon_name')) THEN RAISE EXCEPTION 'Invalid controller changes'; END IF;\n SELECT * INTO n FROM public.nodes WHERE id=p_node_id FOR UPDATE;\n IF n.id IS NULL THEN RAISE EXCEPTION 'Controller no longer exists'; END IF;\n label:=btrim(p_changes->>'name');proto:=btrim(p_changes->>'protocol_name');\n IF length(label) NOT BETWEEN 1 AND 100 OR label ~ '[<>[:cntrl:]]' THEN RAISE EXCEPTION 'Enter a valid controller display name'; END IF;\n IF EXISTS(SELECT 1 FROM public.nodes WHERE name=label AND id<>n.id) THEN RAISE EXCEPTION 'Controller display name already exists'; END IF;\n IF nullif(p_changes->>'room_id','') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.rooms WHERE id=p_changes->>'room_id') THEN RAISE EXCEPTION 'Selected room no longer exists'; END IF;\n IF length(coalesce(p_changes->>'brand',''))>80 OR coalesce(p_changes->>'brand','') ~ '[<>[:cntrl:]]' OR\n  length(btrim(coalesce(p_changes->>'aircon_type',''))) NOT BETWEEN 1 AND 100 OR p_changes->>'aircon_type' ~ '[<>[:cntrl:]]' OR\n  coalesce(proto,'') !~ '^[A-Za-z0-9_]{1,64}$' THEN RAISE EXCEPTION 'Invalid manufacturer, AC type or protocol'; END IF;\n IF nullif(p_changes->>'aircon_name','') IS NOT NULL AND\n  (length(btrim(p_changes->>'aircon_name'))>100 OR p_changes->>'aircon_name' ~ '[<>[:cntrl:]]') THEN RAISE EXCEPTION 'Invalid air conditioner name'; END IF;\n SELECT * INTO state FROM public.ecotrack_device_state WHERE node_id=n.id;\n IF nullif(state.latest_ir->>'protocol','UNKNOWN') IS NOT NULL AND proto IS DISTINCT FROM n.protocol_name AND proto IS DISTINCT FROM state.latest_ir->>'protocol' THEN RAISE EXCEPTION 'Protocol differs from the actual receiver'; END IF;\n PERFORM 1 FROM public.aircons WHERE controller_node_id=n.id OR node_id IN(n.id,n.name,state.device_id) FOR UPDATE;\n SELECT count(*) INTO linked_count FROM public.aircons WHERE controller_node_id=n.id OR node_id IN(n.id,n.name,state.device_id);\n IF linked_count>1 AND nullif(p_changes->>'aircon_name','') IS NOT NULL THEN RAISE EXCEPTION 'Choose an individual AC profile before renaming multiple assigned units'; END IF;\n UPDATE public.aircons SET node_id=n.id,controller_node_id=n.id,name=coalesce(nullif(btrim(p_changes->>'aircon_name'),''),name,asset_tag),\n  room_id=nullif(p_changes->>'room_id',''),brand=coalesce(nullif(btrim(p_changes->>'brand'),''),'Unspecified'),\n  model=btrim(p_changes->>'aircon_type'),aircon_type=btrim(p_changes->>'aircon_type'),\n  protocol=proto,protocol_name=proto,updated_at=clock_timestamp()\n WHERE controller_node_id=n.id OR node_id IN(n.id,n.name,state.device_id);\n SELECT coalesce(jsonb_agg(to_jsonb(a)),'[]') INTO saved FROM public.aircons a WHERE controller_node_id=n.id OR node_id IN(n.id,n.name,state.device_id);\n UPDATE public.nodes SET name=label,room_id=nullif(p_changes->>'room_id',''),brand=nullif(btrim(p_changes->>'brand'),''),\n  aircon_type=btrim(p_changes->>'aircon_type'),protocol_name=proto,updated=clock_timestamp()\n WHERE id=n.id RETURNING * INTO n;\n RETURN jsonb_build_object('success',true,'node',to_jsonb(n),'aircons',saved);\nEND $$;\nREVOKE ALL ON FUNCTION public.ecotrack_admin_edit_controller(text,jsonb) FROM PUBLIC,anon;\nGRANT EXECUTE ON FUNCTION public.ecotrack_admin_edit_controller(text,jsonb) TO authenticated;\n"
sql+="""
REVOKE ALL ON FUNCTION public.ecotrack_finish_controller_registration(text,text,jsonb),public.ecotrack_validate_aircon_display_name() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ecotrack_finish_controller_registration(text,text,jsonb) TO authenticated;
-- User-requested data correction for this registered controller only. This is data, not a UI default.
UPDATE public.aircons a SET name='Matrix',brand=CASE WHEN a.brand IS NULL OR a.brand IN('TCL','Unspecified','') THEN 'Matrix' ELSE a.brand END WHERE (a.name IS NULL OR a.name=a.asset_tag OR a.name='Matrix')
 AND EXISTS(SELECT 1 FROM public.ecotrack_device_state s JOIN public.nodes n ON n.id=s.node_id
 WHERE s.device_id='esp32s3-9cd20604a7ac' AND (a.controller_node_id=n.id OR a.node_id IN(n.id,n.name,s.device_id)));
NOTIFY pgrst,'reload schema';
COMMIT;
"""
Path('supabase_aircon_names_migration.sql').write_text(sql,encoding='utf-8')
print('Additive AC names migration generated.')
