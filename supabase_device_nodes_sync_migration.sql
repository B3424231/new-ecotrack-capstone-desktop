-- ==============================================================================
-- EcoTrack Device & Node Synchronization Schema Migration
-- Standardizes hardware fields on nodes and harmonizes aircons table linking
-- ==============================================================================

-- 1. Ensure hardware attributes exist directly on public.nodes table
ALTER TABLE IF EXISTS public.nodes 
    ADD COLUMN IF NOT EXISTS brand TEXT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS mac_address TEXT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS ip_address TEXT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS wifi_ssid TEXT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS protocol_name TEXT DEFAULT 'midea_ir';

-- 2. Ensure public.aircons table has all required columns and constraints
CREATE TABLE IF NOT EXISTS public.aircons (
    id TEXT PRIMARY KEY DEFAULT ('ac_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 15)),
    asset_tag TEXT UNIQUE NOT NULL,
    brand TEXT NOT NULL DEFAULT 'Daikin',
    model TEXT DEFAULT 'Split Type (Inverter)',
    aircon_type TEXT DEFAULT 'Split Type (Inverter)',
    room_id TEXT REFERENCES public.rooms(id) ON DELETE SET NULL,
    node_id TEXT,
    protocol TEXT DEFAULT 'midea_ir',
    protocol_name TEXT DEFAULT 'midea_ir',
    status TEXT NOT NULL DEFAULT 'online',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure columns exist if table was already created
ALTER TABLE IF EXISTS public.aircons
    ADD COLUMN IF NOT EXISTS asset_tag TEXT,
    ADD COLUMN IF NOT EXISTS brand TEXT,
    ADD COLUMN IF NOT EXISTS model TEXT DEFAULT 'Split Type (Inverter)',
    ADD COLUMN IF NOT EXISTS aircon_type TEXT DEFAULT 'Split Type (Inverter)',
    ADD COLUMN IF NOT EXISTS room_id TEXT REFERENCES public.rooms(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS node_id TEXT,
    ADD COLUMN IF NOT EXISTS protocol TEXT DEFAULT 'midea_ir',
    ADD COLUMN IF NOT EXISTS protocol_name TEXT DEFAULT 'midea_ir',
    ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'online',
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- 3. Indexes for fast lookup & relational joining
CREATE INDEX IF NOT EXISTS idx_nodes_brand ON public.nodes(brand);
CREATE INDEX IF NOT EXISTS idx_aircons_asset_tag ON public.aircons(asset_tag);
CREATE INDEX IF NOT EXISTS idx_aircons_node_id ON public.aircons(node_id);
CREATE INDEX IF NOT EXISTS idx_aircons_room_id ON public.aircons(room_id);

-- 4. Enable Row Level Security (RLS) on both tables with full access for app operations
ALTER TABLE public.nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aircons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public all access on nodes" ON public.nodes;
CREATE POLICY "Allow public all access on nodes" ON public.nodes FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow public all access on aircons" ON public.aircons;
CREATE POLICY "Allow public all access on aircons" ON public.aircons FOR ALL USING (true) WITH CHECK (true);

-- 5. Realtime publication registration
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        IF NOT EXISTS (
            SELECT 1 FROM pg_publication_tables 
            WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'nodes'
        ) THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.nodes;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_publication_tables 
            WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'aircons'
        ) THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.aircons;
        END IF;
    END IF;
END $$;
