'use strict';
// Called only after the existing authenticated administrator IPC guard succeeds.
const fs = require('node:fs');

async function requestMonitoring(input, options) {
  const base = new URL(options.backendUrl || 'http://localhost:5000');
  if (!['http:', 'https:'].includes(base.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
      || base.username || base.password || !['', '/'].includes(base.pathname)) {
    throw new Error('Monitoring administration requires the local desktop backend.');
  }
  const routes = { create: ['POST', '/devices'], update: ['PATCH', '/devices/'],
    calibrate: ['POST', '/devices/'], rotate: ['POST', '/devices/'], active: ['PATCH', '/devices/'], schedule: ['PUT', '/devices/'], import: ['POST', '/registry/import'], reconcile: ['POST', '/registry/reconcile'] };
  if (!input || !Object.hasOwn(routes, input.action)) throw new Error('Unsupported monitoring action.');
  if (['import', 'reconcile'].includes(input.action) && options.trustedImport !== true) throw new Error('Registry imports require verified cloud metadata.');
  const [method, route] = routes[input.action];
  if (!['create', 'reconcile'].includes(input.action) && !/^[a-f0-9-]{36}$/i.test(input.id || '')) throw new Error('A valid monitoring device ID is required.');
  let body = input.data || {};
  if (['create', 'update', 'import'].includes(input.action)) {
    const asset = await options.lookupAircon(body.aircon_id);
    if (!asset?.id || asset.id !== body.aircon_id) throw new Error('Select an existing registered AC asset.');
    body = { ...body, aircon_name: asset.name || asset.asset_tag || asset.id, aircon_type: asset.aircon_type || null };
  }
  if (input.action === 'active') {
    if (typeof body.active !== 'boolean') throw new Error('An explicit active state is required.');
    body = { active: body.active };
  }
  const token = options.adminToken || fs.readFileSync(options.keyPath, 'utf8').trim();
  if (token.length < 32) throw new Error('Restart the local backend to initialize monitoring.');
  let endpoint = route + (['create','import','reconcile'].includes(input.action) ? '' : encodeURIComponent(input.id));
  if (input.action === 'import') body = { id: input.id, device: body };
  if (input.action === 'calibrate') endpoint += '/calibrations';
  if (input.action === 'rotate') endpoint += '/rotate-token';
  if (input.action === 'schedule') endpoint += '/schedule';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await (options.fetcher || fetch)(new URL('/api/monitoring' + endpoint, base), {
      method, signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Local monitoring request failed.');
    return { success: true, data };
  } finally { clearTimeout(timeout); }
}

module.exports = { requestMonitoring };
