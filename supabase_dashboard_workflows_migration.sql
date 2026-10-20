-- Run in the Supabase SQL editor before using the updated dashboard.
-- This grants the requested anon/authenticated CRUD access. The permissive
-- policies allow anyone holding the public API key to modify these records.
-- References: https://supabase.com/docs/guides/database/postgres/row-level-security
BEGIN;

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS is_dismissed_from_inbox boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS node_id text,
  ADD COLUMN IF NOT EXISTS report_id text,
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS event_key text;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_event_key_unique
  ON public.notifications (event_key) WHERE event_key IS NOT NULL;

-- Migrate legacy dismissals while retaining the original violation content.
UPDATE public.notifications
SET is_dismissed_from_inbox = true,
    content = substr(content, length('__INBOX_DISMISSED__|||') + 1)
WHERE left(content, length('__INBOX_DISMISSED__|||')) = '__INBOX_DISMISSED__|||';

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.nodes, public.aircons, public.notifications,
  public.maintenance_reports, public.staff TO anon, authenticated;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['nodes', 'aircons', 'notifications', 'maintenance_reports', 'staff'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS dashboard_workflow_crud ON public.%I', table_name);
    EXECUTE format('CREATE POLICY dashboard_workflow_crud ON public.%I FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)', table_name);
  END LOOP;
  -- Hierarchy/reference lookups also need read access in browser mode.
  FOREACH table_name IN ARRAY ARRAY['buildings', 'floors', 'rooms', 'rules'] LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO anon, authenticated', table_name);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS dashboard_workflow_read ON public.%I', table_name);
    EXECUTE format('CREATE POLICY dashboard_workflow_read ON public.%I FOR SELECT TO anon, authenticated USING (true)', table_name);
  END LOOP;
END $$;

-- Report removal is atomic, including descendants and notification references.
GRANT SELECT, DELETE ON public.mobile_notifications TO anon, authenticated;
ALTER TABLE public.mobile_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dashboard_mobile_notification_read ON public.mobile_notifications;
CREATE POLICY dashboard_mobile_notification_read ON public.mobile_notifications
  FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS dashboard_mobile_notification_delete ON public.mobile_notifications;
CREATE POLICY dashboard_mobile_notification_delete ON public.mobile_notifications
  FOR DELETE TO anon, authenticated USING (true);

CREATE OR REPLACE FUNCTION public.delete_maintenance_reports(report_ids text[])
RETURNS TABLE(id text)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE deletion_ids text[];
BEGIN
  WITH RECURSIVE descendants AS (
    SELECT r.id::text AS report_id FROM public.maintenance_reports r WHERE r.id::text = ANY(report_ids)
    UNION
    SELECT child.id::text FROM public.maintenance_reports child
    JOIN descendants parent ON child.parent_report_id::text = parent.report_id
  ) SELECT array_agg(report_id) INTO deletion_ids FROM descendants;
  IF deletion_ids IS NULL THEN RETURN; END IF;

  DELETE FROM public.mobile_notifications n WHERE n.related_report_id::text = ANY(deletion_ids);
  UPDATE public.maintenance_reports r SET linked_repair_id = NULL
    WHERE r.linked_repair_id::text = ANY(deletion_ids);
  RETURN QUERY DELETE FROM public.maintenance_reports r
    WHERE r.id::text = ANY(deletion_ids) RETURNING r.id::text;
END $$;
REVOKE ALL ON FUNCTION public.delete_maintenance_reports(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_maintenance_reports(text[]) TO anon, authenticated, service_role;

-- Logs can refresh their interval metadata as soon as a saved schedule changes.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'nodes') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.nodes;
  END IF;
END $$;

COMMIT;
