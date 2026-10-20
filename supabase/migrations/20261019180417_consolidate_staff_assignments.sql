-- Authorized consolidation of two empty legacy tables.
-- Keep the resolver API/ACL and use staff's existing assignment fields.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
DECLARE
  legacy_name text;
  legacy_table regclass;
  has_records boolean;
BEGIN
  FOREACH legacy_name IN ARRAY ARRAY['registration_tasks', 'staff_locations'] LOOP
    legacy_table := pg_catalog.to_regclass('public.' || legacy_name);
    IF legacy_table IS NULL THEN CONTINUE; END IF;

    -- Hold the lock through COMMIT so a concurrent insert cannot evade the check.
    EXECUTE pg_catalog.format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', legacy_name);
    EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM public.%I)', legacy_name) INTO has_records;
    IF has_records THEN
      RAISE EXCEPTION 'Refusing to remove nonempty legacy table public.%', legacy_name;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_publication_rel WHERE prrelid = legacy_table) THEN
      RAISE EXCEPTION 'Refusing to remove published legacy table public.%', legacy_name;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = legacy_table AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'Refusing to remove legacy table public.% with application triggers', legacy_name;
    END IF;
  END LOOP;

  -- PL/pgSQL body references are not always represented in pg_depend.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND p.prokind IN ('f', 'p')
      AND (p.prosrc ~ '\mregistration_tasks\M'
        OR (p.prosrc ~ '\mstaff_locations\M'
          AND p.oid IS DISTINCT FROM pg_catalog.to_regprocedure('public.resolve_room_maintainer(text)')))
  ) THEN
    RAISE EXCEPTION 'A database routine still references a legacy table; review before consolidation';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.resolve_room_maintainer(p_room_id text)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_floor_id text;
  v_building_id text;
  v_staff_id text;
BEGIN
  SELECT r.floor_id, f.building_id INTO v_floor_id, v_building_id
  FROM public.rooms r
  LEFT JOIN public.floors f ON f.id = r.floor_id
  WHERE r.id = p_room_id;

  SELECT s.id INTO v_staff_id
  FROM public.staff s
  WHERE s.is_active IS TRUE AND s.is_archived IS NOT TRUE
  ORDER BY CASE
    WHEN s.assignment_scope = 'room' AND s.room_id = p_room_id THEN 0
    WHEN s.assignment_scope = 'floor' AND s.assigned_floor_id = v_floor_id THEN 1
    WHEN s.assignment_scope = 'building' AND s.assigned_building_id = v_building_id THEN 2
    WHEN s.assignment_scope = 'all' THEN 3
    ELSE 4 -- Preserve the existing oldest-active-staff fallback.
  END, s.created ASC, s.id ASC
  LIMIT 1;

  RETURN v_staff_id;
END
$function$;

-- RESTRICT refuses unexpected view/FK dependencies; never cascade-drop objects.
DROP TABLE IF EXISTS public.registration_tasks RESTRICT;
DROP TABLE IF EXISTS public.staff_locations RESTRICT;
COMMIT;
