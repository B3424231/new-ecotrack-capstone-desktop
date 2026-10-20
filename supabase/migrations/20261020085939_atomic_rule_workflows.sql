-- All statements in each function share the caller's transaction and RLS policies.
-- Existing records and table definitions are preserved.
CREATE OR REPLACE FUNCTION public.ecotrack_save_rule(
  p_rule jsonb, p_target_nodes text[], p_rule_id text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_rule public.rules%ROWTYPE;
  v_targets text[];
  v_count integer;
  v_saved text[];
BEGIN
  IF auth.uid() IS NULL OR public.ecotrack_is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501';
  END IF;
  IF p_rule IS NULL OR jsonb_typeof(p_rule)<>'object' OR p_target_nodes IS NULL THEN
    RAISE EXCEPTION 'Provide rule fields and device identities' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_rule) AS k(key) WHERE key NOT IN
    ('type','condition','value','unit','enabled','message','duration','start_date','start_time','end_date','end_time','room_id','building_id','floor_id'))
    OR EXISTS (SELECT 1 FROM unnest(p_target_nodes) AS n(id) WHERE id IS NULL OR btrim(id)='') THEN
    RAISE EXCEPTION 'Invalid rule fields or device identities' USING ERRCODE='22023';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT id ORDER BY id),ARRAY[]::text[]) INTO v_targets FROM unnest(p_target_nodes) AS n(id);
  PERFORM id FROM public.nodes WHERE id=ANY(v_targets);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>cardinality(v_targets) THEN RAISE EXCEPTION 'A selected device is unavailable' USING ERRCODE='23503'; END IF;
  IF p_rule_id IS NOT NULL THEN
    SELECT * INTO v_rule FROM public.rules WHERE id=p_rule_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Rule unavailable' USING ERRCODE='P0002'; END IF;
  ELSE
    v_rule.enabled:=true;
    v_rule.duration:=5;
  END IF;
  v_rule:=jsonb_populate_record(v_rule,p_rule);
  IF p_rule_id IS NULL THEN
    INSERT INTO public.rules(type,condition,value,unit,enabled,message,duration,start_date,start_time,end_date,end_time,room_id,building_id,floor_id)
    VALUES(v_rule.type,v_rule.condition,v_rule.value,v_rule.unit,v_rule.enabled,v_rule.message,v_rule.duration,v_rule.start_date,v_rule.start_time,v_rule.end_date,v_rule.end_time,v_rule.room_id,v_rule.building_id,v_rule.floor_id)
    RETURNING * INTO v_rule;
  ELSE
    UPDATE public.rules SET type=v_rule.type,condition=v_rule.condition,value=v_rule.value,unit=v_rule.unit,
      enabled=v_rule.enabled,message=v_rule.message,duration=v_rule.duration,start_date=v_rule.start_date,
      start_time=v_rule.start_time,end_date=v_rule.end_date,end_time=v_rule.end_time,room_id=v_rule.room_id,
      building_id=v_rule.building_id,floor_id=v_rule.floor_id,updated=now() WHERE id=p_rule_id RETURNING * INTO v_rule;
    IF NOT FOUND THEN RAISE EXCEPTION 'Rule update was not permitted' USING ERRCODE='42501'; END IF;
  END IF;
  DELETE FROM public.rule_nodes WHERE rule_id=v_rule.id;
  INSERT INTO public.rule_nodes(rule_id,node_id) SELECT v_rule.id,id FROM unnest(v_targets) AS n(id);
  SELECT COALESCE(array_agg(node_id ORDER BY node_id),ARRAY[]::text[]) INTO v_saved FROM public.rule_nodes WHERE rule_id=v_rule.id;
  IF v_saved IS DISTINCT FROM v_targets THEN RAISE EXCEPTION 'The rule targets were not saved completely'; END IF;
  RETURN jsonb_build_object('rule_id',v_rule.id,'target_nodes',to_jsonb(v_saved));
END;
$$;
REVOKE ALL ON FUNCTION public.ecotrack_save_rule(jsonb,text[],text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ecotrack_save_rule(jsonb,text[],text) TO authenticated;

CREATE OR REPLACE FUNCTION public.ecotrack_set_rules_enabled(p_rule_ids text[],p_enabled boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_ids text[];v_count integer;v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR public.ecotrack_is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501';
  END IF;
  IF p_rule_ids IS NULL OR p_enabled IS NULL OR cardinality(p_rule_ids)=0 OR
    EXISTS (SELECT 1 FROM unnest(p_rule_ids) AS r(id) WHERE id IS NULL OR btrim(id)='') THEN
    RAISE EXCEPTION 'Provide rule identities and status' USING ERRCODE='22023';
  END IF;
  SELECT array_agg(DISTINCT id ORDER BY id) INTO v_ids FROM unnest(p_rule_ids) AS r(id);
  PERFORM id FROM public.rules WHERE id=ANY(v_ids) ORDER BY id FOR UPDATE;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>cardinality(v_ids) THEN RAISE EXCEPTION 'One or more rules are unavailable' USING ERRCODE='P0002'; END IF;
  WITH changed AS (UPDATE public.rules SET enabled=p_enabled,updated=now() WHERE id=ANY(v_ids) RETURNING id,enabled)
  SELECT jsonb_agg(to_jsonb(changed) ORDER BY id) INTO v_result FROM changed;
  IF jsonb_array_length(v_result)<>cardinality(v_ids) THEN RAISE EXCEPTION 'Rule statuses were not saved completely'; END IF;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.ecotrack_set_rules_enabled(text[],boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ecotrack_set_rules_enabled(text[],boolean) TO authenticated;
