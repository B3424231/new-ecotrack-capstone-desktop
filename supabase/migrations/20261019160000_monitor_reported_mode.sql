-- Optional backup schema only. Review and apply after the AC monitoring migration.
-- Existing history stays null; commands and power feedback cannot backfill a mode.
BEGIN;
ALTER TABLE public.monitor_samples ADD COLUMN IF NOT EXISTS operating_mode text
  CHECK (operating_mode IN ('cool', 'fan_only'));
COMMIT;
