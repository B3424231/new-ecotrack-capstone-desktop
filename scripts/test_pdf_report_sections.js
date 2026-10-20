const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
process.env.TZ = 'Asia/Singapore';
const source = fs.readFileSync(process.env.ECOTRACK_LOGS_SOURCE || path.join(__dirname, '../public/js/logs.js'), 'utf8');
const helpers = source.slice(source.indexOf('// Read-only supplemental PDF data.'), source.indexOf('// Both original public export entry points'));
assert(helpers.includes('function buildPdfSupplement'));
const at = value => new Date('2026-10-16T' + value + '+08:00');
const rows = [
  { id: 'node-a', name: 'Control A', timestamp: at('06:00:00'), temperature: null, battery: 0, rssi: null, power: null },
  { id: 'node-a', name: 'Control A', timestamp: at('08:00:00'), temperature: 0, battery: 75, rssi: -60, power: false }
];
const report = { rows, controllers: [{ ...rows[1], building: 'Building', floor: 'Floor 1', room: 'Room 1', count: 2, kwh: 2, cost: 20 }] };
const context = vm.createContext({ Date, Intl, console, setTimeout, clearTimeout, selectedDateKey: '2026-10-16',
  getDefaultDateKey: () => '2026-10-16', currentPeriod: 'daily', currentNodeFilter: '', startTimeFilter: '', endTimeFilter: '',
  globalNodeRecords: [{ id: 'node-a', name: 'Control A', room_id: 'room-a', created: '2026-01-01T00:00:00Z' },
    { id: 'node-b', name: 'Control B', room_id: 'room-a' }],
  locationMap: { 'node-a': { buildingName: 'Building', floorName: 'Floor 1', roomName: 'Room 1' } },
  window: {}, localStorage: { getItem: () => null }, getEnergySelectionKey: () => 'same', energyPredictionPending: false
});
vm.runInContext(helpers, context);
vm.runInContext(source.slice(source.indexOf('function reportFormat('), source.indexOf('// Excel dates')), context);
const loaded = (records = [], state = 'loaded', audit = []) => ({ records, state, audit, source: 'Test source' });
const notification = (id, overrides = {}) => ({ id, rule_id: 'rule-1', node_id: 'node-a', room_id: 'room-a',
  triggered: true, content: 'Control A|||Temperature went above 28 C', created: at('09:00:00').toISOString(), ...overrides });
const supplement = (records = [], state = 'loaded', audit = []) => context.buildPdfSupplement(report, loaded(records, state, audit), context.pdfReportScope());
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function targetReport(overrides = {}) {
  const selected = [
    { ...rows[0], building: 'Building', floor: 'Floor 1', room: 'Room 1', setpoint: 21.25, mode: 'COOL', fan: 'LOW', temperature: 29, battery: null },
    { ...rows[1], building: 'Building', floor: 'Floor 1', room: 'Room 1', setpoint: 23.5, mode: 'DRY', fan: 'AUTO', temperature: null, battery: 0 }
  ];
  return { ...report, rows: selected, controllers: [{ ...report.controllers[0], ...selected[1] }],
    intervals: [], notes: [], unknown: 1, ...overrides };
}

function renderSelected(selected) {
  const supplemental = context.buildPdfSupplement(selected, loaded(), context.pdfReportScope());
  const tables = [], paragraphs = [], headings = [], circles = [], lines = [];
  let y = 33;
  const noop = () => {};
  const doc = { addPage: noop, setFont: noop, setFontSize: noop, setTextColor: noop, text: noop,
    setDrawColor: noop, setFillColor: noop, setLineWidth: noop, rect: noop,
    circle: (...args) => circles.push(args), line: (...args) => lines.push(args), splitTextToSize: text => [text] };
  context.calculateEnergyCost = () => null;
  context.renderPdfSupplement(doc, selected, supplemental, {
    table: (head, body) => tables.push({ head: Array.from(head), body: Array.from(body, row => Array.from(row)) }),
    paragraph: text => paragraphs.push(text), heading: text => { headings.push(text); y = 33; },
    stamp: date => date.toISOString(), money: () => 'Unavailable', safe: String,
    ink: [23,56,47], muted: [100,116,139], green: [16,132,98], W: 297, H: 210, M: 14,
    getY: () => y, setY: value => { y = value; }
  });
  return { supplemental, tables, paragraphs, headings, circles, lines };
}

test('PDF target summaries use saved targets independently of measured room temperature', () => {
  const selected = targetReport(), original = JSON.stringify(selected);
  const { supplemental } = renderSelected(selected);
  assert(supplemental.target, 'Missing recorded AC target summary');
  assert.deepEqual(JSON.parse(JSON.stringify(supplemental.target)), { count: 2, mean: 22.375, min: 21.25, max: 23.5 });
  assert.equal(supplemental.aggregation[0].targetStats.count, 2);
  assert.equal(supplemental.temperature.mean, 29);
  assert.equal(supplemental.temperature.count, 1);
  assert.equal(JSON.stringify(selected), original);
});
test('PDF first and last temperatures follow each historical target with the matching mode and fan', () => {
  const rendered = renderSelected(targetReport());
  const table = rendered.tables.find(table => table.head.includes('Physical power'));
  assert.deepEqual(table.head.slice(4,7), ['Target Temperature (C)', 'Operating Mode', 'Blower Fan Mode']);
  assert.deepEqual(table.body[0].slice(4,7), ['21.25', 'COOL', 'LOW']);
  assert.deepEqual(table.body[1].slice(4,7), ['23.5', 'DRY', 'AUTO']);
  assert.equal(table.body[0][9], 'Unknown');
  assert.equal(table.body[1][9], 'Confirmed OFF');
});
test('PDF aggregation labels target statistics and reports their coverage separately from all readings', () => {
  const selected = targetReport(); selected.rows[1].setpoint = null;
  const table = renderSelected(selected).tables.find(table => table.head.includes('Valid targets'));
  assert.deepEqual(table.body[0].slice(0,6), ['Control A', 2, 1, '21.25', '21.25', '21.25']);
  assert.deepEqual(table.body[0].slice(6), [0, 1, 1]);
  selected.rows.forEach(row => { row.setpoint = 21; });
  assert.equal(renderSelected(selected).tables.find(table => table.head.includes('Valid targets')).body[0][3], '21');
});
test('Missing AC targets stay absent despite available measured room temperatures', () => {
  const selected = targetReport(); selected.rows.forEach(row => { row.setpoint = null; row.temperature = 30; });
  const rendered = renderSelected(selected);
  assert.equal(rendered.supplemental.target.count, 0);
  assert(rendered.tables.find(table => table.head.includes('Physical power')).body.every(row => row[4] === 'Not recorded'));
  assert.equal(rendered.circles.length, 0);
  assert(rendered.paragraphs.some(text => text.startsWith('Target temperature trend unavailable:')));
});
test('Requested PDF sections are omitted while genuine zero battery readings remain intact', () => {
  const selected = targetReport(); selected.rows.forEach(row => { row.temperature = null; row.battery = null; });
  let rendered = renderSelected(selected);
  assert(!rendered.tables.some(table => table.head[0] === 'Recorded metric'));
  assert(!rendered.tables.some(table => table.body.some(row => row[0] === 'Measured meter consumption')));
  assert(!rendered.paragraphs.some(text => text.includes('measurements were saved in the selected telemetry')));
  assert.equal(rendered.supplemental.battery.count, 0);
  assert.equal(rendered.tables.find(table => table.head.includes('Physical power')).body[0][7], 'Not recorded');
  selected.rows[1].battery = 0;
  rendered = renderSelected(selected);
  assert.equal(rendered.supplemental.battery.count, 1);
  assert.equal(rendered.supplemental.battery.mean, 0);
  assert.equal(rendered.tables.find(table => table.head.includes('Physical power')).body[1][7], '0');
});
test('The PDF target trend plots saved targets without requiring room-sensor measurements', () => {
  const selected = targetReport(); selected.rows.forEach(row => { row.temperature = null; });
  const rendered = renderSelected(selected);
  assert.equal(rendered.circles.length, 2);
  assert(rendered.paragraphs.some(text => text.includes('Recorded AC target temperature: 21.25 to 23.5 C')));
  assert(!rendered.paragraphs.some(text => text.startsWith('Target temperature trend unavailable:')));
  const expectedFirstY = 43 + 55 - (21.25 - 20) / (25 - 20) * 55;
  assert.equal(rendered.circles[0][1], expectedFirstY);
});
test('A missing target leaves a gap between target-trend segments', () => {
  const selected = targetReport();
  selected.rows.splice(1, 0, { ...selected.rows[0], timestamp: at('07:00:00'), setpoint: null });
  const rendered = renderSelected(selected);
  assert.equal(rendered.circles.length, 2);
  assert.equal(rendered.lines.length, 5); // Axis grid only, no line across the absent target.
});

test('Numeric summaries ignore absent readings and retain zero', () => {
  const summary = context.pdfNumericSummary(rows, 'temperature');
  assert.equal(summary.count, 1); assert.equal(summary.mean, 0); assert.equal(summary.min, 0);
  assert.equal(context.pdfNumericSummary([{ x: null }], 'x').mean, null);
});
test('Created timestamp takes precedence; AM/PM legacy times parse; invalid dates are absent', () => {
  assert.equal(context.pdfNotificationTime({ created: at('09:00:00'), date: '2026-10-16', time: '01:00 PM' }).getHours(), 9);
  assert.equal(context.pdfNotificationTime({ date: '2026-10-16', time: '01:25 PM' }).getHours(), 13);
  assert.equal(context.pdfNotificationTime({ date: '2026-10-16', time: '01:25 AM' }).getHours(), 1);
  assert.equal(context.pdfNotificationTime({ date: 'invalid', time: 'invalid' }), null);
});
test('Period includes violations outside telemetry span and excludes neighboring dates', () => {
  const value = supplement([notification('inside'), notification('before', { created: '2026-10-15T23:59:00+08:00' }),
    notification('after', { created: '2026-10-17T00:00:00+08:00' })]);
  assert.equal(value.violations.length, 1); assert.equal(value.violations[0].date.getHours(), 9);
});
test('Monthly, yearly and weekly report bounds match date keys', () => {
  for (const [period, key, start, end] of [['monthly', '2026-10', '2026-10-01', '2026-11-01'],
    ['yearly', '2026', '2026-01-01', '2027-01-01'], ['weekly', '2026-10-12', '2026-10-12', '2026-10-19']]) {
    context.currentPeriod = period; context.selectedDateKey = key;
    const scope = context.pdfReportScope();
    assert.equal(scope.start.getTime(), new Date(start + 'T00:00:00+08:00').getTime());
    assert.equal(scope.end.getTime(), new Date(end + 'T00:00:00+08:00').getTime());
  }
  context.currentPeriod = 'daily'; context.selectedDateKey = '2026-10-16';
});
test('Overnight and partial time filters respect inclusive minutes', () => {
  context.startTimeFilter = '22:00'; context.endTimeFilter = '06:00';
  assert.equal(supplement([notification('a', { created: at('23:00:00') }), notification('b', { created: at('06:00:59') }), notification('c')]).violations.length, 2);
  context.endTimeFilter = ''; assert.equal(supplement([notification('a', { created: at('23:00:00') }), notification('b')]).violations.length, 1);
  context.startTimeFilter = ''; context.endTimeFilter = '';
});
test('Selected controllers match UUID/name aliases and room-only alerts; exclude other explicit targets', () => {
  context.currentNodeFilter = 'Control A';
  const value = supplement([notification('uuid'), notification('name', { node_id: null }),
    notification('other', { node_id: 'node-b', content: 'Control B|||Temperature exceeded threshold' }),
    notification('room', { node_id: null, content: 'Temperature exceeded threshold' })]);
  assert.equal(value.violations.length, 3);
  context.currentNodeFilter = '';
});
test('Routine, battery, installation, maintenance and non-triggered notifications are excluded', () => {
  for (const overrides of [{ triggered: false }, { triggered: 0 }, { type: 'controller_installation' }, { is_schedule: true },
    { content: 'Control A|||Battery threshold reached' }, { content: 'Control A|||Wake schedule completed' },
    { type: 'maintenance_request' }, { content: 'Control A|||Maintenance verification' }]) {
    assert.equal(context.pdfIsViolation(notification('n', overrides)), false);
  }
  assert.equal(context.pdfIsViolation(notification('n')), true);
});
test('Dismissed alerts remain; audit duplicates collapse; distinct cloud IDs remain', () => {
  const first = notification('first', { content: '__INBOX_DISMISSED__|||Control A|||Temperature went above 28 C' });
  const value = supplement([first, notification('second')], 'loaded', [notification('first'), notification('audit-copy')]);
  assert.equal(value.violations.length, 2); assert.equal(value.violations[0].dismissed, true);
});
test('Installation history uses frozen installation details, never current locations', () => {
  const event = { id: 'install', type: 'controller_installation', room_id: 'old-room', created: at('10:00:00'), installation: {
    installed_at: at('07:00:00').toISOString(), node_id: 'node-a', controller_name: 'Original Control A', room_id: 'old-room',
    installer_name: 'Installer', building_name: 'Original Building', floor_name: 'Original Floor', room_name: 'Original Room' } };
  const value = supplement([event, { ...event, id: 'bad', room_id: 'other' }, { type: 'controller_installation', id: 'missing' }]);
  assert.equal(value.installations.length, 1); assert.equal(value.installations[0].building, 'Original Building');
  assert.equal(value.installations[0].date.getHours(), 7); assert.equal(value.installations[0].installer, 'Installer');
});
test('Available empty notification source differs from unavailable and partial sources', () => {
  assert.equal(supplement().notificationStatus, 'loaded');
  assert.equal(supplement([], 'unavailable').notificationStatus, 'unavailable');
  assert.equal(supplement([], 'partial').notificationStatus, 'partial');
  assert.equal(supplement([notification('bad', { created: 'bad' })]).notificationStatus, 'partial');
  assert.equal(supplement().ranking[0].kwh, 2);
});
test('An empty successful IPC read does not fall back to a different source', async () => {
  let fallbacks = 0;
  context.window.electron = { invoke: async channel => { assert.equal(channel, 'notifications-fetch-all'); return { success: true, data: [] }; } };
  context.window.sb = { from: () => { fallbacks++; throw Error('Should not run'); } };
  const value = await context.pdfReadNotifications();
  assert.equal(value.state, 'loaded'); assert.equal(fallbacks, 0);
});
test('Failed IPC uses existing browser client; failed reads retain unavailable status and audit', async () => {
  context.window.electron = { invoke: async () => ({ success: false }) };
  context.window.sb = { from: () => ({ select: () => ({ order: async () => ({ data: [notification('browser')], error: null }) }) }) };
  assert.equal((await context.pdfReadNotifications()).records[0].id, 'browser');
  context.window.sb = null;
  context.localStorage.getItem = key => key.endsWith('_history') ? JSON.stringify([notification('audit')]) : null;
  const value = await context.pdfReadNotifications();
  assert.equal(value.state, 'unavailable'); assert.equal(value.audit.length, 1);
  context.localStorage.getItem = () => null;
});
test('Truncated notification reads and unreadable audit histories are marked partial', async () => {
  context.window.electron = { invoke: async () => ({ success: true, data: Array(1000).fill(notification('x')) }) };
  assert.equal((await context.pdfReadNotifications()).state, 'partial');
  context.window.electron = { invoke: async () => ({ success: true, data: [] }) };
  context.localStorage.getItem = () => '{bad';
  assert.equal((await context.pdfReadNotifications()).state, 'partial');
  context.localStorage.getItem = () => null;
});
test('Selection changes during notification preparation reject a stale export', async () => {
  let key = 'before'; context.getEnergySelectionKey = () => key;
  context.window.electron = { invoke: async () => { key = 'after'; return { success: true, data: [] }; } };
  await assert.rejects(context.preparePdfSupplement(report), /selection changed/);
});

(async () => {
  for (const [name, fn] of tests) { await fn(); console.log('PASS ' + name); }
  console.log(`PASS ${tests.length} PDF report regression checks`);
})().catch(error => { console.error(error); process.exitCode = 1; });
