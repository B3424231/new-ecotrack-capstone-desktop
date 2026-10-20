-- Telemetry storage used by the ESP32-S3 firmware and dashboard fallback.
-- Idempotent: can be re-run without removing existing readings.
BEGIN;
CREATE TABLE IF NOT EXISTS public.telemetry (
  id text PRIMARY KEY DEFAULT ('telem_' || substr(md5(random()::text), 1, 12)),
  node_id text,
  sensor_name text,
  room_name text,
  floor_name text,
  building_name text,
  aircon_type text,
  temperature numeric,
  pressure numeric,
  battery numeric,
  rssi integer,
  status text DEFAULT 'online',
  created timestamptz DEFAULT now()
);
ALTER TABLE public.telemetry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS telemetry_crud ON public.telemetry;
CREATE POLICY telemetry_crud ON public.telemetry FOR ALL
  TO anon, authenticated USING (true) WITH CHECK (true);
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON public.telemetry TO anon, authenticated, service_role;
CREATE INDEX IF NOT EXISTS idx_telemetry_created ON public.telemetry (created DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_node_created ON public.telemetry (node_id, created DESC);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'telemetry') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.telemetry;
  END IF;
END $$;
NOTIFY pgrst, 'reload schema';
COMMIT;
