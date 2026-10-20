const { contextBridge, ipcRenderer } = require('electron');

function publicKey(value) {
  if (value?.startsWith('sb_publishable_')) return value;
  try { if (JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString()).role === 'anon') return value; } catch {}
  return 'sb_publishable_HNxLHBeGMPsdoEvVtUusWw_CJ-qlHQ-';
}
const env = {
  SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://ynopdmfhngooknybyahq.supabase.co',
  SUPABASE_KEY: publicKey(process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY),
  SUPABASE_ANON_KEY: publicKey(process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY),
  BACKEND_URL: process.env.BACKEND_URL || 'http://localhost:5000'
};

const invokeChannels = new Set(["focus-window", "scan-wifi", "scan-ble", "ping-node", "bluetooth-select-response", "bluetooth-pairing-response", "auth-set-session", "auth-lookup-user", "auth-admin-fallback-login", "auth-register-admin", "staff-restore", "staff-archive", "staff-create", "staff-update", "staff-edit", "staff-fetch-all", "locations-fetch-all", "maintenance-delete-reports", "maintenance-save-report", "maintenance-fetch-reports", "scheduler-fetch-data", "node-update-schedule", "notifications-fetch-today", "notification-create", "notifications-fetch-all", "notifications-update", "notifications-delete", "rules-fetch-data", "rule-save", "rule-delete", "rule-toggle"]);
invokeChannels.add('monitoring-admin-request');
invokeChannels.add('monitoring-fetch-assets');
invokeChannels.add('monitoring-sync-registry');
invokeChannels.add('sensor-create-asset');
contextBridge.exposeInMainWorld('electron', {
  invoke: (channel, data) => invokeChannels.has(channel) ? ipcRenderer.invoke(channel, data) : Promise.reject(new Error('Unsupported IPC channel')),
  send: (channel, data) => { if (channel === 'focus-window') ipcRenderer.send(channel, data); },
  on: (channel, listener) => {
    if (!['ble-devices-discovered', 'bluetooth-select-request', 'bluetooth-pairing-request'].includes(channel) || typeof listener !== 'function') return;
    const wrapped = (_event, ...args) => listener(undefined, ...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  env
});

