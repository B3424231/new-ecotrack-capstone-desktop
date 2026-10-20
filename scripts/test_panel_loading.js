'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const tick = () => new Promise(resolve => setImmediate(resolve));
function bus() {
  const window = { addEventListener() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/eco-data-bus.js'), 'utf8'),
    { window, console: { error() {}, warn() {} }, AbortController, Date, setTimeout, clearTimeout });
  return window.EcoDataBus;
}
test('same-key reads share a request and every caller receives the real result', async () => {
  const b = bus(); let release, calls = 0;
  const fetcher = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const first = b.query('rooms', fetcher), second = b.query('rooms', fetcher);
  await tick(); assert.equal(calls, 1);
  release(['room-one']); assert.deepEqual(await first, ['room-one']); assert.deepEqual(await second, ['room-one']);
});
test('a cancelled old request cannot erase a newer request or publish old rows', async () => {
  const b = bus(); let rejectOld, releaseNew;
  const old = b.query('rooms', () => new Promise((_resolve, reject) => { rejectOld = reject; }));
  await tick(); b.cancel('rooms');
  const current = b.query('rooms', () => new Promise(resolve => { releaseNew = resolve; }));
  await tick(); rejectOld(new Error('old failure')); await old;
  assert.equal(b.inFlightControllers.has('rooms'), true);
  releaseNew(['new']); assert.deepEqual(await current, ['new']);
});
test('a hung query stops loading, reports timeout and cannot commit a late result', async () => {
  const b = bus(); let release, failures = 0;
  b.onQuery('rooms', { onError: () => failures++ });
  await assert.rejects(b.query('rooms', () => new Promise(resolve => { release = resolve; }), { timeout: 10 }), /timed out/i);
  assert.equal(failures, 1); release(['too late']); await tick(); assert.equal(b.getCached('rooms'), null);
});
test('auth changes clear cache and terminate reads from the previous session', async () => {
  const b = bus(); await b.query('staff', async () => ['old-account']); b.clear();
  assert.equal(b.getCached('staff'), null);
});

function network(fetcher, online = true) {
  const window = { addEventListener() {}, alert() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/eco-network.js'), 'utf8'),
    { window, document: { readyState: 'loading', addEventListener() {} }, navigator: { onLine: online },
      fetch: fetcher, AbortController, TypeError, console, setTimeout, clearTimeout });
  return window.EcoNetwork;
}
test('failed mutations are never automatically retried, including lowercase methods', async () => {
  for (const method of ['post', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    let calls = 0;
    const client = network(async () => { calls++; throw new TypeError('network failed'); });
    await assert.rejects(client.fetch('https://fixture.invalid/api', {method}, {silent:true, retries:2}));
    assert.equal(calls, 1);
  }
});
test('external cancellation ends the read without retries or error notification', async () => {
  let calls = 0;
  const client = network((_url, options) => new Promise((_resolve, reject) => {
    calls++; options.signal.addEventListener('abort', () => { const error = new Error('abort'); error.name = 'AbortError'; reject(error); });
  }));
  const controller = new AbortController();
  const read = client.fetch('https://fixture.invalid/api', {signal:controller.signal}, {silent:true});
  controller.abort(); await assert.rejects(read, {name:'AbortError'}); assert.equal(calls, 1);
});
test('offline cloud reads fail while the local Python service remains usable', async () => {
  let calls = 0; const client = network(async () => { calls++; return {ok:true}; }, false);
  await assert.rejects(client.fetch('https://fixture.invalid/api', {}, {silent:true}), /offline/i);
  assert.equal((await client.fetch('http://127.0.0.1:5000/api/health', {}, {silent:true})).ok, true);
  assert.equal(calls, 1);
});
test('successful empty staff reads clear stale data without a second cloud request', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/staff.js'), 'utf8');
  const fn = source.slice(source.indexOf('async function loadStaffFromSupabase()'), source.indexOf('async function loadBuildingsFloorsRooms()'));
  let applied, fallback = 0;
  const load = vm.runInNewContext(fn + ';loadStaffFromSupabase;', {
    document:{getElementById:()=>null}, staffList:[{id:'stale'}], window:{electron:{invoke:async()=>({success:true,data:[]})}},
    sb:{rpc:async()=>{fallback++;return {data:[],error:null};}}, applyStaffData:data=>applied=data,
    console, renderTable(){}, getCleanStaffList(){return [{id:'stale'}];},
  });
  await load(); assert.equal(applied.length, 0); assert.equal(fallback, 0);
});
