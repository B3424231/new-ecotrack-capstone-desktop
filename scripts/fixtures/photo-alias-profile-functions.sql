-- Pre-consolidation profile functions captured from the live schema, no row data.
CREATE OR REPLACE FUNCTION public.ecotrack_update_profile(p_name text, p_phone text, p_avatar text, p_photo_url text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_id text := public.ecotrack_staff_id();
begin
 if auth.uid() is null or (not public.ecotrack_is_admin() and v_id is null) then raise exception 'Active profile required' using errcode='42501'; end if;
 if p_name is null or p_avatar is null or length(btrim(p_name)) not between 1 and 120 or length(regexp_replace(coalesce(p_phone,''),'[^0-9]','','g')) not between 7 and 15
 or p_avatar not in ('default','male','female','custom') then raise exception 'Invalid profile fields' using errcode='22023'; end if;
 if p_photo_url is not null and (p_photo_url not like 'storage://avatars/'||auth.uid()::text||'/%' or not exists(select 1 from storage.objects where bucket_id='avatars' and name=substring(p_photo_url from 19))) then
   raise exception 'Avatar must be an owned storage object' using errcode='22023'; end if;
 if public.ecotrack_is_admin() then
   update public.administrators set username=btrim(p_name),phone=btrim(p_phone),avatar=p_avatar,photo_url=p_photo_url,avatar_url=p_photo_url,updated=clock_timestamp() where auth_user_id=auth.uid();
 else
   update public.staff set name=btrim(p_name),phone=btrim(p_phone),avatar=p_avatar,photo_url=p_photo_url,avatar_url=p_photo_url,updated=clock_timestamp() where id=v_id;
 end if;
 return public.ecotrack_my_profile();
end $function$
;
CREATE OR REPLACE FUNCTION public.ecotrack_my_profile()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s public.staff%rowtype; a public.administrators%rowtype;
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
 select * into a from public.administrators where auth_user_id=auth.uid();
 if found then
   if not public.ecotrack_is_admin() then raise exception 'Active account session required' using errcode='42501'; end if;
   return jsonb_build_object('id',a.id,'authUserId',auth.uid(),'name',a.username,'email',a.email,'phone',coalesce(a.phone,''),'role','Facility Administrator','userType','admin','avatar',a.avatar,'photoUrl',coalesce(a.photo_url,a.avatar_url),'assignment','Unassigned');
 end if;
 select * into s from public.staff where auth_user_id=auth.uid();
 if not found or public.ecotrack_staff_id() is null then
   raise exception 'Active account profile required' using errcode='42501';
 end if;
 return jsonb_build_object('id',s.id,'authUserId',auth.uid(),'name',s.name,'email',s.email,'phone',coalesce(s.phone,''),'role',s.role,'userType','staff','avatar',s.avatar,'photoUrl',coalesce(s.photo_url,s.avatar_url),'assignment',/* canonical_assignment_20261014 */
 CASE WHEN s.room_id IS NOT NULL AND s.room_id NOT IN ('ALL','all_rooms','all') THEN
  coalesce((SELECT concat_ws(' • ',nullif(b.name,''),nullif(f.name,''),nullif(r.name,''))
   FROM public.rooms r JOIN public.floors f ON f.id=r.floor_id
   JOIN public.buildings b ON b.id=f.building_id WHERE r.id=s.room_id),'Unassigned')
 ELSE coalesce(s.assignment,'Unassigned') END);
end $function$
;
CREATE OR REPLACE FUNCTION public.ecotrack_admin_edit_staff(p_id text, p_changes jsonb, p_expected jsonb, p_apply boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE s public.staff%rowtype; b public.buildings%rowtype; f public.floors%rowtype; r public.rooms%rowtype;
 version_keys text[] := ARRAY['name','email','phone','role','room_id','assignment_scope','assigned_floor_id','assigned_building_id','avatar','photo_url','avatar_url'];
 k text; scope text; target_building_id text; target_floor_id text; target_room_id text; new_name text; new_phone text; new_role text;
 new_status text; photo text; canonical_building text; canonical_floor text; canonical_room text;
BEGIN
 IF NOT public.ecotrack_is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 IF p_id IS NULL OR jsonb_typeof(p_changes) IS DISTINCT FROM 'object' OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object'
 OR p_changes - ARRAY['name','phone','role','status','room_id','assignment_scope','assigned_floor_id','assigned_building_id','photo_url'] <> '{}'::jsonb
 OR p_expected - version_keys <> '{}'::jsonb THEN RAISE EXCEPTION 'Invalid staff edit' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM public.staff WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Staff account not found. Refresh the directory.' USING ERRCODE='P0002'; END IF;
 IF s.is_archived OR lower(coalesce(s.status,'')) IN ('archived','deactivated','disabled') THEN
  RAISE EXCEPTION 'Restore this staff account before editing it.' USING ERRCODE='42501'; END IF;
 FOREACH k IN ARRAY version_keys LOOP
  IF NOT p_expected ? k OR p_expected->k IS DISTINCT FROM coalesce(to_jsonb(s)->k,'null'::jsonb) THEN
   RAISE EXCEPTION 'This staff profile changed. Reopen the editor before saving.' USING ERRCODE='40001'; END IF;
 END LOOP;
 new_name := btrim(p_changes->>'name'); new_phone := coalesce(btrim(p_changes->>'phone'),''); new_role := btrim(p_changes->>'role');
 IF jsonb_typeof(p_changes->'name') IS DISTINCT FROM 'string' OR length(new_name) NOT BETWEEN 1 AND 120
 OR jsonb_typeof(p_changes->'phone') IS DISTINCT FROM 'string' OR (new_phone<>'' AND new_phone !~ '^[0-9]{11}$')
 OR jsonb_typeof(p_changes->'role') IS DISTINCT FROM 'string' OR length(new_role) NOT BETWEEN 1 AND 120 THEN
  RAISE EXCEPTION 'Check the name, 11-digit phone and worker role.' USING ERRCODE='22023'; END IF;
 IF new_phone<>'' AND EXISTS(SELECT 1 FROM public.staff x WHERE x.id<>p_id AND regexp_replace(x.phone,'[^0-9]','','g')=new_phone) THEN
  RAISE EXCEPTION 'This phone number already belongs to a staff account.' USING ERRCODE='23505'; END IF;
 scope:=p_changes->>'assignment_scope'; target_building_id:=nullif(p_changes->>'assigned_building_id','');
 target_floor_id:=nullif(p_changes->>'assigned_floor_id',''); target_room_id:=nullif(p_changes->>'room_id','');
 IF scope IS NULL OR scope NOT IN ('room','floor','building','all') THEN RAISE EXCEPTION 'Choose a valid deployment area.' USING ERRCODE='22023'; END IF;
 IF scope='all' THEN
  IF target_building_id IS NOT NULL OR target_floor_id IS NOT NULL OR target_room_id IS NOT NULL THEN RAISE EXCEPTION 'Invalid all-building assignment' USING ERRCODE='22023'; END IF;
  canonical_building:='All Buildings'; canonical_floor:='All Floors'; canonical_room:='All Rooms';
 ELSE
  SELECT * INTO b FROM public.buildings WHERE id=target_building_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Choose an existing building.' USING ERRCODE='22023'; END IF;
  canonical_building:=b.name;
  IF scope='building' THEN
   IF target_floor_id IS NOT NULL OR target_room_id IS NOT NULL THEN RAISE EXCEPTION 'Invalid building assignment' USING ERRCODE='22023'; END IF;
   canonical_floor:='All Floors'; canonical_room:='All Rooms';
  ELSE
   SELECT * INTO f FROM public.floors WHERE id=target_floor_id AND public.floors.building_id=b.id;
   IF NOT FOUND THEN RAISE EXCEPTION 'Choose a floor in this building.' USING ERRCODE='22023'; END IF;
   canonical_floor:=f.name;
   IF scope='floor' THEN
    IF target_room_id IS NOT NULL THEN RAISE EXCEPTION 'Invalid floor assignment' USING ERRCODE='22023'; END IF;
    canonical_room:='All Rooms';
   ELSE
    SELECT * INTO r FROM public.rooms WHERE id=target_room_id AND public.rooms.floor_id=f.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Choose a room on this floor.' USING ERRCODE='22023'; END IF;
    canonical_room:=r.name;
   END IF;
  END IF;
 END IF;
 IF p_changes ? 'status' THEN
  new_status:=p_changes->>'status';
  IF new_status IS NULL OR new_status NOT IN ('Online','Offline','On Leave') THEN RAISE EXCEPTION 'Invalid staff status' USING ERRCODE='22023'; END IF;
 END IF;
 IF p_changes ? 'photo_url' THEN
  photo:=p_changes->>'photo_url';
  IF s.auth_user_id IS NULL OR photo IS NULL OR photo NOT LIKE 'storage://avatars/'||s.auth_user_id::text||'/%'
  OR NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='avatars' AND name=substring(photo FROM 19)) THEN
   RAISE EXCEPTION 'Photo must be stored in this staff account''s avatar folder.' USING ERRCODE='22023'; END IF;
 END IF;
 IF p_apply THEN
  UPDATE public.staff SET name=new_name,phone=new_phone,role=new_role,
   assignment_scope=scope,assigned_building_id=target_building_id,assigned_floor_id=target_floor_id,room_id=target_room_id,
   building_name=canonical_building,floor_name=canonical_floor,room_name=canonical_room,
   assignment=concat_ws(' • ',canonical_building,canonical_floor,canonical_room),
   status=CASE WHEN p_changes ? 'status' THEN new_status ELSE status END,
   is_online=CASE WHEN p_changes ? 'status' THEN new_status='Online' ELSE is_online END,
   online_status=CASE WHEN p_changes ? 'status' THEN CASE WHEN new_status='Online' THEN 'online' ELSE 'offline' END ELSE online_status END,
   photo_url=CASE WHEN p_changes ? 'photo_url' THEN photo ELSE photo_url END,
   avatar_url=CASE WHEN p_changes ? 'photo_url' THEN photo ELSE avatar_url END,
   avatar=CASE WHEN p_changes ? 'photo_url' THEN 'custom' ELSE avatar END,
   updated=clock_timestamp() WHERE id=s.id RETURNING * INTO s;
 END IF;
 RETURN jsonb_build_object('profile',to_jsonb(s)-'password'-'password_hash');
END $function$
;
