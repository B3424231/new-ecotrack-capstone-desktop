-- ==============================================================================
-- EcoTrack Universal Aircon IoT: RLS Policies for aircons table
-- Grants SELECT, INSERT, UPDATE, DELETE permissions to public / anon role
-- ==============================================================================

-- 1. Ensure public.aircons table exists and has ROW LEVEL SECURITY enabled
ALTER TABLE IF EXISTS public.aircons ENABLE ROW LEVEL SECURITY;

-- 2. Drop any legacy restrictive policies
DROP POLICY IF EXISTS "Allow public read access to aircons" ON public.aircons;
DROP POLICY IF EXISTS "Allow public insert access to aircons" ON public.aircons;
DROP POLICY IF EXISTS "Allow public update access to aircons" ON public.aircons;
DROP POLICY IF EXISTS "Allow public delete access to aircons" ON public.aircons;

-- 3. Create permissive policies for full Admin (Desktop) & Maintenance Staff (Mobile) CRUD
CREATE POLICY "Allow public read access to aircons"
ON public.aircons FOR SELECT
USING (true);

CREATE POLICY "Allow public insert access to aircons"
ON public.aircons FOR INSERT
WITH CHECK (true);

CREATE POLICY "Allow public update access to aircons"
ON public.aircons FOR UPDATE
USING (true);

CREATE POLICY "Allow public delete access to aircons"
ON public.aircons FOR DELETE
USING (true);

-- 4. Enable Supabase Realtime for aircons table if publication exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
      AND schemaname = 'public' 
      AND tablename = 'aircons'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.aircons;
  END IF;
END $$;
