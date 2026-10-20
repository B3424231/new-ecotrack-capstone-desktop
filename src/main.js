const fs = require('fs');
const { readProvisioningError } = require('../public/js/provisioning-errors.js');
const path = require('path');
const { execFile } = require('child_process');
try {
  require('dotenv').config({ path: path.join(__dirname, '../.env') });
} catch (_) {}
const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const isDev = require('electron-is-dev');

// Acquire the profile lock before Chromium creates its shared disk/GPU caches.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.exit(0);
} else {
  app.on('second-instance', () => focusMainWindow());
}

// Suppress and handle SSL handshake resets (net_error -101) and clock skew
app.commandLine.appendSwitch('log-level', '3');
app.commandLine.appendSwitch('allow-insecure-localhost', 'true');
app.commandLine.appendSwitch('enable-web-bluetooth');
app.commandLine.appendSwitch('enable-experimental-web-platform-features');

let mainWindow = null;

function focusMainWindow() {
  if (!hasSingleInstanceLock || !app.isReady()) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  // Bring to foreground on Windows and bypass OS foreground locking
  mainWindow.setAlwaysOnTop(true);
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(false);
  if (typeof app.focus === 'function') {
    app.focus({ steal: true });
  }
  if (process.platform === 'win32') {
    mainWindow.flashFrame(false);
  }
}

// IPC handlers for notification clicks to restore, focus, and navigate
ipcMain.on('focus-window', (event, data) => {
  focusMainWindow();
});

ipcMain.handle('focus-window', async (event, data) => {
  focusMainWindow();
  return { success: true };
});

// ==========================================
// Wi-Fi Scanner IPC — Hardware Scan + Rolling Cache
// ==========================================
const wifiNetworkMemoryCache = new Map();

ipcMain.handle('scan-wifi', async () => {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      return resolve({ success: false, networks: [], error: 'Wi-Fi scanning is only supported on Windows.' });
    }

    // Trigger hardware WLAN scan via wlanapi.dll
    const scriptPath = path.join(__dirname, '../scripts/wlan_scan.ps1');
    execFile('powershell', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath], { timeout: 3000 }, () => {
      // Allow probe frames to settle
      setTimeout(() => {
        execFile('netsh', ['wlan', 'show', 'networks', 'mode=bssid'], { timeout: 10000 }, (err1, bssidStdout) => {
          execFile('netsh', ['wlan', 'show', 'networks'], { timeout: 10000 }, (err2, plainStdout) => {
            try {
              // 1. Parse mode=bssid
              if (bssidStdout) {
                const blocks = bssidStdout.split(/^\s*SSID \d+\s*:/m);
                blocks.shift();

                for (const block of blocks) {
                  const lines = block.split('\n').map(l => l.trim());
                  const ssid = lines[0] ? lines[0].trim() : '';
                  if (!ssid) continue;

                  const authLine = lines.find(l => l.toLowerCase().startsWith('authentication') || l.toLowerCase().startsWith('autenticaci'));
                  const authStr = authLine ? authLine.split(':').slice(1).join(':').trim() : 'WPA2-Personal';

                  const bssidBlocks = block.split(/^\s*BSSID \d+\s*:/m);
                  bssidBlocks.shift();

                  let bestQuality = -1;
                  let bestChannel = 6;
                  if (bssidBlocks.length > 0) {
                    for (const bBlock of bssidBlocks) {
                      const bLines = bBlock.split('\n').map(l => l.trim());
                      const getBVal = (lbl) => {
                        const l = bLines.find(x => x.toLowerCase().startsWith(lbl.toLowerCase()));
                        return l ? l.split(':').slice(1).join(':').trim() : '';
                      };
                      const sig = parseInt((getBVal('Signal') || getBVal('Señal') || '0%').replace('%', ''), 10) || 0;
                      const ch = parseInt(getBVal('Channel') || getBVal('Canal') || '0', 10) || 0;
                      if (ch <= 14 && sig > bestQuality) {
                        bestQuality = sig;
                        bestChannel = ch || 6;
                      }
                    }
                  } else {
                    const sig = parseInt((lines.find(l => l.toLowerCase().startsWith('signal'))?.split(':')?.[1] || '0').replace('%', ''), 10) || 0;
                    const ch = parseInt((lines.find(l => l.toLowerCase().startsWith('channel'))?.split(':')?.[1] || '0').trim(), 10) || 0;
                    if (ch <= 14) {
                      bestQuality = sig;
                      bestChannel = ch || 6;
                    }
                  }

                  if (bestQuality >= 0) {
                    wifiNetworkMemoryCache.set(ssid, {
                      ssid,
                      rssi: Math.round(-100 + bestQuality * 0.65),
                      quality: bestQuality,
                      channel: bestChannel,
                      security: authStr || 'WPA2-Personal',
                      is24Ghz: true,
                      lastSeen: Date.now()
                    });
                  }
                }
              }

              // 2. Parse plain show networks for any missing SSIDs visible in OS tray
              if (plainStdout) {
                const blocks = plainStdout.split(/^\s*SSID \d+\s*:/m);
                blocks.shift();

                for (const block of blocks) {
                  const lines = block.split('\n').map(l => l.trim());
                  const ssid = lines[0] ? lines[0].trim() : '';
                  if (!ssid) continue;

                  const authLine = lines.find(l => l.toLowerCase().startsWith('authentication') || l.toLowerCase().startsWith('autenticaci'));
                  const authStr = authLine ? authLine.split(':').slice(1).join(':').trim() : 'WPA2-Personal';

                  if (!wifiNetworkMemoryCache.has(ssid)) {
                    wifiNetworkMemoryCache.set(ssid, {
                      ssid,
                      rssi: -74,
                      quality: 40,
                      channel: 6,
                      security: authStr || 'WPA2-Personal',
                      is24Ghz: true,
                      lastSeen: Date.now()
                    });
                  }
                }
              }

              // 3. Fallback: Always ensure currently connected interface is present
              execFile('netsh', ['wlan', 'show', 'interfaces'], { timeout: 4000 }, (err3, ifaceStdout) => {
                if (ifaceStdout) {
                  const lines = ifaceStdout.split('\n').map(l => l.trim());
                  const ssidLine = lines.find(l => l.startsWith('SSID') && !l.startsWith('BSSID'));
                  const sigLine = lines.find(l => l.startsWith('Signal'));
                  const chLine = lines.find(l => l.startsWith('Channel'));
                  if (ssidLine) {
                    const ssid = ssidLine.split(':').slice(1).join(':').trim();
                    const sig = parseInt((sigLine?.split(':')?.[1] || '100').replace('%', ''), 10) || 100;
                    const ch = parseInt((chLine?.split(':')?.[1] || '6').trim(), 10) || 6;
                    if (ssid) {
                      wifiNetworkMemoryCache.set(ssid, {
                        ssid,
                        rssi: Math.round(-100 + sig * 0.65),
                        quality: sig,
                        channel: ch,
                        security: 'WPA2-Personal',
                        is24Ghz: true,
                        lastSeen: Date.now()
                      });
                    }
                  }
                }
                finish();
              });

              function finish() {
                // Prune stale cache entries older than 10 mins
                const now = Date.now();
                for (const [key, val] of wifiNetworkMemoryCache.entries()) {
                  if (now - val.lastSeen > 600000) {
                    wifiNetworkMemoryCache.delete(key);
                  }
                }

                const networks = Array.from(wifiNetworkMemoryCache.values());
                networks.sort((a, b) => b.quality - a.quality);
                if (networks.length > 0) networks[0].isRecommended = true;

                resolve({ success: true, networks });
              }
            } catch (parseErr) {
              resolve({ success: false, networks: [], error: parseErr.message });
            }
          });
        });
      }, 500);
    });
  });
});

// ==========================================
// BLE Scanner IPC — Hardware Scan + Discovery
// ==========================================
const bluetoothSelections = new Map();
const bluetoothPairings = new Map();
for (const [channel, pending] of [['bluetooth-select-response', bluetoothSelections], ['bluetooth-pairing-response', bluetoothPairings]]) {
  ipcMain.handle(channel, async (event, data) => {
    if (!isTrustedDatabaseCaller(event)) return { success: false, error: 'Untrusted caller' };
    const request = pending.get(data?.request_id);
    if (!request || request.sender !== event.sender) return { success: false, error: 'Bluetooth request expired' };
    if (channel === 'bluetooth-select-response' && data.device_id && !request.devices.some(device => device.deviceId === data.device_id)) return { success: false, error: 'Unknown Bluetooth device' };
    if (channel === 'bluetooth-pairing-response' && data.confirmed && request.kind === 'providePin' && !/^\d{6}$/.test(data.pin || '')) return { success: false, error: 'Enter the six-digit pairing code' };
    clearTimeout(request.timer); pending.delete(data.request_id);
    request.callback(channel === 'bluetooth-select-response' ? data.device_id || '' : { confirmed: data.confirmed === true, ...(data.pin ? { pin: data.pin } : {}) });
    return { success: true };
  });
}

ipcMain.handle('scan-ble', async () => {
  return new Promise((resolve) => {
    try {
      const scannerExe = path.join(__dirname, '../scripts/ble_scanner.exe');
      if (process.platform === 'win32' && fs.existsSync(scannerExe)) {
        execFile(scannerExe, ['3'], { timeout: 6000 }, (err, stdout) => {
          if (!err && stdout && stdout.trim()) {
            try {
              const raw = JSON.parse(stdout.trim());
              const devices = raw.map(item => {
                const name = item.name || 'Unknown device';
                const mac = item.mac || '';
                const match = name.match(/node[-_]?([a-zA-Z0-9]+)/i);
                const nodeId = match ? `node-${match[1].toLowerCase()}` : (mac ? `node-${mac.slice(-5).replace(/:/g, '').toLowerCase()}` : 'node-1');
                return {
                  id: name,
                  nodeId: nodeId,
                  mac: mac,
                  rssi: item.rssi || -60,
                  status: 'Ready to pair',
                  isHardware: true
                };
              });

              devices.sort((a, b) => {
                const aPrio = /ecotrack/i.test(a.id) ? 0 : (/esp/i.test(a.id) ? 1 : (a.id !== 'Unknown device' ? 2 : 3));
                const bPrio = /ecotrack/i.test(b.id) ? 0 : (/esp/i.test(b.id) ? 1 : (b.id !== 'Unknown device' ? 2 : 3));
                return aPrio !== bPrio ? aPrio - bPrio : b.rssi - a.rssi;
              });

              return resolve({ success: true, devices });
            } catch (_) {}
          }
          resolve({ success: true, devices: [] });
        });
      } else {
        resolve({ success: true, devices: [] });
      }
    } catch (e) {
      resolve({ success: true, devices: [] });
    }
  });
});

// Node Diagnostics Real ICMP Ping IPC
ipcMain.handle('ping-node', async (event, ip) => {
  return new Promise((resolve) => {
    if (!ip || typeof ip !== 'string' || !/^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(ip.trim())) {
      return resolve({ success: false, error: 'Invalid IP address', reachable: false, stdout: 'Ping request could not find host. Please check the name and try again.' });
    }
    const cleanIp = ip.trim();
    const cmd = process.platform === 'win32' ? 'ping' : 'ping';
    const args = process.platform === 'win32' ? ['-n', '3', '-w', '1000', cleanIp] : ['-c', '3', '-W', '1', cleanIp];
    execFile(cmd, args, { timeout: 6000 }, (err, stdout) => {
      const output = stdout || '';
      const matchAvg = output.match(/Average\s*=\s*(\d+)ms/i);
      const matchMin = output.match(/Minimum\s*=\s*(\d+)ms/i);
      const matchMax = output.match(/Maximum\s*=\s*(\d+)ms/i);
      const matchLoss = output.match(/\((\d+)%\s*loss\)/i);
      const packetLoss = matchLoss ? parseInt(matchLoss[1], 10) : (err ? 100 : 0);
      const isReachable = packetLoss < 100 && (output.includes('TTL=') || output.includes('ttl='));
      
      resolve({
        success: true,
        reachable: isReachable,
        ip: cleanIp,
        stdout: output,
        avg: matchAvg ? matchAvg[1] : null,
        min: matchMin ? matchMin[1] : null,
        max: matchMax ? matchMax[1] : null,
        packetLoss: packetLoss
      });
    });
  });
});

// ==========================================
// Supabase Server-Side IPC Handlers (Protected Environment)
// Executes privileged operations safely in Node.js, never exposing secret keys to renderer
// ==========================================
// Ensure WebSocket is available in Electron's Node environment for Supabase
if (typeof globalThis.WebSocket === 'undefined') {
  try {
    globalThis.WebSocket = require('ws');
  } catch (_) {
    class NoopWebSocket {
      constructor() {}
      on() {}
      addEventListener() {}
      removeEventListener() {}
      send() {}
      close() {}
    }
    globalThis.WebSocket = NoopWebSocket;
  }
}

let supabaseAdminInstance = null;
function getSupabaseAdmin() {
  if (!supabaseAdminInstance) {
    try {
      const { createClient } = require('@supabase/supabase-js');
      const WebSocketImpl = globalThis.WebSocket;
      const sbUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://ynopdmfhngooknybyahq.supabase.co';
      const sbSecretKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
      if (sbUrl && isPublicSupabaseKey(sbSecretKey)) {
        supabaseAdminInstance = createClient(sbUrl, sbSecretKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          realtime: {
            transport: WebSocketImpl
          }
        });
      }
    } catch (err) {
      console.warn('[Main Process] Failed to initialize Supabase admin client:', err.message);
    }
  }
  return supabaseAdminInstance;
}

function isPublicSupabaseKey(key) {
  if (typeof key !== 'string') return false;
  if (key.startsWith('sb_publishable_')) return true;
  try { return JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role === 'anon'; }
  catch (_) { return false; }
}

function isTrustedDatabaseCaller(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) return false;
  try {
    const { fileURLToPath } = require('url');
    const page = fileURLToPath(event.senderFrame?.url || event.sender.getURL());
    return path.resolve(page).startsWith(path.resolve(__dirname, '../public') + path.sep) && path.extname(page) === '.html';
  } catch (_) { return false; }
}

let databaseSessionSync = Promise.resolve();
ipcMain.handle('auth-set-session', async (event, session) => {
  if (!isTrustedDatabaseCaller(event)) return { success: false, error: 'Untrusted caller' };
  const client = getSupabaseAdmin();
  if (!client) return { success: false, error: 'Public database configuration is unavailable' };
  const task = databaseSessionSync.catch(() => {}).then(async () => {
    if (!session) {
      try { await client.auth.signOut({ scope: 'local' }); } catch (_) {}
      return { success: true };
    }
    if (typeof session.access_token !== 'string' || typeof session.refresh_token !== 'string') return { success: false, error: 'Invalid session' };
    try {
      await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
      return { success: true };
    } catch (_) {
      return { success: true };
    }
  });
  databaseSessionSync = task;
  return task;
});

function registerDatabaseHandler(channel, handler) {
  ipcMain.handle(channel, async (event, data) => {
    if (!isTrustedDatabaseCaller(event)) return { success: false, error: 'Untrusted caller', code: '42501' };
    await databaseSessionSync.catch(() => {});
    const client = getSupabaseAdmin();
    if (!client) return { success: false, error: 'Public database configuration is unavailable' };
    const { data: sessionData } = await client.auth.getSession().catch(() => ({ data: { session: null } }));
    if (!sessionData?.session) return { success: false, error: 'Sign in to continue', code: '42501' };
    const { data: userData } = await client.auth.getUser().catch(() => ({ data: { user: null } }));
    if (!userData?.user || userData.user.id !== sessionData.session.user?.id) return { success: false, error: 'Sign in to continue', code: '42501' };
    let isAdmin = false;
    try {
      const { data, error } = await client.rpc('ecotrack_is_admin');
      isAdmin = !error && data === true;
    } catch (_) {}
    if (!isAdmin) return { success: false, error: 'Administrator required', code: '42501' };
    try {
      return await handler(event, data);
    } catch (err) {
      console.warn(`[Main Process] Error handling IPC '${channel}':`, err?.message || err);
      return { success: false, error: err?.message || 'Database operation failed', code: err?.code || '500' };
    }
  });
}

// Identifier lookup never exposes profile data before authentication.
registerDatabaseHandler('monitoring-admin-request', async (_event, input) => {
  const dbPath = path.resolve(process.env.ECOTRACK_SQLITE_DB_PATH || path.join(__dirname, '../backend/telemetry.db'));
  return require('./monitoring-local').requestMonitoring(input, {
    backendUrl: process.env.BACKEND_URL || 'http://localhost:5000',
    keyPath: path.join(path.dirname(dbPath), '.ecotrack-monitoring-admin.key'),
    adminToken: process.env.ECOTRACK_MONITOR_ADMIN_TOKEN,
    lookupAircon: async id => {
      const { data, error } = await getSupabaseAdmin().from('aircons').select('id,name,asset_tag,aircon_type').eq('id', id).maybeSingle();
      if (error) throw new Error('Unable to verify the selected AC asset.');
      return data;
    }
  });
});

registerDatabaseHandler('monitoring-fetch-assets', async () => {
  const { data, error } = await getSupabaseAdmin().from('aircons').select('id,name,asset_tag').order('name');
  if (error) return { success: false, error: error.message };
  return { success: true, data: data || [] };
});

registerDatabaseHandler('monitoring-sync-registry', async () => {
  const dbPath = path.resolve(process.env.ECOTRACK_SQLITE_DB_PATH || path.join(__dirname, '../backend/telemetry.db'));
  return require('./ac-device-monitor').syncRegisteredMonitors(getSupabaseAdmin(), {
    backendUrl:process.env.BACKEND_URL || 'http://localhost:5000',
    keyPath:path.join(path.dirname(dbPath),'.ecotrack-monitoring-admin.key'),adminToken:process.env.ECOTRACK_MONITOR_ADMIN_TOKEN
  });
});

registerDatabaseHandler('sensor-create-asset', async (_event, input) =>
  require('./sensor-assets').createSensorAsset(getSupabaseAdmin(), input));

ipcMain.handle('auth-lookup-user', async (event, identifier) => ({
  success: isTrustedDatabaseCaller(event),
  candidates: isTrustedDatabaseCaller(event) && String(identifier || '').includes('@') ? [String(identifier).trim().toLowerCase()] : []
}));

// Preserve the channel for older renderers, with a real Auth session instead of table passwords.
ipcMain.handle('auth-admin-fallback-login', async (event, input = {}) => {
  if (!isTrustedDatabaseCaller(event)) return { success: false, error: 'Untrusted caller' };
  const client = getSupabaseAdmin();
  if (!client || !input.username || !input.password) return { success: false };
  try {
    const { data, error } = await client.functions.invoke('account-login', { body: { identifier: input.username, password: input.password } });
    if (error || !data?.access_token || !data?.refresh_token) return { success: false, error: 'Name/phone sign-in is unavailable or credentials are invalid. Try your account email.' };
    const session = await client.auth.setSession(data);
    if (session.error || !session.data.session) return { success: false };
    return { success: true, user: session.data.user, session: session.data.session };
  } catch (_) { return { success: false }; }
});

registerDatabaseHandler('auth-register-admin', async (event, profile) => {
  const { data, error } = await getSupabaseAdmin().functions.invoke('provision-admin', { body: { profile } });
  return error ? { success: false, error: 'Administrator account could not be created' } : { success: true, ...data };
});

// Authenticated administrator staff management
registerDatabaseHandler('staff-restore', async (event, staffId) => {
  const sbAdmin = getSupabaseAdmin();
  if (!sbAdmin || !staffId) return { success: false, error: 'Database service unavailable' };
  try {
    const { data, error } = await sbAdmin.from('staff').update({
      status: 'Offline',
      is_archived: false,
      is_active: true,
      is_online: false,
      online_status: 'offline',
      archive_reason: null,
      archive_notes: null,
      archived_at: null,
      last_active: new Date().toISOString(),
      updated: new Date().toISOString()
    }).eq('id', staffId).select('id');
    if (error) {
      console.warn('[Main Process] staff-restore error:', error.message);
      return { success: false, error: error.message };
    }
    return { success: true, data };
  } catch (err) {
    console.warn('[Main Process] staff-restore exception:', err.message);
    return { success: false, error: err.message };
  }
});

registerDatabaseHandler('staff-archive', async (event, { id, reason, notes, archivedAt }) => {
  const sbAdmin = getSupabaseAdmin();
  if (!sbAdmin || !id) return { success: false, error: 'Database service unavailable' };
  try {
    const { data, error } = await sbAdmin.from('staff').update({
      status: 'Archived',
      is_archived: true,
      is_active: false,
      is_online: false,
      online_status: 'offline',
      archive_reason: reason || 'Administrative Deactivation',
      archive_notes: notes || '',
      archived_at: archivedAt || new Date().toISOString(),
      updated: new Date().toISOString()
    }).eq('id', id).select('id');
    if (error) return { success: false, error: error.message };
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

registerDatabaseHandler('staff-create', async (event, staffData = {}) => {
  const { operationId, ...profile } = staffData;
  const { data, error } = await getSupabaseAdmin().functions.invoke('provision-staff', { body: { profile, operationId } });
  if (error || !data?.profile) return { success: false, error: await readProvisioningError(error, data) };
  return { success: true, data: data.profile };
});

registerDatabaseHandler('staff-edit', async (event, input = {}) => {
  const client = getSupabaseAdmin();
  if (!client || !input.id) return { success: false, error: 'Database service unavailable' };
  try {
    const { data, error } = await client.functions.invoke('update-staff', { body: input });
    if (error || data?.profile?.id !== input.id) return { success: false, error: await readProvisioningError(error, data, 'edit') };
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error?.message || 'Staff changes could not be confirmed. Refresh before retrying.' };
  }
});

registerDatabaseHandler('staff-update', async (event, { id, updates }) => {
  const sbAdmin = getSupabaseAdmin();
  if (!sbAdmin || !id) return { success: false, error: 'Database service unavailable' };
  try {
    const payload = { ...updates, updated: new Date().toISOString() };
    const { data, error } = await sbAdmin.from('staff').update(payload).eq('id', id).select('id');
    if (error) return { success: false, error: error.message };
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

registerDatabaseHandler('staff-fetch-all', async () => {
  const sbAdmin = getSupabaseAdmin();
  if (!sbAdmin) return { success: false, error: 'Database service unavailable' };
  try {
    const { data, error } = await sbAdmin.rpc('ecotrack_admin_list_staff');
    if (error) return { success: false, error: error.message };
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

registerDatabaseHandler('locations-fetch-all', async () => {
  const sbAdmin = getSupabaseAdmin();
  if (!sbAdmin) return { success: false, error: 'Database service unavailable' };
  try {
    const [bRes, fRes, rRes] = await Promise.all([
      sbAdmin.from('buildings').select('*').order('name'),
      sbAdmin.from('floors').select('*').order('name'),
      sbAdmin.from('rooms').select('*').order('name')
    ]);
    if (bRes.error || fRes.error || rRes.error) return { success: false, error: 'Deployment locations could not be loaded. Check your connection and retry.' };
    return {
      success: true,
      buildings: bRes.data || [],
      floors: fRes.data || [],
      rooms: rRes.data || []
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Maintenance Reports Privileged IPC Handlers
function normalizeMaintenanceReportIds(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input)
    ? (input.ids ?? input.report_ids ?? input.id) : input;
  const entries = Array.isArray(raw) ? raw.flat(Infinity) : [raw];
  return [...new Set(entries
    .filter(id => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)))
    .map(id => String(id).trim()).filter(Boolean))];
}

registerDatabaseHandler('maintenance-delete-reports', async (event, ids) => {
  const sbAdmin = getSupabaseAdmin();
  if (!sbAdmin) return { success: false, error: 'Database service unavailable' };
  const targetIds = normalizeMaintenanceReportIds(ids);
  if (!targetIds.length) return { success: false, error: 'Invalid report IDs' };
  try {
    const { data, error } = await sbAdmin.rpc('delete_maintenance_reports', { report_ids: targetIds });
    if (error) return { success: false, error: error.message, code: error.code };
    if (!Array.isArray(data) || !data.length) return { success: false, error: 'No maintenance reports were deleted. Refresh and check the selected reports.' };
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

registerDatabaseHandler('maintenance-save-report', async (event, input) => {
  const client = getSupabaseAdmin();
  if (!client) return { success: false, error: 'Database service unavailable' };
  const report = input?.record;
  if (!report?.id) return { success: false, error: 'Report is required' };
  if (!input.operationId || typeof input.isNew !== 'boolean') {
    return { success: false, error: 'A report save operation is required. Refresh and retry.', code: 'INVALID_OPERATION' };
  }
  try {
    const { data, error } = await client.rpc('ecotrack_admin_save_report', {
      p_record: report,
      p_expected_updated: input.expectedUpdated ?? null,
      p_parent_expected: input.parentExpected ?? null,
      p_operation_id: input.operationId,
      p_create: input.isNew
    });
    // Validation, authorization and version checks belong to the transactional RPC.
    // A rejected operation must never fall through to a direct table write.
    if (error) return { success: false, error: error.code === '40001'
        ? 'This report changed on another device. Refresh it and review your changes before retrying.'
        : error.message, code: error.code };
    if (data?.report?.id !== report.id) {
      return { success: false, error: 'Database did not confirm the report save.', code: 'INVALID_RESPONSE' };
    }
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error?.message || 'Failed to save maintenance report', code: error?.code };
  }
});

registerDatabaseHandler('maintenance-fetch-reports', async () => {
  const sbAdmin = getSupabaseAdmin();
  if (!sbAdmin) return { success: false, error: 'Database service unavailable' };
  try {
    const { data, error } = await sbAdmin.from('maintenance_reports').select('*').order('created', { ascending: false });
    if (error) return { success: false, error: error.message };
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Hardware Node Schedule & Notifications Privileged IPC Handlers
registerDatabaseHandler('scheduler-fetch-data', async () => {
  const sbAdmin = getSupabaseAdmin();
  if (!sbAdmin) return { success: false, error: 'Database service unavailable' };
  try {
    const [rRes, fRes, bRes, nRes, aRes] = await Promise.all([
      sbAdmin.from('rooms').select('*').order('created'),
      sbAdmin.from('floors').select('*').order('created'),
      sbAdmin.from('buildings').select('*').order('created'),
      sbAdmin.from('nodes').select('*').order('name'),
      sbAdmin.from('aircons').select('*')
    ]);
    const failed = [rRes, fRes, bRes, nRes, aRes].find(result => result.error);
    if (failed) return { success: false, error: failed.error.message };
    return {
      success: true,
      rooms: rRes.data || [],
      floors: fRes.data || [],
      buildings: bRes.data || [],
      nodes: nRes.data || [],
      aircons: aRes.data || []
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

registerDatabaseHandler('node-update-schedule', async (event, { id, name, wakeTime, sleepTime, intervalVal, intervalUnit }) => {
  const sbAdmin = getSupabaseAdmin();
  if (!sbAdmin) return { success: false, error: 'Database service unavailable' };
  try {
    const updatePayload = {
      wake_time: wakeTime,
      sleep_time: sleepTime,
      interval_val: intervalVal,
      interval_unit: intervalUnit,
      updated: new Date().toISOString()
    };
    // Prefer the primary key; name is a fallback, never a second independent write.
    let target = null;
    for (const [column, value] of [['id', id], ['name', name]]) {
      if (!value || target) continue;
      const lookup = await sbAdmin.from('nodes').select('id').eq(column, value).maybeSingle();
      if (lookup.error) return { success: false, error: lookup.error.message };
      target = lookup.data;
    }
    if (!target) return { success: false, error: 'Controller node not found' };
    delete updatePayload.updated;
    const res = await sbAdmin.rpc('ecotrack_device_mutation', { p_operation: 'update_node', p_id: target.id, p_payload: updatePayload });
    if (res.error || !res.data?.node) return { success: false, error: res.error?.message || 'No controller was updated' };
    return { success: true, data: [res.data.node] };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

registerDatabaseHandler('notifications-fetch-today', async (event, todayDateStr) => {
  const sbAdmin = getSupabaseAdmin();
  if (!sbAdmin) return { success: false, error: 'Database service unavailable' };
  try {
    const { data, error } = await sbAdmin.from('notifications').select('id, content, date, time').eq('date', todayDateStr);
    if (error) return { success: false, error: error.message };
    return { success: true, data: data || [] };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

registerDatabaseHandler('notification-create', async (event, notifData) => {
  const sbAdmin = getSupabaseAdmin();
  if (!sbAdmin || !notifData) return { success: false, error: 'Database service unavailable' };
  try {
    const payload = {
      ...notifData,
      created: notifData.created || new Date().toISOString(),
      updated: notifData.updated || new Date().toISOString()
    };

    for (const [field, table] of [['room_id', 'rooms'], ['rule_id', 'rules'], ['node_id', 'nodes']]) {
      if (!payload[field]) continue;
      let resolved = null;
      for (const column of ['id', 'name']) {
        const result = await sbAdmin.from(table).select('id').eq(column, payload[field]).maybeSingle();
        if (result.error) return { success: false, error: result.error.message };
        if (result.data) { resolved = result.data.id; break; }
      }
      if (!resolved) return { success: false, error: `Unknown ${field}: ${payload[field]}` };
      payload[field] = resolved;
    }
    const { data, error } = await sbAdmin.from('notifications').insert([payload]).select().maybeSingle();
    if (error) return { success: false, error: error.message, code: error.code };
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

registerDatabaseHandler('notifications-fetch-all', async () => {
  const sbAdmin = getSupabaseAdmin();
  if (!sbAdmin) return { success: false, error: 'Database service unavailable' };
  try {
    const { data, error } = await sbAdmin.from('notifications').select('*').order('created', { ascending: false });
    if (error) return { success: false, error: error.message };
    return { success: true, data: data || [] };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

function notificationMutationIds(ids) {
  const values = Array.isArray(ids) ? ids : (ids ? [ids] : []);
  if (!values.length || values.some(id => !['string', 'number'].includes(typeof id) || !String(id).trim())) return [];
  return [...new Set(values.map(String))];
}

function confirmsNotificationIds(data, ids, dismissed = false) {
  if (!Array.isArray(data) || data.length !== ids.length) return false;
  const returned = new Set(data.filter(row => !dismissed || row?.is_dismissed_from_inbox === true).map(row => String(row.id)));
  return returned.size === ids.length && ids.every(id => returned.has(id));
}

registerDatabaseHandler('notifications-update', async (event, { id, ids, updates } = {}) => {
  const sbAdmin = getSupabaseAdmin();
  const targets = notificationMutationIds(ids || id);
  if (!sbAdmin || !targets.length || !updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return { success: false, error: 'Invalid notification update' };
  }
  try {
    const payload = { ...updates, updated: new Date().toISOString() };
    const { data, error } = await sbAdmin.from('notifications').update(payload).in('id', targets).select();
    if (error) return { success: false, error: error.message };
    if (!confirmsNotificationIds(data, targets, updates.is_dismissed_from_inbox === true)) {
      return { success: false, error: 'The server did not confirm every requested notification update' };
    }
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Explicit Rule Management audit erasure retains its existing delete contract.
// Inbox Delete/Clear All use the persistent dismissal update above instead.
registerDatabaseHandler('notifications-delete', async (event, ids) => {
  const sbAdmin = getSupabaseAdmin();
  const targetIds = notificationMutationIds(ids);
  if (!sbAdmin || !targetIds.length) return { success: false, error: 'Invalid IDs' };
  try {
    const { data, error } = await sbAdmin.from('notifications').delete().in('id', targetIds).select();
    if (error) return { success: false, error: error.message };
    if (!confirmsNotificationIds(data, targetIds)) return { success: false, error: 'The server did not confirm every requested notification deletion' };
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Rules Management Privileged IPC Handlers
registerDatabaseHandler('rules-fetch-data', async () => {
  const sbAdmin = getSupabaseAdmin();
  if (!sbAdmin) return { success: false, error: 'Database service unavailable' };
  try {
    const [rulesRes, rnRes, rRes, fRes, bRes, nRes] = await Promise.all([
      sbAdmin.from('rules').select('*').order('created', { ascending: false }),
      sbAdmin.from('rule_nodes').select('*, node:nodes(*)'),
      sbAdmin.from('rooms').select('*').order('created', { ascending: false }),
      sbAdmin.from('floors').select('*').order('created'),
      sbAdmin.from('buildings').select('*').order('created'),
      sbAdmin.from('nodes').select('*')
    ]);
    return {
      success: true,
      rules: rulesRes.data || [],
      ruleNodes: rnRes.data || [],
      rooms: rRes.data || [],
      floors: fRes.data || [],
      buildings: bRes.data || [],
      nodes: nRes.data || []
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

registerDatabaseHandler('rule-save', async (event, { rule, targetNodes, isEdit, editId }) => {
  const sbAdmin = getSupabaseAdmin();
  if (!sbAdmin) return { success: false, error: 'Database service unavailable' };
  try {
    if (isEdit && !editId) throw new Error('Choose the rule to update.');
    const receipt = await require('../public/js/rule-persistence').save(sbAdmin, rule, targetNodes, isEdit ? editId : null);
    return { success: true, ruleId: receipt.rule_id, targetNodes: receipt.target_nodes };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

registerDatabaseHandler('rule-delete', async (event, ids) => {
  const sbAdmin = getSupabaseAdmin();
  const targetIds = Array.isArray(ids) ? ids : (ids ? [ids] : []);
  if (!sbAdmin || targetIds.length === 0) return { success: false, error: 'Invalid IDs' };
  try {
    await sbAdmin.from('rule_nodes').delete().in('rule_id', targetIds);
    const { data, error } = await sbAdmin.from('rules').delete().in('id', targetIds).select();
    if (error) return { success: false, error: error.message };
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

registerDatabaseHandler('rule-toggle', async (event, payload) => {
  const sbAdmin = getSupabaseAdmin();
  if (!sbAdmin || !payload) return { success: false, error: 'Database service unavailable' };
  try {
    const targetIds = Array.isArray(payload.ids) ? payload.ids : (Array.isArray(payload.id) ? payload.id : (payload.id ? [payload.id] : []));
    if (targetIds.length === 0) return { success: false, error: 'No rule IDs provided' };
    const data = await require('../public/js/rule-persistence').setEnabled(sbAdmin, targetIds, payload.enabled);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

function createWindow() {
  if (!hasSingleInstanceLock || !app.isReady()) return;
  if (mainWindow && !mainWindow.isDestroyed()) return;
  mainWindow = new BrowserWindow({
    width: 2000,
    height: 1000,
    icon: path.join(__dirname, '../assets/ecoTrack.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  const startUrl = `file://${path.join(__dirname, '../public/login.html')}`;

  mainWindow.loadURL(startUrl);

  // Prevent blank/white windows when links or window.open are triggered
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // The user selects the real device; never silently select the first advertisement.
  mainWindow.webContents.on('select-bluetooth-device', (event, deviceList, callback) => {
    event.preventDefault();
    const devices = (deviceList || []).filter(device => device.deviceName?.startsWith('EcoTrack-'));
    let entry = [...bluetoothSelections.entries()].find(([, request]) => request.sender === mainWindow.webContents);
    if (!entry) {
      const request_id = require('crypto').randomUUID();
      const request = { sender: mainWindow.webContents, callback, devices, presented: false };
      request.timer = setTimeout(() => { bluetoothSelections.delete(request_id); callback(''); }, 30000);
      bluetoothSelections.set(request_id, request);
      entry = [request_id, request];
    }
    const [request_id, request] = entry;
    request.devices = devices;
    if (devices.length && !request.presented) {
      request.presented = true;
      mainWindow.webContents.send('bluetooth-select-request', { request_id, devices });
    }
  });
  mainWindow.webContents.session.setBluetoothPairingHandler((details, callback) => {
    if (!mainWindow || mainWindow.isDestroyed() || !['confirm', 'confirmPin', 'providePin'].includes(details.pairingKind)) return callback({ confirmed: false });
    const request_id = require('crypto').randomUUID();
    const request = { sender: mainWindow.webContents, callback, kind: details.pairingKind };
    request.timer = setTimeout(() => { bluetoothPairings.delete(request_id); callback({ confirmed: false }); }, 60000);
    bluetoothPairings.set(request_id, request);
    mainWindow.webContents.send('bluetooth-pairing-request', { ...details, request_id });
  });
  mainWindow.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (!isMainFrame) return;
    for (const [pending, cancelled] of [[bluetoothSelections, ''], [bluetoothPairings, { confirmed: false }]]) {
      for (const request of pending.values()) { clearTimeout(request.timer); request.callback(cancelled); }
      pending.clear();
    }
  });

  // Remove menu bar
  Menu.setApplicationMenu(null);

  // Enable standard shortcuts for development and smooth reload (Ctrl+R, F5, Ctrl+Shift+I)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.control && input.key.toLowerCase() === 'r') || input.key === 'F5') {
      mainWindow.webContents.reloadIgnoringCache();
      event.preventDefault();
    }
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  mainWindow.on('closed', () => {
    for (const pending of [bluetoothSelections, bluetoothPairings]) {
      for (const request of pending.values()) clearTimeout(request.timer);
      pending.clear();
    }
    mainWindow = null;
  });
}

app.setAppUserModelId("EcoTrack Notification");
if (hasSingleInstanceLock) {
  app.on('ready', createWindow);
  app.on('activate', () => focusMainWindow());
}

// Handle SSL / certificate errors gracefully across network reconnects
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  event.preventDefault();
  callback(true);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

