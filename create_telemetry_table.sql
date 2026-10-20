-- ===================================================================
-- ECOTRACK COMPLETE SUPABASE MIGRATION (TELEMETRY, STAFF & STORAGE)
-- Run this in your Supabase SQL Editor:
-- Dashboard -> SQL Editor -> New Query -> Paste & Run
-- ===================================================================

-- 1. TELEMETRY TABLE (SENSOR LOGS)
CREATE TABLE IF NOT EXISTS public.telemetry (
    id TEXT PRIMARY KEY DEFAULT ('telem_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 15)),
    node_id TEXT,
    sensor_name TEXT NOT NULL,
    room_name TEXT DEFAULT 'Server Room A',
    floor_name TEXT DEFAULT '2nd Floor - IT Wing',
    building_name TEXT DEFAULT 'Main Campus Building',
    aircon_type TEXT DEFAULT 'Split Type (Inverter)',
    temperature NUMERIC NOT NULL DEFAULT 24.0,
    pressure NUMERIC NOT NULL DEFAULT 0.45,
    battery NUMERIC NOT NULL DEFAULT 4.0,
    rssi NUMERIC NOT NULL DEFAULT -60,
    status TEXT NOT NULL DEFAULT 'online',
    created TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.telemetry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS telemetry_all ON public.telemetry;
CREATE POLICY telemetry_all ON public.telemetry FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_telemetry_created ON public.telemetry(created DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_sensor_name ON public.telemetry(sensor_name);
CREATE INDEX IF NOT EXISTS idx_telemetry_node_id ON public.telemetry(node_id);

-- 2. CREATE PUBLIC STORAGE BUCKETS FOR AVATARS AND PHOTOS
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES 
  (
    'avatars',
    'avatars',
    true,
    10485760, -- 10MB limit
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml']
  ),
  (
    'photos',
    'photos',
    true,
    20971520, -- 20MB limit
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml']
  )
ON CONFLICT (id) DO UPDATE 
SET public = true,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Storage Policies
DROP POLICY IF EXISTS "Allow public read access to avatars and photos" ON storage.objects;
DROP POLICY IF EXISTS "Allow public insert to avatars and photos" ON storage.objects;
DROP POLICY IF EXISTS "Allow public update to avatars and photos" ON storage.objects;
DROP POLICY IF EXISTS "Allow public delete to avatars and photos" ON storage.objects;

CREATE POLICY "Allow public read access to avatars and photos"
ON storage.objects FOR SELECT
USING (bucket_id IN ('avatars', 'photos'));

CREATE POLICY "Allow public insert to avatars and photos"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id IN ('avatars', 'photos'));

CREATE POLICY "Allow public update to avatars and photos"
ON storage.objects FOR UPDATE
USING (bucket_id IN ('avatars', 'photos'))
WITH CHECK (bucket_id IN ('avatars', 'photos'));

CREATE POLICY "Allow public delete to avatars and photos"
ON storage.objects FOR DELETE
USING (bucket_id IN ('avatars', 'photos'));

-- 3. UPDATE STAFF TABLE WITH AVATAR & LOCATION COLUMNS
ALTER TABLE IF EXISTS public.staff 
    ADD COLUMN IF NOT EXISTS avatar TEXT DEFAULT 'default',
    ADD COLUMN IF NOT EXISTS photo_url TEXT,
    ADD COLUMN IF NOT EXISTS avatar_url TEXT,
    ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'HVAC / Aircon Technician',
    ADD COLUMN IF NOT EXISTS building_name TEXT DEFAULT 'Main Campus Building',
    ADD COLUMN IF NOT EXISTS floor_name TEXT DEFAULT '2nd Floor - IT Wing',
    ADD COLUMN IF NOT EXISTS room_name TEXT DEFAULT 'Server Room A',
    ADD COLUMN IF NOT EXISTS assignment TEXT DEFAULT 'Main Campus Building • 2nd Floor - IT Wing • Server Room A',
    ADD COLUMN IF NOT EXISTS room_id TEXT,
    ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS archive_reason TEXT,
    ADD COLUMN IF NOT EXISTS archive_notes TEXT,
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- 4. ENABLE REALTIME REPLICATION
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
      AND schemaname = 'public' 
      AND tablename = 'telemetry'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.telemetry;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
      AND schemaname = 'public' 
      AND tablename = 'staff'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.staff;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
      AND schemaname = 'public' 
      AND tablename = 'maintenance_reports'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.maintenance_reports;
  END IF;
END $$;

-- ==============================================================================
-- 5. ONLINE / OFFLINE TRIGGER & STATUS SYNC
-- ==============================================================================
-- Ensure is_online column exists and defaults to false
ALTER TABLE IF EXISTS public.staff 
    ADD COLUMN IF NOT EXISTS is_online BOOLEAN DEFAULT false,
    ALTER COLUMN status SET DEFAULT 'Offline';

-- Reset legacy 'Active' accounts to 'Offline'
UPDATE public.staff 
SET status = 'Offline', is_online = false 
WHERE status = 'Active';

-- Trigger function to automatically keep is_online and status in sync
CREATE OR REPLACE FUNCTION public.sync_staff_online_status()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status ILIKE 'online' OR NEW.is_online = true THEN
    NEW.status := 'Online';
    NEW.is_online := true;
  ELSE
    NEW.status := 'Offline';
    NEW.is_online := false;
  END IF;
  NEW.last_active := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_staff_online_status ON public.staff;
CREATE TRIGGER trg_sync_staff_online_status
BEFORE INSERT OR UPDATE OF status, is_online ON public.staff
FOR EACH ROW
EXECUTE FUNCTION public.sync_staff_online_status();


