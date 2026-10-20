const fs = require('fs');
const path = require('path');

console.log('━━━ AUDITING CODEBASE: ZERO MOCK DATA INTEGRITY ━━━\n');

let failed = 0;
let passed = 0;

function test(name, condition, errorMsg) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ ${name}: ${errorMsg}`);
    failed++;
  }
}

// 1. shared.js
const sharedPath = path.join(__dirname, '../public/js/shared.js');
const sharedCode = fs.readFileSync(sharedPath, 'utf8');
test(
  'shared.js: MockDataGenerator injection removed',
  !sharedCode.includes('MockDataGenerator.generateFullDataset'),
  'Still calls MockDataGenerator'
);
test(
  'shared.js: MockPocketBase class removed',
  !sharedCode.includes('class MockPocketBase'),
  'Still defines MockPocketBase'
);
test(
  'shared.js: Fake fetch interceptor removed',
  !sharedCode.includes('window.fetch = async') && !sharedCode.includes('mock-token'),
  'Still intercepts window.fetch with mock tokens/data'
);

// 2. login.js
const loginPath = path.join(__dirname, '../public/js/login.js');
const loginCode = fs.readFileSync(loginPath, 'utf8');
test(
  'login.js: Offline mock admin login removed',
  !loginCode.includes('admin@ecotrack.local') && !loginCode.includes('adminpassword123'),
  'Still contains offline mock login credentials'
);

// 3. maintenance-modal.js
const maintPath = path.join(__dirname, '../public/js/maintenance-modal.js');
const maintCode = fs.readFileSync(maintPath, 'utf8');
test(
  'maintenance-modal.js: Hardcoded AIRCONS_DATABASE array removed',
  !maintCode.includes("room: 'Room 101'") && !maintCode.includes("brand: 'Panasonic'"),
  'Still contains hardcoded mock aircons'
);
test(
  'maintenance-modal.js: Hardcoded DEFAULT_STAFF array removed',
  !maintCode.includes("carlos@ecotrack.local"),
  'Still contains hardcoded mock staff'
);
test(
  'maintenance-modal.js: Hardcoded DEFAULT_REPORTS array removed',
  !maintCode.includes("MR-2026-001"),
  'Still contains hardcoded mock maintenance reports'
);

// 4. telemetry-new.js
const telemPath = path.join(__dirname, '../public/js/telemetry-new.js');
const telemCode = fs.readFileSync(telemPath, 'utf8');
test(
  'telemetry-new.js: EcoTrackDataLayer fallback removed',
  !telemCode.includes('EcoTrackDataLayer'),
  'Still contains fallback to EcoTrackDataLayer'
);

// 5. analytics.js
const analyticsPath = path.join(__dirname, '../public/js/analytics.js');
const analyticsCode = fs.readFileSync(analyticsPath, 'utf8');
test(
  'analytics.js: EcoTrackDataLayer fallbacks removed',
  !analyticsCode.includes('EcoTrackDataLayer'),
  'Still contains fallbacks to EcoTrackDataLayer'
);
test(
  'analytics.js: Random mock compliance scores removed',
  !analyticsCode.includes('Mock compliance'),
  'Still uses Math.random() mock compliance'
);

// 6. notifications.js
const notifPath = path.join(__dirname, '../public/js/notifications.js');
const notifCode = fs.readFileSync(notifPath, 'utf8');
test(
  'notifications.js: EcoTrackDataLayer fallbacks removed',
  !notifCode.includes('EcoTrackDataLayer'),
  'Still contains EcoTrackDataLayer fallback'
);
test(
  'notifications.js: loadMockMessages renamed to loadNotificationMessages',
  !notifCode.includes('loadMockMessages') && notifCode.includes('loadNotificationMessages'),
  'Still calls or defines loadMockMessages'
);

// 7. supabase-client.js
const sbPath = path.join(__dirname, '../public/js/supabase-client.js');
const sbCode = fs.readFileSync(sbPath, 'utf8');
test(
  'supabase-client.js: EcoTrackDataLayer fallbacks removed',
  !sbCode.includes('EcoTrackDataLayer'),
  'Still contains fallback to EcoTrackDataLayer'
);

// 8. HTML files script tags
const htmlFiles = [
  'login.html', 'telemetry.html', 'analytics.html',
  'scheduler.html', 'rules.html', 'staff.html',
  'Notification.html', 'logs.html'
];
htmlFiles.forEach(file => {
  const htmlPath = path.join(__dirname, '../public', file);
  const htmlCode = fs.readFileSync(htmlPath, 'utf8');
  test(
    `${file}: Does not include data-schemas.js or data-logic.js`,
    !htmlCode.includes('data-schemas.js') && !htmlCode.includes('data-logic.js'),
    'Still includes mock data scripts'
  );
});

// 9. renderer.js
const rendererPath = path.join(__dirname, '../public/renderer.js');
const rendererCode = fs.readFileSync(rendererPath, 'utf8');
test(
  'renderer.js: Cleared of legacy mock data generator',
  !rendererCode.includes('generateMockData'),
  'Still contains generateMockData'
);

// 10. staff.js & staff.html (Registered Maintenance Staff)
const staffJsPath = path.join(__dirname, '../public/js/staff.js');
const staffJsCode = fs.readFileSync(staffJsPath, 'utf8');
test(
  'staff.js: Cleared of Carlos Rivera and mock staff list',
  !staffJsCode.includes('carlos@ecotrack.local') && !staffJsCode.includes("name: 'Carlos Rivera'"),
  'Still contains mock staff in staff.js'
);

const staffHtmlPath = path.join(__dirname, '../public/staff.html');
const staffHtmlCode = fs.readFileSync(staffHtmlPath, 'utf8');
test(
  'staff.html: Detail modal cleared of Carlos Rivera placeholder',
  !staffHtmlCode.includes('Carlos Rivera') && !staffHtmlCode.includes('carlos@ecotrack.local'),
  'Still contains Carlos Rivera in staff.html modal'
);

test(
  'telemetry-new.js: Visual demo simulator loop removed',
  !telemCode.includes('UI_CADENCE_MS') && !telemCode.includes('lastUIUpdateMap'),
  'Still contains fake telemetry generator loop'
);

// 5. node-sync.js
const syncPath = path.join(__dirname, '../public/js/node-sync.js');
const syncCode = fs.readFileSync(syncPath, 'utf8');
test(
  'node-sync.js: Fake historical telemetry generation removed',
  !syncCode.includes('tempOffset = (Math.random()'),
  'Still generates fake historical telemetry'
);
test(
  'node-sync.js: Fake background cadence telemetry generation removed',
  !syncCode.includes('Math.round(baseTemp + (Math.random()'),
  'Still generates fake cadence telemetry'
);

// 6. nodes.html
const nodesPath = path.join(__dirname, '../public/nodes.html');
const nodesCode = fs.readFileSync(nodesPath, 'utf8');
test(
  'nodes.html: Hardcoded mock buildings/rooms fallbacks removed',
  !nodesCode.includes('Science & Research Wing') && !nodesCode.includes('Clean Room Alpha'),
  'Still contains mock buildings or rooms'
);
test(
  'nodes.html: Simulated Math.random ping latency removed',
  !nodesCode.includes('baseLatency = Math.floor(Math.random()'),
  'Still uses Math.random() for ping latency'
);

// 7. control.html
const controlPath = path.join(__dirname, '../public/control.html');
const controlCode = fs.readFileSync(controlPath, 'utf8');
test(
  'control.html: Hardcoded Server Room A AC in error modal removed',
  !controlCode.includes('Server Room A AC'),
  'Still contains hardcoded Server Room A AC'
);
test(
  'control.html: Simulated Math.random ping latency removed',
  !controlCode.includes('latencyMs = Math.floor(Math.random()'),
  'Still uses Math.random() for ping latency'
);

// 8. staff.js and staff.html
test(
  'staff.js: Fallback mock buildings/rooms removed',
  !staffJsCode.includes('Main Office Area'),
  'Still contains Main Office Area fallback'
);
test(
  'staff.html: Static mock room options removed',
  !staffHtmlCode.includes('Main Office Area'),
  'Still contains static Main Office Area options'
);

// 9. supabase-client.js
test(
  'supabase-client.js: Fake ID Math.random generation removed',
  !sbCode.includes("fakeId = 'telem_' + Math.random()") && !sbCode.includes("Math.random().toString(36).substring(2, 11)"),
  'Still fabricates fake IDs on database failure'
);

console.log('\n══════════════════════════════════════════════════');
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log('══════════════════════════════════════════════════\n');

if (failed > 0) process.exit(1);
