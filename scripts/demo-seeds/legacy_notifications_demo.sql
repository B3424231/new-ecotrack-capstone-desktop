-- OPTIONAL LEGACY DEMO DATA ONLY. Never run against real application data.
-- 6. INSERT SEED NOTIFICATIONS FOR IMMEDIATE DEMO & TESTING
INSERT INTO public.mobile_notifications (
  id, staff_name, title, message, type, priority, category,
  related_report_id, aircon_id, aircon_name, location, due_date, is_read, created_at
) VALUES 
(
  'mob_notif_001',
  'Maintenance Staff',
  'Routine Maintenance Due Today',
  'Scheduled filter cleaning & sensor inspection for Node 01 (Server Room A) is due today. Please complete checklist.',
  'task_reminder',
  'high',
  'task',
  'MR-2026-001',
  'node_01',
  'Server Room AC Unit',
  'Main Campus Building • Server Room A',
  to_char(NOW(), 'YYYY-MM-DD'),
  FALSE,
  NOW() - INTERVAL '15 minutes'
),
(
  'mob_notif_002',
  'Maintenance Staff',
  'New Task Assigned: Coil Inspection',
  'You have been assigned to quarterly condenser coil inspection & airflow diagnostics for IT Wing AC 02.',
  'task_assigned',
  'medium',
  'task',
  'MR-2026-002',
  'node_02',
  'IT Wing Split AC',
  'Main Campus Building • 2nd Floor IT Wing',
  to_char(NOW() + INTERVAL '2 days', 'YYYY-MM-DD'),
  FALSE,
  NOW() - INTERVAL '1 hour'
),
(
  'mob_notif_003',
  'Maintenance Staff',
  'Urgent Repair Alert: High Temperature',
  'AC Unit 03 in Conference Hall B exceeded critical threshold (29.4°C). Immediate inspection required.',
  'urgent_repair',
  'critical',
  'maintenance',
  'MR-2026-003',
  'node_03',
  'Conference Hall Multi-Split',
  'Executive Building • Conf Hall B',
  to_char(NOW(), 'YYYY-MM-DD'),
  FALSE,
  NOW() - INTERVAL '2 hours'
),
(
  'mob_notif_004',
  'Maintenance Staff',
  'Weekly Preventive Checklist Reminder',
  'Ensure all condensate drain trays and electrical terminal connections in East Wing are checked before weekend.',
  'preventive_routine',
  'medium',
  'maintenance',
  'MR-2026-004',
  'node_04',
  'East Wing Ducted AC',
  'East Wing • Floor 1 Corridor',
  to_char(NOW() + INTERVAL '3 days', 'YYYY-MM-DD'),
  TRUE,
  NOW() - INTERVAL '1 day'
)
ON CONFLICT (id) DO NOTHING;
