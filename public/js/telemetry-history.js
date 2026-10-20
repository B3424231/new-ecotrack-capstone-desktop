(function (root) {
  'use strict';
  function createReader() {
    let rows = new Map(), cursor = null, backend = null, pending = null;
    async function read(url, fetcher) {
      if (url !== backend) { rows = new Map(); cursor = null; backend = url; }
      const query = new URLSearchParams({ perPage: '0', sort: '-created', history: '1' });
      if (cursor) query.set('cursor', cursor);
      const response = await fetcher(`${url}/api/telemetry?${query}`);
      if (!response.ok) throw new Error(`Telemetry request failed (HTTP ${response.status})`);
      const data = await response.json();
      if (!Array.isArray(data.items)) throw new Error('Telemetry response must contain an items array');
      const next = data.history_full === false ? new Map(rows) : new Map();
      for (const row of data.items) {
        if (!row || typeof row.id !== 'string' || !row.id) throw new Error('Telemetry row is missing its identity');
        next.set(row.id, row);
      }
      if (Number.isInteger(data.history_total) && next.size !== data.history_total) {
        cursor = null;
        throw new Error('Telemetry history changed while loading. Retry to refresh the complete snapshot.');
      }
      rows = next; cursor = data.history_cursor || null;
      return { ...data, items: [...rows.values()].sort((a, b) => String(b.created).localeCompare(String(a.created)) || b.id.localeCompare(a.id)) };
    }
    return (url, fetcher) => {
      if (!pending) pending = read(url, fetcher).finally(() => { pending = null; });
      return pending;
    };
  }
  root.EcoTrackTelemetryHistory = { createReader, read: createReader() };
})(typeof window !== 'undefined' ? window : globalThis);
