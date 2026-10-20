'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.ECOTRACK_DESKTOP_NOTIFICATIONS_SOURCE_ROOT || path.resolve(__dirname, '..');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
function database(records = []) {
  const db = { records: clone(records), reports: [], writes: [], fetchHook: null, readHook: null, mutationHook: null, sequence: 0 };
  const client = { from(table) {
    const call = { table, mode: 'read', filters: [], payload: null };
    const query = new Proxy({}, { get(_target, name) {
      if (name === 'then') return (resolve, reject) => Promise.resolve().then(async () => {
        if (call.mode === 'read') {
          if (table === 'maintenance_reports') return { data: clone(db.reports), error: null };
          if (table === 'notifications') return db.readHook ? db.readHook(call) : { data: clone(db.records), error: null };
          return { data: { id: call.filters[0]?.[1] }, error: null };
        }
        if (call.mode === 'insert') {
          const payload = Array.isArray(call.payload) ? call.payload[0] : call.payload;
          if (payload.event_key && db.records.some(row => row.event_key === payload.event_key)) return { data: null, error: { code: '23505', message: 'Duplicate event key' } };
          const row = { id: 'generated-' + (++db.sequence), ...clone(payload) };
          db.records.push(row); db.writes.push(clone(call)); return { data: clone(row), error: null };
        }
        db.writes.push(clone(call));
        if (db.mutationHook) return db.mutationHook(call);
        const targets = new Set(call.filters.flatMap(([_name, value]) => Array.isArray(value) ? value.map(String) : [String(value)]));
        const matched = db.records.filter(row => targets.has(String(row.id)));
        if (call.mode === 'delete') db.records = db.records.filter(row => !targets.has(String(row.id)));
        else matched.forEach(row => Object.assign(row, clone(call.payload)));
        return { data: clone(matched), error: null };
      }).then(resolve, reject);
      return (...args) => {
        if (name === 'update' || name === 'insert' || name === 'delete') { call.mode = name; call.payload = args[0]; }
        if (name === 'eq' || name === 'in') call.filters.push([args[0], args[1]]);
        return query;
      };
    } }); return query;
  } };
  db.client = client;
  const handlers = {};
  const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
  const start = main.indexOf('function notificationMutationIds('), end = main.indexOf('// Rules Management Privileged IPC Handlers', start);
  assert.ok(start >= 0 && end > start, 'Production IPC handlers must be loaded');
  vm.runInNewContext(main.slice(start, end), {
    getSupabaseAdmin: () => client, registerDatabaseHandler: (name, handler) => { handlers[name] = handler; }, Date, Set, console,
  });
  db.invoke = async (name, payload) => {
    if (name === 'notifications-fetch-all') return db.fetchHook ? db.fetchHook() : { success: true, data: clone(db.records) };
    if (name === 'maintenance-fetch-reports') return { success: true, data: clone(db.reports) };
    if (name === 'notification-create') {
      const result = await client.from('notifications').insert(payload).select().single();
      return result.error ? { success: false, code: result.error.code, error: result.error.message } : { success: true, data: result.data };
    }
    if (!handlers[name]) throw Error('Unexpected IPC: ' + name);
    return handlers[name]({}, payload);
  };
  return db;
}
function page(db, { browser = false, local = storage() } = {}) {
  const listeners = new Map(), alerts = [], toasts = [], audit = new Map();
  const badge = { style: { display: 'none' }, textContent: '', classList: { add() {}, remove() {} } };
  const context = {
    console: { warn() {}, error() {}, log() {} }, Date, Map, Set, Math, localStorage: local, sessionStorage: storage(),
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    document: { readyState: 'loading', addEventListener() {}, querySelectorAll: () => [], querySelector: () => null,
      getElementById: id => /notificationBadge|headerNotificationBadge|analyticsAlertsBadge/.test(id) ? badge : null },
    addEventListener(type, listener) { const entries = listeners.get(type) || []; entries.push(listener); listeners.set(type, entries); },
    dispatchEvent(event) { for (const listener of listeners.get(event.type) || []) listener(event); },
    supabaseClient: browser ? db.client : null, EcoDataBus: { invalidate() {} },
    saveViolationToAuditHistory(record) { audit.set(String(record.id || record.pbId), clone(record)); },
    getStoredViolationAuditHistory: () => [...audit.values()],
  };
  context.window = context;
  if (!browser) context.electron = { invoke: db.invoke };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/global-notifications.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/notifications.js'), 'utf8'), context);
  context.__toasts = toasts; context.__alerts = alerts;
  vm.runInContext(`
    rooms = {'room-one': {id:'room-one',name:'Room 1',nodes:[]}, 'room-two': {id:'room-two',name:'Room 2',nodes:[]}};
    updateMessagesTable = () => {};
    updateInstallationAvailability = () => {};
    showNotification = message => __toasts.push(message);
    triggerGlobalNotification = (content, record) => __alerts.push({content,record});
    extractTargetNodes = () => ({specificNodeId:null,nodeNames:[]});
    notificationRoomId = room => room;
  `, context);
  return {
    context, badge, toasts, alerts, local, audit,
    run: code => vm.runInContext(code, context),
    messages: () => clone(vm.runInContext('messages', context)),
    load: () => context.loadNotificationMessages(),
    delete: id => { context.__target = id; return vm.runInContext('pendingDeleteMessageId=__target;confirmDeleteMessage()', context); },
    clear: room => { context.__room = room; return vm.runInContext('selectedRoomId=__room;clearAllMessages()', context); },
  };
}
const notification = (id, extra = {}) => ({ id, room_id: 'room-one', content: 'Verification Required: Controller 1', type: 'maintenance_verification',
  triggered: true, created: '2026-10-18T00:00:00Z', ...extra });

test('deleting a verification alert persists across reload/navigation and producer polling, while a genuine new submission still arrives', async () => {
  for (const browser of [false, true]) {
    const db = database();
    db.reports = [{ id: 'report-one', room_id: 'room-one', status: 'Pending Verification', staff_name: 'Technician',
      timeline: [{ title: 'Submitted for admin verification', at: '2026-10-18T00:00:00Z' }] }];
    const first = page(db, { browser });
    await first.context.checkMaintenanceVerificationSubmissions(); await first.load();
    const id = first.messages()[0].id, eventKey = db.records[0].event_key;
    assert.equal(await first.delete(id), true); assert.deepEqual(first.messages(), []);
    assert.equal(db.records.length, 1); assert.equal(db.records[0].is_dismissed_from_inbox, true);
    assert.equal(db.records[0].event_key, eventKey); assert.equal(db.reports[0].status, 'Pending Verification');
    const reopened = page(db, { browser, local: first.local });
    await reopened.context.checkMaintenanceVerificationSubmissions(); await reopened.load(); await reopened.context.syncNotificationBadges();
    assert.equal(db.records.length, 1); assert.deepEqual(reopened.messages(), []); assert.equal(reopened.alerts.length, 0);
    assert.equal(reopened.badge.style.display, 'none');
    db.reports[0].timeline = [{ title: 'Submitted for admin verification', at: '2026-10-18T01:00:00Z' }];
    await reopened.context.checkMaintenanceVerificationSubmissions(); await reopened.load();
    assert.equal(db.records.length, 2); assert.equal(reopened.messages().length, 1); assert.equal(reopened.alerts.length, 1);
    assert.notEqual(db.records[1].event_key, eventKey);
    assert.equal(db.writes.filter(write => write.mode === 'delete').length, 0);
  }
});

test('Clear All dismisses only the selected room and preserves rule audit, event keys, and other rooms', async () => {
  for (const browser of [false, true]) {
    const db = database([notification('verification', { event_key: 'verification:one' }),
      notification('rule', { type: 'rule_violation', rule_id: 'rule-one', content: 'Temperature threshold exceeded' }),
      notification('schedule', { type: 'schedule', content: 'Controller wake schedule applied' }),
      notification('other-room', { room_id: 'room-two', event_key: 'verification:two' })]);
    const first = page(db, { browser }); await first.load();
    assert.equal(await first.clear('room-one'), true);
    assert.deepEqual(first.messages().map(row => row.id), ['other-room']);
    assert.equal(db.records.length, 4); assert.equal(db.records[0].event_key, 'verification:one');
    assert.equal(db.records.filter(row => row.is_dismissed_from_inbox).length, 3);
    assert.equal(first.audit.get('rule').is_dismissed_from_inbox, true);
    const second = page(db, { browser, local: first.local }); await second.load(); await second.context.syncNotificationBadges();
    assert.deepEqual(second.messages().map(row => row.id), ['other-room']);
    assert.equal(second.badge.textContent, 1); assert.equal(db.writes.filter(write => write.mode === 'delete').length, 0);
  }
});

test('server errors, zero rows, foreign rows, wrong flags and partial receipts never produce delete or Clear All success', async () => {
  for (const browser of [false, true]) {
    for (const response of [{ data: null, error: { message: 'Write denied' } }, { data: [], error: null },
      { data: [{ id: 'foreign', is_dismissed_from_inbox: true }], error: null },
      { data: [{ id: 'one', is_dismissed_from_inbox: false }], error: null }]) {
      const db = database([notification('one')]); db.mutationHook = async () => response;
      const view = page(db, { browser }); await view.load();
      assert.equal(await view.delete('one'), false); assert.equal(view.messages().length, 1);
      assert.ok(view.toasts.at(-1).startsWith('Could not remove notification:'));
    }
    const db = database([notification('one'), notification('two')]);
    db.mutationHook = async () => ({ data: [{ id: 'one', is_dismissed_from_inbox: true }], error: null });
    const view = page(db, { browser }); await view.load();
    assert.equal(await view.clear('room-one'), false); assert.equal(view.messages().length, 2);
    assert.ok(view.toasts.at(-1).startsWith('Could not clear notifications:'));
  }
});

test('duplicate delete/Clear All taps share one mutation lock and stale page loads cannot resurrect a dismissed alert', async () => {
  const db = database([notification('one')]), view = page(db); await view.load();
  const old = deferred(), stale = clone(db.records);
  db.fetchHook = () => old.promise;
  const pendingRead = view.load();
  await Promise.resolve();
  db.fetchHook = null;
  const gate = deferred(); db.mutationHook = () => gate.promise;
  const pendingDelete = view.delete('one');
  await Promise.resolve(); await view.delete('one'); await view.clear('room-one');
  db.records[0].is_dismissed_from_inbox = true;
  gate.resolve({ data: clone(db.records), error: null });
  assert.equal(await pendingDelete, true);
  old.resolve({ success: true, data: stale }); await pendingRead;
  assert.deepEqual(view.messages(), []); assert.equal(db.writes.length, 1);
  assert.equal(view.run('notificationInboxMutationPending'), false);
});

test('stale badge fetches cannot restore the count after a dismissal or after a newer badge fetch', async () => {
  const db = database([notification('one')]), view = page(db); await view.load();
  const old = deferred(), stale = clone(db.records); db.fetchHook = () => old.promise;
  const pendingBadge = view.context.syncNotificationBadges(); await Promise.resolve(); db.fetchHook = null;
  await view.delete('one'); await view.context.syncNotificationBadges();
  assert.equal(view.badge.style.display, 'none');
  old.resolve({ success: true, data: stale }); await pendingBadge;
  assert.equal(view.badge.style.display, 'none');
  const late = deferred(); db.fetchHook = () => late.promise;
  const previous = view.context.syncNotificationBadges(); await Promise.resolve(); db.fetchHook = null;
  await view.context.syncNotificationBadges(); late.resolve({ success: true, data: stale }); await previous;
  assert.equal(view.badge.style.display, 'none');
});

test('selectRoom uses its actual guarded refresh promise, ignores a stale response, and clears rows on an authoritative empty read', async () => {
  const db = database([notification('one')]), view = page(db); await view.load();
  const old = deferred(), stale = clone(db.records); db.fetchHook = () => old.promise;
  const selecting = view.run("selectRoom('room-one')"); await Promise.resolve(); db.fetchHook = null;
  assert.equal(await view.delete('one'), true);
  old.resolve({ success: true, data: stale }); await selecting;
  assert.deepEqual(view.messages(), []);
  db.records.push(notification('two')); await view.load(); assert.equal(view.messages().length, 1);
  db.records = [];
  await view.run("selectRoom('room-two')");
  assert.deepEqual(view.messages(), []);
  assert.equal(view.run('selectedRoomId'), 'room-two');
});

test('explicit audit deletion keeps its delete contract but rejects zero and partial affected-ID receipts', async () => {
  const db = database([notification('one'), notification('two')]);
  assert.equal((await db.invoke('notifications-delete', ['missing'])).success, false);
  assert.equal((await db.invoke('notifications-delete', ['one', 'missing'])).success, false);
  assert.equal((await db.invoke('notifications-delete', ['two'])).success, true);
  assert.deepEqual(db.records, []);
});

test('retained audits absent from an authoritative inbox stay in history and cannot poison Clear All with missing IDs', async () => {
  for (const browser of [false, true]) {
    const db = database([notification('live')]), view = page(db, { browser });
    view.audit.set('deleted-remote', notification('deleted-remote', { type: 'rule_violation', rule_id: 'rule-one', content: 'Old threshold exceeded' }));
    view.audit.set('v_hist_local', notification('v_hist_local', { type: 'rule_violation', rule_id: 'rule-one', content: 'Local threshold history' }));
    await view.load();
    assert.deepEqual(view.messages().map(row => row.id), ['live']);
    assert.equal(view.audit.size, 2, 'Historical audit is retained independently of the live inbox');
    assert.equal(await view.clear('room-one'), true);
    assert.deepEqual(db.writes[0].filters, [['id', ['live']]]);
    assert.deepEqual(view.messages(), []);
    assert.equal(view.audit.size, 2);
  }
});

test('stale notification links never invent a database-backed row or restore a dismissed alert', async () => {
  for (const browser of [false, true]) {
    const db = database([notification('dismissed', { is_dismissed_from_inbox: true })]), view = page(db, { browser });
    await view.load();
    view.run("selectedRoomId='room-one';setNotificationFilter=()=>{};");
    for (const target of ['', 'missing', 'dismissed']) {
      view.context.__linkTarget = target;
      await view.run("focusAndOpenNotification(__linkTarget,{room:'room-one',message:'Verification Required: Controller 1',control:'Controller 1'})");
      assert.deepEqual(view.messages(), [], 'Stale links must not fabricate removable inbox records');
      assert.equal(db.writes.length, 0);
    }
    assert.match(view.toasts.at(-1), /no longer available/i);
    assert.equal(db.records[0].is_dismissed_from_inbox, true);
  }
});

test('a failed inbox read keeps the last confirmed rows, while a confirmed empty read removes them', async () => {
  for (const browser of [false, true]) {
    const db = database([notification('live')]), view = page(db, { browser });
    assert.equal(await view.load(), true);
    db.fetchHook = () => ({ success: false, error: 'Database temporarily unavailable' });
    db.readHook = () => ({ data: null, error: { message: 'Database temporarily unavailable' } });
    assert.equal(await view.load(), false);
    assert.deepEqual(view.messages().map(row => row.id), ['live']);
    assert.equal(db.writes.length, 0);
    db.fetchHook = null; db.readHook = null; db.records = [];
    await view.load();
    assert.deepEqual(view.messages(), []);
  }
});

test('a link resolves its persisted ID after refresh and never opens another alert with the same text', async () => {
  for (const browser of [false, true]) {
    const db = database([notification('live')]), view = page(db, { browser });
    view.context.__opened = [];
    view.context.setTimeout = callback => { callback(); return 1; };
    view.run("selectedRoomId='room-one';setNotificationFilter=()=>{};markMessageAsRead=()=>{};openViewMessageModal=message=>__opened.push(message.id);");
    await view.run("focusAndOpenNotification('live',{room:'room-one',message:'Verification Required: Controller 1'})");
    assert.deepEqual([...view.context.__opened], ['live']);
    assert.deepEqual(view.messages().map(row => row.id), ['live']);
    await view.run("focusAndOpenNotification('missing',{room:'room-one',message:'Verification Required: Controller 1'})");
    assert.deepEqual([...view.context.__opened], ['live']);
    assert.deepEqual(view.messages().map(row => row.id), ['live']);
    assert.equal(db.writes.length, 0);
  }
});

test('an unavailable link refresh reports the read failure without inventing a missing alert', async () => {
  for (const browser of [false, true]) {
    const db = database(), view = page(db, { browser });
    db.fetchHook = () => ({ success: false, error: 'Offline' });
    db.readHook = () => ({ data: null, error: { message: 'Offline' } });
    await view.run("focusAndOpenNotification('unknown',{room:'room-one',message:'Verification Required'})");
    assert.deepEqual(view.messages(), []);
    assert.match(view.toasts.at(-1), /Could not refresh/);
    assert.equal(db.writes.length, 0);
  }
});

test('an already displayed local-only audit dismisses locally without a remote write or erasing its history', async () => {
  for (const browser of [false, true]) {
    const db = database(), view = page(db, { browser });
    const localAlert = notification('v_hist_local', { pbId: '', room: 'room-one', type: 'rule_violation', rule_id: 'rule-one', content: 'Threshold history' });
    view.audit.set(localAlert.id, clone(localAlert));
    view.context.__localAlert = localAlert;
    view.run('messages=[__localAlert]');
    assert.equal(await view.delete(localAlert.id), true);
    assert.deepEqual(view.messages(), []);
    assert.equal(db.writes.length, 0);
    assert.equal(view.audit.size, 1);
    assert.equal(view.audit.get(localAlert.id).is_dismissed_from_inbox, true);
    assert.equal(view.audit.get(localAlert.id).content, 'Threshold history');
  }
});
