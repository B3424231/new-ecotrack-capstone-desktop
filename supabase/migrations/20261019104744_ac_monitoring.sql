-- Optional cloud copy. Local monitoring does not require this migration.
-- Review before applying. Uses the existing administrator authorization function.
BEGIN;
DO $$ BEGIN
  IF to_regprocedure('public.ecotrack_is_admin()') IS NULL THEN
    RAISE EXCEPTION 'Install the existing EcoTrack administrator authorization before monitoring backup.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.monitor_nodes (
  id uuid PRIMARY KEY, name text NOT NULL, aircon_id text NOT NULL, aircon_name text NOT NULL,
  location text NOT NULL DEFAULT '', temperature_sensor text NOT NULL DEFAULT 'MCP9808',
  pressure_sensor text NOT NULL, pressure_min_pa double precision NOT NULL, pressure_max_pa double precision NOT NULL,
  state_source text NOT NULL CHECK (state_source IN ('none','power_meter','isolated_contact')),
  expected_interval_seconds double precision NOT NULL CHECK (expected_interval_seconds BETWEEN 1 AND 86400),
  active boolean NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  CHECK (pressure_min_pa < pressure_max_pa)
);
CREATE UNIQUE INDEX IF NOT EXISTS monitor_one_active_per_ac ON public.monitor_nodes(aircon_id) WHERE active;
CREATE TABLE IF NOT EXISTS public.monitor_calibrations (
  id uuid PRIMARY KEY, node_id uuid NOT NULL REFERENCES public.monitor_nodes(id), valid_from timestamptz NOT NULL,
  temperature_offset_c double precision NOT NULL, pressure_offset_pa double precision NOT NULL,
  pressure_scale double precision NOT NULL CHECK (pressure_scale > 0), airflow_threshold_pa double precision,
  notes text NOT NULL, field_calibrated boolean NOT NULL, created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS monitor_cal_node_time ON public.monitor_calibrations(node_id,valid_from);
CREATE TABLE IF NOT EXISTS public.monitor_samples (
  id uuid PRIMARY KEY, node_id uuid NOT NULL REFERENCES public.monitor_nodes(id), aircon_id text NOT NULL,
  aircon_name text NOT NULL, observed_at timestamptz, received_at timestamptz NOT NULL, boot_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0), uptime_ms bigint, interval_seconds double precision NOT NULL CHECK (interval_seconds > 0),
  clock_quality text NOT NULL CHECK (clock_quality IN ('synchronized','unsynchronized')),
  raw_temperature_c double precision, raw_pressure_pa double precision,
  outlet_temperature_c double precision, differential_pressure_pa double precision, ac_on boolean, state_source text,
  temperature_quality text NOT NULL CHECK (temperature_quality IN ('ok','missing','fault','out_of_range')),
  pressure_quality text NOT NULL CHECK (pressure_quality IN ('ok','missing','fault','out_of_range')),
  calibration_id uuid NOT NULL REFERENCES public.monitor_calibrations(id),
  UNIQUE(node_id,boot_id,sequence),
  CHECK ((ac_on IS NULL AND state_source IS NULL) OR (ac_on IS NOT NULL AND state_source IN ('power_meter','isolated_contact'))),
  CHECK ((clock_quality='synchronized' AND observed_at IS NOT NULL) OR (clock_quality='unsynchronized' AND observed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS monitor_sample_ac_time ON public.monitor_samples(aircon_id,observed_at);
CREATE INDEX IF NOT EXISTS monitor_sample_node_time ON public.monitor_samples(node_id,observed_at);
CREATE INDEX IF NOT EXISTS monitor_sample_received ON public.monitor_samples(node_id,received_at);

ALTER TABLE public.monitor_nodes ADD COLUMN IF NOT EXISTS aircon_type text;
ALTER TABLE public.monitor_samples ADD COLUMN IF NOT EXISTS sensor_name text;
ALTER TABLE public.monitor_samples ADD COLUMN IF NOT EXISTS location text;
ALTER TABLE public.monitor_samples ADD COLUMN IF NOT EXISTS aircon_type text;
ALTER TABLE public.monitor_samples ADD COLUMN IF NOT EXISTS battery_voltage double precision;
ALTER TABLE public.monitor_samples ADD COLUMN IF NOT EXISTS rssi_dbm double precision;
ALTER TABLE public.monitor_samples ADD COLUMN IF NOT EXISTS connection_status text;

ALTER TABLE public.monitor_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monitor_calibrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monitor_samples ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.monitor_nodes,public.monitor_calibrations,public.monitor_samples FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.monitor_nodes,public.monitor_calibrations,public.monitor_samples TO authenticated;
GRANT SELECT,INSERT,UPDATE ON public.monitor_nodes,public.monitor_calibrations,public.monitor_samples TO service_role;
DROP POLICY IF EXISTS monitor_nodes_admin_read ON public.monitor_nodes;
CREATE POLICY monitor_nodes_admin_read ON public.monitor_nodes FOR SELECT TO authenticated USING (public.ecotrack_is_admin() IS TRUE);
DROP POLICY IF EXISTS monitor_calibrations_admin_read ON public.monitor_calibrations;
CREATE POLICY monitor_calibrations_admin_read ON public.monitor_calibrations FOR SELECT TO authenticated USING (public.ecotrack_is_admin() IS TRUE);
DROP POLICY IF EXISTS monitor_samples_admin_read ON public.monitor_samples;
CREATE POLICY monitor_samples_admin_read ON public.monitor_samples FOR SELECT TO authenticated USING (public.ecotrack_is_admin() IS TRUE);
COMMIT;
