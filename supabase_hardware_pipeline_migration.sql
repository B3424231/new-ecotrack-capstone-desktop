-- Shared hardware/dashboard command state. Connectivity stays on nodes.status.
BEGIN;
ALTER TABLE public.nodes ADD COLUMN IF NOT EXISTS ip_address text;
ALTER TABLE public.aircons ADD COLUMN IF NOT EXISTS desired_state jsonb;
ALTER TABLE public.telemetry ADD COLUMN IF NOT EXISTS interval_seconds numeric;
-- Optional measured AC power only; commanded power must never populate this field.
ALTER TABLE public.telemetry ADD COLUMN IF NOT EXISTS ac_on boolean;
CREATE INDEX IF NOT EXISTS telemetry_cloud_cursor_idx ON public.telemetry(created, id);
COMMIT;

-- No row updates or changes to access policies are needed for this migration.
