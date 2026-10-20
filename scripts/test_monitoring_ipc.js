'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { requestMonitoring } = require('../src/monitoring-local');
const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

async function main() {
  const handlers = new Map(), sender = { getURL: () => pathToFileURL(path.join(__dirname, '../public/telemetry.html')).href };
  const frame = { url: sender.getURL() }; sender.mainFrame = frame;
  const event = { sender, senderFrame: frame };
  let signedIn = true, validUser = true, isAdmin = true, calls = 0;
  const client = { auth: { getSession: async () => ({ data: { session: signedIn ? { user: { id: 'fixture-user' } } : null } }),
    getUser: async () => ({ data: { user: validUser ? { id: 'fixture-user' } : null } }) },
    rpc: async () => ({ data: isAdmin, error: null }) };
  const context = vm.createContext({ require, path, __dirname: path.join(__dirname, '../src'), mainWindow: { webContents: sender },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, getSupabaseAdmin: () => client,
    databaseSessionSync: Promise.resolve(), console });
  vm.runInContext(section('function isTrustedDatabaseCaller(', 'let databaseSessionSync'), context);
  vm.runInContext(section('function registerDatabaseHandler(', '// Identifier lookup'), context);
  context.registerDatabaseHandler('fixture-monitor-admin', async () => { calls++; return { success: true }; });
  const handle = handlers.get('fixture-monitor-admin');
  assert.equal((await handle({ sender: {} }, {})).success, false);
  assert.equal((await handle({ ...event, senderFrame: { url: frame.url } }, {})).success, false);
  signedIn = false; assert.equal((await handle(event, {})).success, false);
  signedIn = true; validUser = false; assert.equal((await handle(event, {})).success, false);
  validUser = true; isAdmin = false; assert.equal((await handle(event, {})).success, false);
  isAdmin = true; assert.equal((await handle(event, {})).success, true);
  assert.equal(calls, 1);
  console.log('PASS actual administrator IPC guard rejects untrusted frames, missing/unverified sessions and non-admin users');

  let assetWrites = 0, duplicate = false;
  client.from = table => { assert.equal(table, 'aircons'); return { insert(payload) { assetWrites++; assert.equal(payload.protocol, null); assert.equal(payload.node_id, null); assert.equal(payload.cooling_capacity_hp, null); return { select: () => ({ single: async () => duplicate ? ({ error: { code: '23505' } }) : ({ data: { id: 'fixture-ac-id', ...payload } }) }) }; } }; };
  context.require = require('node:module').createRequire(path.join(__dirname, '../src/main.js'));
  vm.runInContext(section("registerDatabaseHandler('sensor-create-asset'", "ipcMain.handle('auth-lookup-user'"), context);
  const saveAsset = handlers.get('sensor-create-asset');
  const assetInput = { asset_tag: 'FIXTURE', name: 'Fixture AC', brand: 'Fixture', model: 'Fixture', aircon_type: 'Window', desired_state: { power: true }, node_id: 'untrusted-controller' };
  signedIn = false; assert.equal((await saveAsset(event, assetInput)).success, false);
  signedIn = true; isAdmin = false; assert.equal((await saveAsset(event, assetInput)).success, false); assert.equal(assetWrites, 0);
  isAdmin = true; assert.equal((await saveAsset(event, assetInput)).success, true); assert.equal(assetWrites, 1);
  assert.equal((await saveAsset(event, { ...assetInput, name: '' })).success, false); assert.equal(assetWrites, 1);
  duplicate = true; assert.match((await saveAsset(event, assetInput)).error, /already exists/);
  console.log('PASS controller-free asset creation uses the actual administrator guard, insert-only registry writes and explicit null IR/controller fields');

  const nodeId = '11111111-1111-4111-8111-111111111111';
  const token = 'isolated-transport-credential-'.repeat(2);
  const requests = [];
  const options = { backendUrl: 'http://localhost:5000', adminToken: token,
    lookupAircon: async id => id === 'real-fixture-ac' ? { id, name: 'Verified fixture AC' } : null,
    fetcher: async (url, init) => { requests.push({ url: url.toString(), init }); return { ok: true, json: async () => ({ id: nodeId }) }; } };
  await requestMonitoring({ action: 'create', data: { aircon_id: 'real-fixture-ac', aircon_name: 'Unverified label' } }, options);
  assert.equal(JSON.parse(requests[0].init.body).aircon_name, 'Verified fixture AC');
  assert.equal(requests[0].url, 'http://localhost:5000/api/monitoring/devices');
  assert(requests[0].init.headers.Authorization.endsWith(token));
  await requestMonitoring({ action: 'calibrate', id: nodeId, data: {} }, options);
  assert(requests[1].url.endsWith('/' + nodeId + '/calibrations'));
  await assert.rejects(requestMonitoring({ action: 'create', data: { aircon_id: 'unknown' } }, options), /registered AC/);
  await assert.rejects(requestMonitoring({ action: 'delete', id: nodeId }, options), /Unsupported/);
  await assert.rejects(requestMonitoring({ action: 'rotate', id: '../arbitrary-path' }, options), /valid monitoring device/);
  for (const backendUrl of ['https://outside.invalid', 'http://localhost:5000/other', 'http://user:password@localhost:5000']) {
    await assert.rejects(requestMonitoring({ action: 'rotate', id: nodeId }, { ...options, backendUrl }), /local desktop backend/);
  }
  assert.equal(requests.length, 2);
  console.log('PASS monitoring transport verifies AC identity, restricts actions/IDs and keeps the administrator credential on loopback');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
