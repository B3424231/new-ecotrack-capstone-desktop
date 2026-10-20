'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
require('../public/js/telemetry-history.js');
test('incremental reader retains past periods, replaces full snapshots, and shares overlapping reads', async () => {
  const reader = global.EcoTrackTelemetryHistory.createReader();
  let payload = { items: [{ id: 'old', created: '2022-01-01' }], history_cursor: 'first', history_total: 1, history_full: true };
  const urls = [];
  const fetcher = async url => { urls.push(url); return { ok: true, json: async () => payload }; };
  const [a, b] = await Promise.all([reader('http://local', fetcher), reader('http://local', fetcher)]);
  assert.equal(urls.length, 1); assert.equal(a, b);
  payload = { items: [{ id: 'new', created: '2026-10-13' }], history_cursor: 'second', history_total: 2, history_full: false };
  const delta = await reader('http://local', fetcher);
  assert.deepEqual(delta.items.map(r => r.id), ['new', 'old']); assert.match(urls[1], /cursor=first/);
  payload = { items: [], history_cursor: 'clear', history_total: 0, history_full: true };
  assert.deepEqual((await reader('http://local', fetcher)).items, []);
});
test('failed reads do not replace valid history; inconsistent deltas force a complete retry', async () => {
  const reader = global.EcoTrackTelemetryHistory.createReader();
  const response = data => async () => ({ ok: true, json: async () => data });
  await reader('http://local', response({ items: [{ id: 'a', created: '2026-01-01' }], history_cursor: 'x', history_total: 1 }));
  await assert.rejects(reader('http://local', async () => { throw Error('offline'); }), /offline/);
  await assert.rejects(reader('http://local', response({ items: [], history_total: 0, history_full: false })), /Retry/);
  await reader('http://local', async url => { assert.doesNotMatch(url, /cursor/); return { ok: true, json: async () => ({ items: [], history_total: 0 }) }; });
});
