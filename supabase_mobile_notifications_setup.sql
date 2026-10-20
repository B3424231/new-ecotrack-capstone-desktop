-- ==============================================================================
-- EcoTrack Supabase SQL Migration: Mobile Notifications & Maintenance Reminders
-- Execute this entire script in your Supabase Project -> SQL Editor -> Run
-- ==============================================================================

-- 1. CREATE TABLE `mobile_notifications`
CREATE TABLE IF NOT EXISTS public.mobile_notifications (
  id TEXT PRIMARY KEY,
  staff_id TEXT,
  staff_name TEXT DEFAULT 'All Staff',
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'task_reminder', 
  -- Types: 'task_assigned', 'task_reminder', 'overdue_alert', 'urgent_repair', 'preventive_routine', 'sensor_alert', 'status_update'
  priority TEXT NOT NULL DEFAULT 'medium',
  -- Priorities: 'critical', 'urgent', 'high', 'medium', 'low'
  category TEXT NOT NULL DEFAULT 'maintenance',
  -- Categories: 'task', 'maintenance', 'sensor', 'system'
  related_report_id TEXT,
  aircon_id TEXT,
  aircon_name TEXT,
  location TEXT,
  due_date TEXT,
  is_read BOOLEAN DEFAULT FALSE,
  is_snoozed BOOLEAN DEFAULT FALSE,
  snooze_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. CREATE INDEXES FOR FAST QUERYING
CREATE INDEX IF NOT EXISTS idx_mobile_notif_staff_name ON public.mobile_notifications(staff_name);
CREATE INDEX IF NOT EXISTS idx_mobile_notif_is_read ON public.mobile_notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_mobile_notif_created_at ON public.mobile_notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mobile_notif_type ON public.mobile_notifications(type);
CREATE INDEX IF NOT EXISTS idx_mobile_notif_report ON public.mobile_notifications(related_report_id);

-- 3. ENABLE ROW LEVEL SECURITY (RLS) & ACCESS POLICIES
ALTER TABLE public.mobile_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public read access to mobile_notifications" ON public.mobile_notifications;
DROP POLICY IF EXISTS "Allow public insert access to mobile_notifications" ON public.mobile_notifications;
DROP POLICY IF EXISTS "Allow public update access to mobile_notifications" ON public.mobile_notifications;
DROP POLICY IF EXISTS "Allow public delete access to mobile_notifications" ON public.mobile_notifications;

CREATE POLICY "Allow public read access to mobile_notifications"
ON public.mobile_notifications FOR SELECT
USING (true);

CREATE POLICY "Allow public insert access to mobile_notifications"
ON public.mobile_notifications FOR INSERT
WITH CHECK (true);

CREATE POLICY "Allow public update access to mobile_notifications"
ON public.mobile_notifications FOR UPDATE
USING (true)
WITH CHECK (true);

CREATE POLICY "Allow public delete access to mobile_notifications"
ON public.mobile_notifications FOR DELETE
USING (true);

-- 4. ENABLE SUPABASE REALTIME REPLICATION
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
      AND schemaname = 'public' 
      AND tablename = 'mobile_notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.mobile_notifications;
  END IF;
END $$;

-- 5. POSTGRES TRIGGER: AUTOMATICALLY GENERATE MOBILE NOTIFICATIONS FROM MAINTENANCE REPORTS
CREATE OR REPLACE FUNCTION public.fn_sync_maintenance_to_mobile_notifications()
RETURNS TRIGGER AS $$
DECLARE
  v_notif_id TEXT;
  v_title TEXT;
  v_message TEXT;
  v_type TEXT;
  v_priority TEXT;
BEGIN
  -- Handle INSERT: New task assigned to maintenance technician
  IF (TG_OP = 'INSERT') THEN
    -- Deterministic notification ID mapped directly to the report ID prevents duplicate rows
    v_notif_id := 'mob_task_' || NEW.id;
    v_title := 'New Maintenance Task Assigned';
    v_message := COALESCE(NEW.description, 'Preventive Maintenance Inspection') || ' assigned at ' || COALESCE(NEW.room_name, 'Assigned Area') || ' (' || COALESCE(NEW.aircon_name, 'AC Unit') || '). Due: ' || COALESCE(NEW.due_date, 'Scheduled');
    v_type := 'task_assigned';
    v_priority := CASE WHEN NEW.priority = 'High' THEN 'high' ELSE 'medium' END;

    -- Avoid duplicate notification if already created by client or previous trigger
    IF NOT EXISTS (
      SELECT 1 FROM public.mobile_notifications 
      WHERE related_report_id = NEW.id AND type = 'task_assigned'
    ) THEN
      INSERT INTO public.mobile_notifications (
        id, staff_name, title, message, type, priority, category,
        related_report_id, aircon_id, aircon_name, location, due_date, is_read, created_at
      ) VALUES (
        v_notif_id,
        COALESCE(NEW.staff_name, 'Maintenance Staff'),
        v_title,
        v_message,
        v_type,
        v_priority,
        'task',
        NEW.id,
        NEW.aircon_id,
        NEW.aircon_name,
        NEW.room_name,
        NEW.due_date,
        FALSE,
        NOW()
      ) ON CONFLICT (id) DO NOTHING;
    END IF;
  END IF;

  -- Handle UPDATE: Urgent repair needed or status change
  IF (TG_OP = 'UPDATE') THEN
    IF (NEW.status = 'Needs Repair' AND (OLD.status IS DISTINCT FROM 'Needs Repair')) THEN
      v_notif_id := 'mob_repair_' || NEW.id;
      v_title := 'URGENT: Defect / Repair Needed';
      v_message := 'AC Unit ' || COALESCE(NEW.aircon_name, NEW.aircon_id, 'Unit') || ' at ' || COALESCE(NEW.room_name, 'Location') || ' requires urgent repair: ' || COALESCE(NEW.description, 'Defect reported.');
      
      IF NOT EXISTS (
        SELECT 1 FROM public.mobile_notifications 
        WHERE related_report_id = NEW.id AND type = 'urgent_repair'
      ) THEN
        INSERT INTO public.mobile_notifications (
          id, staff_name, title, message, type, priority, category,
          related_report_id, aircon_id, aircon_name, location, due_date, is_read, created_at
        ) VALUES (
          v_notif_id,
          COALESCE(NEW.staff_name, 'Maintenance Staff'),
          v_title,
          v_message,
          'urgent_repair',
          'critical',
          'maintenance',
          NEW.id,
          NEW.aircon_id,
          NEW.aircon_name,
          NEW.room_name,
          NEW.due_date,
          FALSE,
          NOW()
        ) ON CONFLICT (id) DO NOTHING;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach trigger to maintenance_reports table if it exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'maintenance_reports') THEN
    DROP TRIGGER IF EXISTS trg_maintenance_to_mobile_notif ON public.maintenance_reports;
    CREATE TRIGGER trg_maintenance_to_mobile_notif
    AFTER INSERT OR UPDATE ON public.maintenance_reports
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_sync_maintenance_to_mobile_notifications();
  END IF;
END $$;

-- 5b. PREVENT DUPLICATE NOTIFICATIONS AT DATABASE LEVEL
CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_notif_unique_report_type 
ON public.mobile_notifications(related_report_id, type) 
WHERE related_report_id IS NOT NULL;

-- Optional demo notifications are stored separately in scripts/demo-seeds/.
