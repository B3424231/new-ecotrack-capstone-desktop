-- Consolidate unused image aliases while preserving the installed mobile staff contract.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.administrators, public.nodes IN ACCESS EXCLUSIVE MODE;

DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.administrators
    WHERE nullif(photo_url, '') IS NOT NULL AND nullif(avatar_url, '') IS NOT NULL AND photo_url <> avatar_url
  ) OR EXISTS (
    SELECT 1 FROM public.nodes
    WHERE nullif(photo_url, '') IS NOT NULL AND nullif(image_url, '') IS NOT NULL AND photo_url <> image_url
  ) THEN
    RAISE EXCEPTION 'Conflicting image aliases found; review before consolidation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN ('public','ecotrack_private') AND p.prokind IN ('f','p')
      AND (p.prosrc ~ '\mimage_url\M' OR
        (p.prosrc ~ '\mavatar_url\M' AND p.oid NOT IN (
          'public.ecotrack_update_profile(text,text,text,text)'::regprocedure,
          'public.ecotrack_my_profile()'::regprocedure,
          'public.ecotrack_admin_edit_staff(text,jsonb,jsonb,boolean)'::regprocedure
        )))
  ) THEN
    RAISE EXCEPTION 'A new routine references an image alias; review before consolidation';
  END IF;
END
$guard$;

-- Copy only missing canonical values; never overwrite a different image.
UPDATE public.administrators SET photo_url=avatar_url
WHERE nullif(photo_url, '') IS NULL AND nullif(avatar_url, '') IS NOT NULL;
UPDATE public.nodes SET photo_url=image_url
WHERE nullif(photo_url, '') IS NULL AND nullif(image_url, '') IS NOT NULL;

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
   update public.administrators set username=btrim(p_name),phone=btrim(p_phone),avatar=p_avatar,photo_url=p_photo_url,updated=clock_timestamp() where auth_user_id=auth.uid();
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
   return jsonb_build_object('id',a.id,'authUserId',auth.uid(),'name',a.username,'email',a.email,'phone',coalesce(a.phone,''),'role','Facility Administrator','userType','admin','avatar',a.avatar,'photoUrl',a.photo_url,'assignment','Unassigned');
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

-- Keep staff.avatar_url for installed mobile queries and optimistic edit versions.
ALTER TABLE public.administrators DROP COLUMN avatar_url RESTRICT;
ALTER TABLE public.nodes DROP COLUMN image_url RESTRICT;
COMMIT;

