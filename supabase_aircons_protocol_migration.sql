-- ==============================================================================
-- EcoTrack Universal Aircon IoT: Migration to Dynamic Protocol Generation
-- Migrating from Raw IR Button-Learning to Climate IR Protocol Generation
-- ==============================================================================

-- 1. Ensure protocol_name column exists on aircons table
ALTER TABLE IF EXISTS public.aircons 
    ADD COLUMN IF NOT EXISTS protocol_name TEXT DEFAULT 'midea_ir';

-- 2. Ensure protocol column exists for backward compatibility
ALTER TABLE IF EXISTS public.aircons 
    ADD COLUMN IF NOT EXISTS protocol TEXT DEFAULT 'midea_ir';

-- 3. Ensure nodes table also has protocol_name for direct hardware association
ALTER TABLE IF EXISTS public.nodes 
    ADD COLUMN IF NOT EXISTS protocol_name TEXT DEFAULT 'midea_ir';

-- 4. Deprecate (do not drop) legacy raw commands JSON column
DO $$ 
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'aircons' 
          AND column_name = 'raw_commands'
    ) THEN
        COMMENT ON COLUMN public.aircons.raw_commands IS 
        'DEPRECATED: Preserved for legacy clients. Active dispatches use protocol_name and dynamic state generation.';
    END IF;
END $$;

-- 5. Create index on protocol_name for fast lookup
CREATE INDEX IF NOT EXISTS idx_aircons_protocol_name ON public.aircons(protocol_name);

-- 6. Add protocol_name comment
COMMENT ON COLUMN public.aircons.protocol_name IS 
'Dynamic IR protocol identifier (e.g. midea_ir, gree, daikin, carrier, panasonic, koppel_ir, mitsubishi, samsung, generic_ac)';
