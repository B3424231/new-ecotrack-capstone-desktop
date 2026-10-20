// ===================================================================
// ECOTRACK SUPABASE CLIENT & SQLITE TELEMETRY ADAPTER
// - Routes control logs ('telemetry') -> Native SQLite3 Database (backend/telemetry.db)
// - Cloud entities use the Supabase client directly
// ===================================================================

(function() {
  // 1. CONFIGURATION
  const DEFAULT_SUPABASE_URL = 'https://ynopdmfhngooknybyahq.supabase.co';
  const DEFAULT_ANON_KEY = 'sb_publishable_HNxLHBeGMPsdoEvVtUusWw_CJ-qlHQ-';
  const DEFAULT_BACKEND_URL = 'http://localhost:5000';
  function isPublicKey(key) {
    if (typeof key !== 'string') return false;
    if (key.startsWith('sb_publishable_')) return true;
    try { return JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'anon'; }
    catch (_) { return false; }
  }

  // Sanitize stored localStorage if it contains stale placeholder values or secret keys
  try {
    const rawStoredUrl = localStorage.getItem('ecoTrack_supabase_url');
    if (rawStoredUrl && (rawStoredUrl.includes('your-project') || !rawStoredUrl.startsWith('http'))) {
      localStorage.removeItem('ecoTrack_supabase_url');
    }
    const rawStoredKey = localStorage.getItem('ecoTrack_supabase_anon_key');
    if (rawStoredKey && (rawStoredKey.includes('your_supabase') || rawStoredKey.includes('your-project') || !isPublicKey(rawStoredKey))) {
      localStorage.removeItem('ecoTrack_supabase_anon_key');
    }
    // Remove any secret keys stored in browser localStorage
    localStorage.removeItem('ecoTrack_supabase_service_role_key');
  } catch (_) {}

  const electronEnv = (typeof window !== 'undefined' && window.electron && window.electron.env) ? window.electron.env : {};
  const storedUrl = localStorage.getItem('ecoTrack_supabase_url');
  const storedKey = localStorage.getItem('ecoTrack_supabase_anon_key');

  const validStoredUrl = (storedUrl && !storedUrl.includes('your-project') && storedUrl.startsWith('http')) ? storedUrl : null;
  const validStoredKey = (storedKey && !storedKey.includes('your_supabase') && !storedKey.includes('your-project') && isPublicKey(storedKey) && storedKey.length > 10) ? storedKey : null;

  const supabaseUrl = validStoredUrl || window.SUPABASE_URL || electronEnv.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  let supabaseKey = validStoredKey || window.SUPABASE_KEY || electronEnv.SUPABASE_ANON_KEY || electronEnv.SUPABASE_KEY || DEFAULT_ANON_KEY;
  // Strictly prevent secret API key in browser client
  if (!isPublicKey(supabaseKey)) {
    console.warn('[EcoTrack] Forbidden secret key in browser context; reverting to publishable key.');
    supabaseKey = DEFAULT_ANON_KEY;
  }
  const backendUrl = localStorage.getItem('ecoTrack_backend_url') || window.BACKEND_URL || electronEnv.BACKEND_URL || DEFAULT_BACKEND_URL;

  // Expose globally
  window.SUPABASE_URL = supabaseUrl;
  window.SUPABASE_KEY = supabaseKey;
  window.BACKEND_URL = backendUrl;

  window.ECOTRACK_CONFIG = {
    supabaseUrl,
    supabaseKey,
    backendUrl,
    isSupabaseConfigured: () => {
      return !!(supabaseUrl && !supabaseUrl.includes('your-project') && supabaseKey && !supabaseKey.includes('your_supabase') && !supabaseKey.startsWith('sb_secret_'));
    }
  };

  // 2. INITIALIZE SUPABASE CLIENT (Browser uses publishable/anon key)
  let sbClient = null;
  const sbFactory = (typeof window !== 'undefined' && window.supabase && typeof window.supabase.createClient === 'function')
    ? window.supabase
    : (typeof globalThis !== 'undefined' && globalThis.supabase && typeof globalThis.supabase.createClient === 'function')
      ? globalThis.supabase
      : (typeof supabase !== 'undefined' && typeof supabase.createClient === 'function' ? supabase : null);

  if (sbFactory) {
    try {
      sbClient = sbFactory.createClient(supabaseUrl, supabaseKey, {
        auth: {
          persistSession: true,
          storage: window.localStorage
        }
      });
      console.log('[EcoTrack] Supabase client initialized with publishable key.');
    } catch (e) {
      console.warn('[EcoTrack] Could not initialize live Supabase client:', e.message);
    }
  }

  // Active client in the browser is ALWAYS the safe publishable client (sbClient)
  window.supabaseClient = sbClient;
  window.sb = sbClient;
  window.supabaseAdmin = null;

  if (sbClient && window.electron?.invoke) {
    const mirror = session => window.electron.invoke('auth-set-session', session ? {
      access_token: session.access_token, refresh_token: session.refresh_token
    } : null);
    window.ecotrackAuthReady = sbClient.auth.getSession().then(async ({ data }) => {
      let session = data?.session;
      if (!session && typeof window !== 'undefined' && window.localStorage) {
        const storedRefresh = localStorage.getItem('ecoTrack_refresh_token');
        const storedAccess = localStorage.getItem('ecoTrack_auth_token');
        if (storedRefresh && storedAccess) {
          try {
            const restored = await sbClient.auth.setSession({ access_token: storedAccess, refresh_token: storedRefresh });
            if (restored?.data?.session) session = restored.data.session;
          } catch (_) {}
        }
      }
      return mirror(session);
    });
    sbClient.auth.onAuthStateChange((_event, session) => {
      // Leave the Auth callback before doing asynchronous IPC work.
      window.ecotrackAuthReady = Promise.resolve().then(() => mirror(session));
      window.ecotrackAuthReady.catch(() => {});
    });
    window.ecotrackAuthReady.catch(() => {});
  }

  // Keep synchronous image renderers compatible while signing private references.
  const storageImages = new Map();
  const storageReference = raw => typeof raw === 'string' && raw.match(/^storage:\/\/([^/]+)\/(.+)$/);

  const signStorageImage = async raw => {
    const match = storageReference(raw);
    if (!match || !sbClient || match[2].split('/').some(part => !part || part === '.' || part === '..') || /[\?#]/.test(match[2])) return null;
    const cached = storageImages.get(raw);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const promise = Promise.resolve(window.ecotrackAuthReady).then(async () => {
      const { data, error } = await sbClient.storage.from(match[1]).createSignedUrl(match[2], 3600);
      if (error || !data?.signedUrl) throw error || new Error('Signing failed');
      return data.signedUrl;
    });
    storageImages.set(raw, { promise, expires: Date.now() + 3300000 });
    const url = await promise.catch(() => null);
    if (!url) {
      storageImages.delete(raw);
      return null;
    }
    storageImages.set(raw, { promise, url, expires: Date.now() + 3300000 });
    if (typeof document !== 'undefined' && document.querySelectorAll) {
      try {
        const images = document.querySelectorAll('img[src^="storage://"], img');
        images.forEach(img => {
          if (img && typeof img.getAttribute === 'function' && (img.getAttribute('src') === raw || img.src === raw)) {
            img.setAttribute('src', url);
          }
        });
      } catch (_) {}
    }
    return url;
  };

  window.ecotrackResolveStorageImage = raw => {
    const match = storageReference(raw);
    if (!match) return raw;
    const cached = storageImages.get(raw);
    return cached?.url || raw;
  };
  window.ecotrackSignStorageImage = signStorageImage;

  if (typeof MutationObserver === 'function') {
    let _hydrating = false;
    const hydrate = () => {
      if (_hydrating) return;
      _hydrating = true;
      try {
        document.querySelectorAll('img[src^="storage://"]').forEach(img => {
          const raw = img.getAttribute('src');
          if (raw) signStorageImage(raw);
        });
      } finally {
        _hydrating = false;
      }
    };
    const observer = new MutationObserver(hydrate);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    hydrate();
  }
  sbClient?.auth.onAuthStateChange(() => storageImages.clear());

  if (sbClient) {
    try {
      window.dispatchEvent(new CustomEvent('supabase:ready', { detail: sbClient }));
      if (window.EcoTrackMaintenance && typeof window.EcoTrackMaintenance.fetchReports === 'function') {
        window.EcoTrackMaintenance.fetchReports();
      }
    } catch (_) {}
  }

  // ===================================================================
  // 3. NATIVE SQLITE3 TELEMETRY CONTROL LOGS CLIENT
  // Dedicated strictly to Control Logs (telemetry) via SQLite3 API
  // ===================================================================
  class Sqlite3TelemetryCollection {
    constructor() {
      this.table = 'telemetry';
      this.baseUrl = window.ECOTRACK_CONFIG.backendUrl || DEFAULT_BACKEND_URL;
    }
    async request(path, options) {
      const response = await fetch(`${this.baseUrl}/api/telemetry${path}`, options);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Telemetry request failed (HTTP ${response.status})`);
      return data;
    }
    async getFullList(options = {}) { return (await this.getList(1, 0, options)).items; }
    async getList(page = 1, perPage = 50, options = {}) {
      const params = new URLSearchParams({ page: String(page), perPage: String(perPage) });
      for (const field of ['sort', 'filter', 'date', 'node_id', 'sensor_name', 'start_time', 'end_time']) {
        if (options[field] != null && options[field] !== '') params.set(field, options[field]);
      }
      return this.request(`?${params}`);
    }
    async getFirstListItem(filter, options = {}) {
      const result = await this.getList(1, 1, { ...options, filter });
      if (result.items?.length) return result.items[0];
      throw new Error('Telemetry item not found');
    }
    async getOne(id) { return this.request(`/${encodeURIComponent(id)}`); }
    async create(data) {
      return this.request('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    }
    async update(id, data) {
      return this.request(`/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    }
    async delete(id) { await this.request(`/${encodeURIComponent(id)}`, { method: 'DELETE' }); return true; }
    subscribe(topic, callback) {
      let subscribed = true, signature = null, previousCount = null;
      const poll = async () => {
        try {
          const data = await this.getList(1, 1, { sort: '-updated' });
          if (!subscribed) return;
          const record = data.items[0] || null;
          const next = JSON.stringify([data.totalItems, record]);
          if (next !== signature) {
            const action = previousCount !== null && data.totalItems < previousCount ? 'delete' : signature === null ? 'create' : 'update';
            signature = next; previousCount = data.totalItems;
            if (typeof callback === 'function') callback({ action, record });
          }
        } catch (_) { /* Failed reads must not masquerade as empty results. */ }
      };
      const interval = setInterval(poll, 2000);
      return Promise.resolve(() => { subscribed = false; clearInterval(interval); });
    }
  }

  // Cloud metadata uses window.supabaseClient.from(table) directly.
  class TelemetryClient {
    collection(name) {
      if (name === 'telemetry') return new Sqlite3TelemetryCollection();
      throw new Error('Use supabaseClient.from(table) for Supabase metadata');
    }
  }

  window.telemetryClient = new TelemetryClient();
  // Compatibility names for existing telemetry pages; these do not open PocketBase.
  window.pb = window.telemetryClient;
  window.PocketBase = TelemetryClient;
})();
