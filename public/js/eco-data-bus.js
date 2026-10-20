/**
 * EcoDataBus - Event-Driven Data Fetching & Query Engine
 * 
 * Provides:
 * 1. Decoupled Pub/Sub event bus for data query lifecycles (start, success, error, cancel).
 * 2. Stale-While-Revalidate (SWR) caching for instant page loads and seamless background revalidation.
 * 3. In-flight request cancellation via AbortController to eliminate race conditions.
 * 4. Automatic search/filter typing debouncing.
 * 5. Supabase Realtime push invalidation bridge replacing interval polling.
 */

(function (window) {
  'use strict';

  class EcoDataBusEngine {
    constructor() {
      this.listeners = new Map();
      this.cache = new Map(); // key -> { data, timestamp, ttl }
      this.inFlightControllers = new Map(); // key -> AbortController
      this.inFlightRequests = new Map(); // key -> shared read promise
      this.realtimeChannels = new Map();
      this.DEFAULT_TTL_MS = 45000; // 45 seconds default SWR validity

      // Broadcast channel for multi-tab / electron window sync
      try {
        if (window.BroadcastChannel) {
          this.bc = new BroadcastChannel('eco_data_bus_channel');
          this.bc.onmessage = (msg) => {
            if (msg.data && msg.data.event && !msg.data.event.startsWith('data:query:')) {
              this._dispatchLocal(msg.data.event, msg.data.payload);
            }
          };
        }
      } catch (_) {}

      // Automatically cancel all in-flight queries when page unloads
      window.addEventListener('beforeunload', () => {
        this.cancelAll();
      });

      this._initRealtimeBridge();
    }

    // --------------------------------------------------------------------------
    // 1. EVENT EMITTER (Pub/Sub)
    // --------------------------------------------------------------------------
    on(event, callback) {
      if (typeof callback !== 'function') return () => {};
      if (!this.listeners.has(event)) {
        this.listeners.set(event, new Set());
      }
      this.listeners.get(event).add(callback);
      return () => this.off(event, callback);
    }

    off(event, callback) {
      if (!this.listeners.has(event)) return;
      this.listeners.get(event).delete(callback);
      if (this.listeners.get(event).size === 0) {
        this.listeners.delete(event);
      }
    }

    emit(event, payload = {}) {
      this._dispatchLocal(event, payload);
      // Synchronize across windows/tabs
      try {
        if (this.bc && !event.startsWith('data:query:')) {
          this.bc.postMessage({ event, payload });
        }
      } catch (_) {}
    }

    _dispatchLocal(event, payload) {
      // Direct listeners for event
      if (this.listeners.has(event)) {
        this.listeners.get(event).forEach(cb => {
          try { cb(payload); } catch (err) { console.error(`[EcoDataBus] Listener error on ${event}:`, err); }
        });
      }

      // Wildcard / prefix listeners: e.g. "data:query:*"
      const parts = event.split(':');
      if (parts.length > 1) {
        const prefix = parts.slice(0, -1).join(':') + ':*';
        if (this.listeners.has(prefix)) {
          this.listeners.get(prefix).forEach(cb => {
            try { cb({ event, ...payload }); } catch (err) { console.error(`[EcoDataBus] Wildcard error on ${prefix}:`, err); }
          });
        }
      }
    }

    /**
     * Subscribe to query lifecycle specifically for a key
     */
    onQuery(key, { onStart, onSuccess, onError, onCancel } = {}) {
      const unsubs = [];
      if (onStart) {
        unsubs.push(this.on('data:query:start', (p) => { if (p.key === key) onStart(p); }));
      }
      if (onSuccess) {
        unsubs.push(this.on('data:query:success', (p) => { if (p.key === key) onSuccess(p); }));
      }
      if (onError) {
        unsubs.push(this.on('data:query:error', (p) => { if (p.key === key) onError(p); }));
      }
      if (onCancel) {
        unsubs.push(this.on('data:query:cancelled', (p) => { if (p.key === key) onCancel(p); }));
      }
      return () => unsubs.forEach(fn => fn());
    }

    // --------------------------------------------------------------------------
    // 2. QUERY EXECUTION WITH SWR CACHING & IN-FLIGHT CANCELLATION
    // --------------------------------------------------------------------------
    /**
     * Execute or retrieve a query.
     * @param {string} key Unique query identifier (e.g. 'aircons', 'nodes', 'rules')
     * @param {Function} fetcherFn Async function receiving (signal) and returning data
     * @param {Object} options { ttl, forceRefresh, silent }
     */
    async query(key, fetcherFn, options = {}) {
      const ttl = options.ttl ?? this.DEFAULT_TTL_MS;
      const forceRefresh = options.forceRefresh || false;
      const cached = this.cache.get(key);
      const now = Date.now();

      // Check cache
      if (cached && !forceRefresh) {
        const isFresh = (now - cached.timestamp) < ttl;
        
        // Return cached immediately (zero-wait rendering)
        this.emit('data:query:success', {
          key,
          data: cached.data,
          fromCache: true,
          isFresh,
          timestamp: cached.timestamp
        });

        // If still fresh, no background fetch needed
        if (isFresh) {
          return cached.data;
        }

        // If stale, revalidate in background without blocking UI
        this._executeFetch(key, fetcherFn, ttl, true, options.timeout).catch(() => {});
        return cached.data;
      }

      // No cache or forceRefresh: execute fetch foreground
      return this._executeFetch(key, fetcherFn, ttl, Boolean(cached), options.timeout);
    }

    _executeFetch(key, fetcherFn, ttl, isBackground = false, timeoutMs = 15000) {
      // Multiple consumers share a read; explicit invalidation/cancellation replaces it.
      if (this.inFlightRequests.has(key)) return this.inFlightRequests.get(key);
      const controller = new AbortController();
      this.inFlightControllers.set(key, controller);
      let timer, onAbort;
      const request = Promise.resolve().then(async () => {
        if (controller.signal.aborted) return null;
        this.emit('data:query:start', { key, isBackground, timestamp: Date.now() });
        try {
          const deadline = new Promise((_resolve, reject) => {
            onAbort = () => { const error = new Error('Read cancelled'); error.name = 'AbortError'; reject(error); };
            controller.signal.addEventListener('abort', onAbort, { once: true });
            timer = setTimeout(() => {
              const error = new Error('Data request timed out. Please retry.');
              error.name = 'TimeoutError'; reject(error); controller.abort();
            }, timeoutMs);
          });
          const data = await Promise.race([Promise.resolve().then(() => fetcherFn(controller.signal)), deadline]);
          if (controller.signal.aborted || this.inFlightControllers.get(key) !== controller) return null;
          this.cache.set(key, { data, timestamp: Date.now(), ttl });
          this.emit('data:query:success', { key, data, fromCache: false, isFresh: true, timestamp: Date.now() });
          return data;
        } catch (error) {
          if (error.name !== 'TimeoutError' && (error.name === 'AbortError' || controller.signal.aborted)) return null;
          this.emit('data:query:error', { key, error, isBackground, timestamp: Date.now() });
          throw error;
        } finally {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', onAbort);
          // An obsolete read must never remove the replacement read's bookkeeping.
          if (this.inFlightControllers.get(key) === controller) {
            this.inFlightControllers.delete(key);
            this.inFlightRequests.delete(key);
          }
        }
      });
      this.inFlightRequests.set(key, request);
      return request;
    }

    /**
     * Cancel specific in-flight query
     */
    cancel(key) {
      if (this.inFlightControllers.has(key)) {
        this.inFlightControllers.get(key).abort();
        this.inFlightControllers.delete(key);
        this.inFlightRequests.delete(key);
        this.emit('data:query:cancelled', { key });
      }
    }

    /**
     * Cancel all in-flight queries
     */
    cancelAll() {
      for (const [key, controller] of this.inFlightControllers.entries()) {
        controller.abort();
        this.emit('data:query:cancelled', { key });
      }
      this.inFlightControllers.clear();
      this.inFlightRequests.clear();
    }

    clear() { this.cancelAll(); this.cache.clear(); }

    /**
     * Invalidate cached data for a key and notify subscribers
     */
    invalidate(key) {
      this.cancel(key);
      this.cache.delete(key);
      this.emit('data:invalidated', { key, timestamp: Date.now() });
    }

    /**
     * Mutate cached data optimistically without refetching immediately
     */
    mutate(key, updater) {
      const cached = this.cache.get(key);
      let newData = updater;
      if (typeof updater === 'function' && cached) {
        newData = updater(cached.data);
      }
      this.cache.set(key, {
        data: newData,
        timestamp: Date.now(),
        ttl: cached ? cached.ttl : this.DEFAULT_TTL_MS
      });

      this.emit('data:query:success', {
        key,
        data: newData,
        fromCache: false,
        isOptimistic: true,
        timestamp: Date.now()
      });
    }

    /**
     * Get currently cached data synchronously without fetching
     */
    getCached(key) {
      const cached = this.cache.get(key);
      return cached ? cached.data : null;
    }

    // --------------------------------------------------------------------------
    // 3. UTILITIES: DEBOUNCE & THROTTLE
    // --------------------------------------------------------------------------
    debounce(fn, delayMs = 250) {
      let timeoutId = null;
      const debounced = function (...args) {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
          timeoutId = null;
          fn.apply(this, args);
        }, delayMs);
      };
      debounced.cancel = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };
      return debounced;
    }

    // --------------------------------------------------------------------------
    // 4. SUPABASE REALTIME PUSH BRIDGE
    // --------------------------------------------------------------------------
    _initRealtimeBridge() {
      const setup = () => {
        const sb = window.supabaseClient || window.sb;
        if (!sb || typeof sb.channel !== 'function') return;
        if (this.realtimeClient === sb) return;
        this.realtimeChannels.forEach(channel => this.realtimeClient?.removeChannel?.(channel));
        this.authSubscription?.unsubscribe?.();
        this.realtimeClient = sb;
        let account;
        this.authSubscription = sb.auth?.onAuthStateChange?.((_event, session) => {
          const next = session?.user?.id || null;
          if (next !== account) { account = next; this.clear(); }
        })?.data?.subscription;

        try {
          const channel = sb.channel('eco_data_bus_realtime');
          const tables = ['aircons', 'nodes', 'rules', 'notifications', 'staff', 'reports'];

          tables.forEach(table => {
            channel.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
              if (table === 'nodes' && window.EcoTrackAirconSystem?.isConnectionOnlyNodeEvent(payload)) return;
              // Automatically invalidate and push update to subscribers
              this.invalidate(table);
              this.emit(`data:realtime:${table}`, payload);
            });
          });

          channel.subscribe();
          this.realtimeChannels.set('global', channel);
        } catch (err) {
          console.warn('[EcoDataBus] Realtime channel setup notice:', err);
        }
      };

      window.addEventListener('supabase:ready', setup);
      if (window.supabaseClient || window.sb) {
        setTimeout(setup, 150);
      }
    }
  }

  window.EcoDataBus = new EcoDataBusEngine();
})(window);
