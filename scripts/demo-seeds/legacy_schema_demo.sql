-- OPTIONAL LEGACY DEMO DATA ONLY. Never run against real application data.
-- ===================================================================
-- INITIAL DEFAULT SEED DATA
-- ===================================================================

-- Default Administrator
INSERT INTO administrators (id, username, email, password, role, is_active)
VALUES ('admin_default_01', 'admin', 'admin@ecotrack.local', 'adminpassword123', 'admin', true)
ON CONFLICT (id) DO NOTHING;

-- Default Building & Floor
INSERT INTO buildings (id, name)
VALUES ('bld_main', 'Main Campus Building')
ON CONFLICT (id) DO NOTHING;

INSERT INTO floors (id, name, building_id)
VALUES ('flr_2nd_it', '2nd Floor - IT Wing', 'bld_main')
ON CONFLICT (id) DO NOTHING;

-- Default Rooms
INSERT INTO rooms (id, name, node_limit, floor_id)
VALUES 
    ('rm_svr_01', 'Server Room A', 5, 'flr_2nd_it'),
    ('rm_ofc_01', 'Main Office Area', 5, 'flr_2nd_it'),
    ('rm_lab_01', 'Laboratory A', 5, 'flr_2nd_it')
ON CONFLICT (id) DO NOTHING;

-- Default Nodes
INSERT INTO nodes (id, name, status, temp, pressure, battery, rssi, room_id, aircon_type)
VALUES 
    ('node_001', 'node-1', 'online', 23.5, 0.48, 4.15, -65, 'rm_svr_01', 'Split Type (Inverter)'),
    ('node_002', 'node-2', 'online', 24.1, 0.51, 4.08, -70, 'rm_svr_01', 'Split Type (Inverter)'),
    ('node_003', 'node-3', 'online', 22.8, 0.50, 4.20, -60, 'rm_ofc_01', 'Floor Standing'),
    ('node_004', 'node-4', 'online', 23.2, 0.49, 4.12, -68, 'rm_ofc_01', 'Floor Standing'),
    ('node_005', 'node-5', 'online', 25.4, 0.53, 3.95, -75, 'rm_ofc_01', 'Split Type (Inverter)'),
    ('node_006', 'node-6', 'online', 21.9, 0.47, 4.18, -62, 'rm_lab_01', 'Window Type')
ON CONFLICT (id) DO NOTHING;

-- Default Rules
INSERT INTO rules (id, type, condition, value, unit, enabled, message, room_id)
VALUES
    ('rule_svr_temp', 'temperature', 'above', 26.0, '°C', true, 'Server Room temperature exceeded safe operating threshold.', 'rm_svr_01'),
    ('rule_node_bat', 'battery', 'below', 20.0, '%', true, 'Sensor battery charge is critically low. Battery replacement advised.', NULL)
ON CONFLICT (id) DO NOTHING;


