/**
 * EcoTrack Skeletons - Database Query Loading Placeholders & Binder
 * High-performance, theme-aware shimmer skeleton placeholders matching actual page layouts.
 * Fully integrated with EcoDataBus for decoupled, event-driven transitions.
 */
(function (window) {
  'use strict';

  const tracked = new WeakSet();
  const deadlines = new WeakMap();
  function getEl(target, track = true) {
    if (!target) return null;
    const el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el || !track) return el;
    // Initial placeholders only: refreshes retain the most recently rendered content.
    if (el.dataset.ecoLoaded === 'true' && !el.querySelector('.eco-skeleton')) return null;
    el.setAttribute('aria-busy', 'true');
    if (!deadlines.has(el)) {
      const timer = setTimeout(() => {
        deadlines.delete(el);
        if (el.isConnected && el.querySelector('.eco-skeleton'))
          EcoTrackSkeletons.renderLoadingError(el, new Error('Data is taking too long to load. Check your connection and retry.'));
      }, 20000);
      deadlines.set(el, timer);
    }
    if (typeof MutationObserver === 'function' && !tracked.has(el)) {
      tracked.add(el);
      new MutationObserver(() => {
        if (!el.querySelector('.eco-skeleton')) {
          clearTimeout(deadlines.get(el)); deadlines.delete(el);
          el.dataset.ecoLoaded = 'true';
          el.setAttribute('aria-busy', 'false');
        }
      }).observe(el, { childList: true, subtree: true });
    }
    return el;
  }

  const EcoTrackSkeletons = {
    renderLoadingError(containerOrId, error, retry = () => window.location.reload()) {
      const el = getEl(containerOrId, false);
      if (!el) return;
      el.setAttribute('aria-busy', 'false');
      if (el.dataset.ecoLoaded === 'true' && !el.querySelector('.eco-skeleton')) {
        window.EcoToast?.warning('Unable to refresh. Previously loaded data is still shown.');
        return;
      }
      const content = document.createElement('div');
      content.className = 'p-4 text-sm text-rose-500'; content.setAttribute('role', 'alert');
      const message = document.createElement('p');
      message.textContent = error?.message || 'Unable to load data. Please retry.';
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'mt-2 font-semibold underline'; button.textContent = 'Retry loading';
      button.addEventListener('click', retry); content.append(message, button);
      if (el.tagName === 'TBODY') {
        const row = document.createElement('tr'), cell = document.createElement('td');
        cell.colSpan = el.querySelector('tr')?.children.length || 1;
        cell.append(content); row.append(cell); el.replaceChildren(row);
      } else el.replaceChildren(content);
    },
    /**
     * Render realistic table row skeletons
     */
    renderTableSkeleton(containerOrId, options = {}) {
      const el = getEl(containerOrId);
      if (!el) return;

      const rows = options.rows || 5;
      const cols = options.cols || 6;
      const colWidths = options.colWidths || ['w-24', 'w-36', 'w-28', 'w-20', 'w-24', 'w-16'];

      let html = '';
      for (let r = 0; r < rows; r++) {
        html += `
          <tr class="border-b border-gray-100 dark:border-white/5">
            ${Array.from({ length: cols }).map((_, c) => {
              const widthClass = colWidths[c % colWidths.length] || 'w-24';
              return `
                <td class="px-5 py-4 whitespace-nowrap">
                  <div class="h-4 ${widthClass} eco-skeleton rounded"></div>
                </td>
              `;
            }).join('')}
          </tr>
        `;
      }
      el.innerHTML = html;
    },

    /**
     * Render staff technician card skeletons in a table tbody
     */
    renderStaffTableSkeleton(containerOrId, options = {}) {
      const el = getEl(containerOrId);
      if (!el) return;

      const rows = options.rows || 5;
      let html = '';
      for (let r = 0; r < rows; r++) {
        html += `
          <tr class="border-b border-gray-100 dark:border-white/5">
            <td class="px-5 py-4">
              <div class="flex items-center gap-3">
                <div class="w-9 h-9 rounded-xl eco-skeleton shrink-0"></div>
                <div class="space-y-1.5 flex-1">
                  <div class="h-3.5 w-28 eco-skeleton rounded"></div>
                  <div class="h-2.5 w-36 eco-skeleton rounded"></div>
                </div>
              </div>
            </td>
            <td class="px-5 py-4">
              <div class="h-3.5 w-24 eco-skeleton rounded"></div>
            </td>
            <td class="px-5 py-4">
              <div class="h-3.5 w-32 eco-skeleton rounded"></div>
            </td>
            <td class="px-5 py-4">
              <div class="h-6 w-20 rounded-full eco-skeleton"></div>
            </td>
            <td class="px-5 py-4">
              <div class="h-3.5 w-16 eco-skeleton rounded"></div>
            </td>
            <td class="px-5 py-4">
              <div class="h-3.5 w-24 eco-skeleton rounded"></div>
            </td>
            <td class="px-5 py-4 text-right">
              <div class="h-7 w-16 eco-skeleton rounded-lg inline-block"></div>
            </td>
          </tr>
        `;
      }
      el.innerHTML = html;
    },

    /**
     * Render AC Control / Node grid card skeletons
     */
    renderNodeGridSkeleton(containerOrId, options = {}) {
      const el = getEl(containerOrId);
      if (!el) return;

      const count = options.count || 4;
      let html = '';
      for (let i = 0; i < count; i++) {
        html += `
          <div class="bg-white/5 dark:bg-[#0c1328]/80 border border-gray-200/60 dark:border-white/10 rounded-2xl p-5 shadow-sm space-y-4">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl eco-skeleton"></div>
                <div class="space-y-1.5">
                  <div class="h-4 w-28 eco-skeleton rounded"></div>
                  <div class="h-3 w-20 eco-skeleton rounded"></div>
                </div>
              </div>
              <div class="h-6 w-16 rounded-full eco-skeleton"></div>
            </div>

            <div class="grid grid-cols-2 gap-2.5 pt-2">
              <div class="p-2.5 rounded-xl bg-gray-50/50 dark:bg-slate-900/50 border border-gray-100 dark:border-white/5 space-y-1.5">
                <div class="h-2.5 w-12 eco-skeleton rounded"></div>
                <div class="h-4 w-16 eco-skeleton rounded"></div>
              </div>
              <div class="p-2.5 rounded-xl bg-gray-50/50 dark:bg-slate-900/50 border border-gray-100 dark:border-white/5 space-y-1.5">
                <div class="h-2.5 w-12 eco-skeleton rounded"></div>
                <div class="h-4 w-16 eco-skeleton rounded"></div>
              </div>
            </div>

            <div class="flex items-center justify-between pt-1 border-t border-gray-100 dark:border-white/5">
              <div class="h-3 w-24 eco-skeleton rounded"></div>
              <div class="h-3 w-16 eco-skeleton rounded"></div>
            </div>
          </div>
        `;
      }
      el.innerHTML = html;
    },

    /**
     * Render Aircon Unit card skeletons (Dashboard & Remote grids)
     */
    renderAirconGridSkeleton(containerOrId, options = {}) {
      const el = getEl(containerOrId);
      if (!el) return;

      const count = options.count || 4;
      let html = '';
      for (let i = 0; i < count; i++) {
        html += `
          <div class="p-4 rounded-2xl bg-white/40 dark:bg-[#0c1427]/80 border border-gray-200/80 dark:border-white/10 shadow-sm space-y-3">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl eco-skeleton"></div>
                <div class="space-y-1.5">
                  <div class="h-4 w-32 eco-skeleton rounded"></div>
                  <div class="h-2.5 w-20 eco-skeleton rounded"></div>
                </div>
              </div>
              <div class="h-6 w-16 rounded-full eco-skeleton"></div>
            </div>

            <div class="flex items-baseline justify-between pt-2">
              <div class="h-8 w-16 eco-skeleton rounded-lg"></div>
              <div class="h-4 w-24 eco-skeleton rounded"></div>
            </div>

            <div class="pt-2 border-t border-gray-100 dark:border-white/5 flex items-center justify-between">
              <div class="h-3 w-20 eco-skeleton rounded"></div>
              <div class="h-7 w-20 eco-skeleton rounded-lg"></div>
            </div>
          </div>
        `;
      }
      el.innerHTML = html;
    },

    /**
     * Render 4-card KPI metric strip skeletons
     */
    renderKpiStripSkeleton(containerOrId, options = {}) {
      const el = getEl(containerOrId);
      if (!el) return;

      const count = options.count || 4;
      let html = '';
      for (let i = 0; i < count; i++) {
        html += `
          <div class="glass-surface-soft p-4 rounded-xl border border-gray-200/60 dark:border-white/5 space-y-2">
            <div class="h-3 w-24 eco-skeleton rounded"></div>
            <div class="flex items-baseline justify-between">
              <div class="h-7 w-16 eco-skeleton rounded-md"></div>
              <div class="h-4 w-12 eco-skeleton rounded-full"></div>
            </div>
          </div>
        `;
      }
      el.innerHTML = html;
    },

    /**
     * Render Chart container skeleton with shimmer outline and bar indicators
     */
    renderChartSkeleton(containerOrId, options = {}) {
      const el = getEl(containerOrId);
      if (!el) return;

      const height = options.height || 260;
      el.innerHTML = `
        <div class="w-full rounded-2xl bg-white/30 dark:bg-[#0c1427]/60 border border-gray-200/60 dark:border-white/5 p-5 flex flex-col justify-between" style="min-height: ${height}px;">
          <div class="flex items-center justify-between mb-4">
            <div class="space-y-1.5">
              <div class="h-4 w-36 eco-skeleton rounded"></div>
              <div class="h-2.5 w-48 eco-skeleton rounded"></div>
            </div>
            <div class="h-7 w-24 rounded-lg eco-skeleton"></div>
          </div>
          
          <div class="flex items-end justify-between gap-3 h-36 px-4 pt-6">
            <div class="w-full h-16 eco-skeleton rounded-t"></div>
            <div class="w-full h-24 eco-skeleton rounded-t"></div>
            <div class="w-full h-20 eco-skeleton rounded-t"></div>
            <div class="w-full h-32 eco-skeleton rounded-t"></div>
            <div class="w-full h-28 eco-skeleton rounded-t"></div>
            <div class="w-full h-36 eco-skeleton rounded-t"></div>
            <div class="w-full h-22 eco-skeleton rounded-t"></div>
          </div>

          <div class="flex items-center justify-between pt-3 border-t border-gray-100 dark:border-white/5 mt-4">
            <div class="h-2.5 w-16 eco-skeleton rounded"></div>
            <div class="h-2.5 w-16 eco-skeleton rounded"></div>
            <div class="h-2.5 w-16 eco-skeleton rounded"></div>
          </div>
        </div>
      `;
    },

    /**
     * Render notification item list skeletons
     */
    renderNotificationListSkeleton(containerOrId, options = {}) {
      const el = getEl(containerOrId);
      if (!el) return;

      const count = options.count || 5;
      let html = '';
      for (let i = 0; i < count; i++) {
        html += `
          <div class="p-4 rounded-2xl bg-white/40 dark:bg-[#0c1427]/60 border border-gray-200/80 dark:border-white/5 flex items-start gap-3.5">
            <div class="w-10 h-10 rounded-xl eco-skeleton shrink-0"></div>
            <div class="flex-1 space-y-2">
              <div class="flex items-center justify-between">
                <div class="h-4 w-40 eco-skeleton rounded"></div>
                <div class="h-3 w-16 eco-skeleton rounded"></div>
              </div>
              <div class="h-3 w-3/4 eco-skeleton rounded"></div>
              <div class="h-2.5 w-1/2 eco-skeleton rounded"></div>
            </div>
          </div>
        `;
      }
      el.innerHTML = html;
    },

    /**
     * Render sidebar room list skeletons
     */
    renderRoomListSkeleton(containerOrId, options = {}) {
      const el = getEl(containerOrId);
      if (!el) return;

      const count = options.count || 4;
      let html = '';
      for (let i = 0; i < count; i++) {
        html += `
          <div class="p-3 rounded-xl bg-white/40 dark:bg-[#0c1328]/40 border border-gray-200/60 dark:border-white/5 flex items-center justify-between gap-3">
            <div class="flex items-center gap-2.5 min-w-0 flex-1">
              <div class="w-8 h-8 rounded-lg eco-skeleton shrink-0"></div>
              <div class="space-y-1.5 flex-1 min-w-0">
                <div class="h-3.5 w-24 eco-skeleton rounded"></div>
                <div class="h-2.5 w-16 eco-skeleton rounded"></div>
              </div>
            </div>
            <div class="h-5 w-8 rounded-full eco-skeleton"></div>
          </div>
        `;
      }
      el.innerHTML = html;
    },

    /**
     * Render KPI metric stat card skeletons
     */
    renderStatsSkeleton(containerOrId, options = {}) {
      const el = getEl(containerOrId);
      if (!el) return;

      const count = options.count || 4;
      let html = '';
      for (let i = 0; i < count; i++) {
        html += `
          <div class="bg-white/40 dark:bg-[#0c1328]/60 border border-gray-200 dark:border-white/10 rounded-xl p-3.5 shadow-sm space-y-2">
            <div class="h-3 w-16 eco-skeleton rounded"></div>
            <div class="flex items-baseline justify-between">
              <div class="h-6 w-12 eco-skeleton rounded"></div>
              <div class="h-3 w-10 eco-skeleton rounded"></div>
            </div>
          </div>
        `;
      }
      el.innerHTML = html;
    },

    /**
     * Render Profile Information & Activity Skeletons
     */
    renderProfileSkeleton(containerOrId) {
      const el = getEl(containerOrId);
      if (!el) return;

      el.innerHTML = `
        <div class="p-6 rounded-2xl bg-white/40 dark:bg-[#0c1427]/60 border border-gray-200/60 dark:border-white/5 space-y-6">
          <div class="flex items-center gap-4 pb-6 border-b border-gray-100 dark:border-white/5">
            <div class="w-16 h-16 rounded-2xl eco-skeleton shrink-0"></div>
            <div class="space-y-2 flex-1">
              <div class="h-5 w-40 eco-skeleton rounded"></div>
              <div class="h-3.5 w-24 eco-skeleton rounded"></div>
            </div>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="space-y-2">
              <div class="h-3 w-20 eco-skeleton rounded"></div>
              <div class="h-10 w-full eco-skeleton rounded-xl"></div>
            </div>
            <div class="space-y-2">
              <div class="h-3 w-20 eco-skeleton rounded"></div>
              <div class="h-10 w-full eco-skeleton rounded-xl"></div>
            </div>
          </div>
        </div>
      `;
    },

    /**
     * Render Timetable / Scheduler grid skeleton
     */
    renderTimetableSkeleton(containerOrId, options = {}) {
      const el = getEl(containerOrId);
      if (!el) return;

      const rows = options.rows || 7;
      let html = '';
      for (let r = 0; r < rows; r++) {
        html += `
          <tr class="border-b border-gray-100 dark:border-white/5">
            <td class="py-3 px-4 w-28">
              <div class="h-3.5 w-20 eco-skeleton rounded"></div>
            </td>
            <td class="py-3 px-4">
              <div class="flex items-center gap-2">
                <div class="h-6 w-24 rounded-lg eco-skeleton"></div>
                <div class="h-6 w-32 rounded-lg eco-skeleton"></div>
              </div>
            </td>
            <td class="py-3 px-4 w-24 text-right">
              <div class="h-6 w-16 rounded-md eco-skeleton inline-block"></div>
            </td>
          </tr>
        `;
      }
      el.innerHTML = html;
    },

    // --------------------------------------------------------------------------
    // EVENT-DRIVEN SKELETON BINDER
    // --------------------------------------------------------------------------
    /**
     * Decoupled binder that automatically attaches skeleton to container during
     * query lifecycle, and swaps in real content with an opacity transition.
     * 
     * @param {Object} config
     *   - key: string (query key on EcoDataBus)
     *   - container: string | HTMLElement
     *   - renderSkeleton: Function(container)
     *   - renderContent: Function(container, data)
     *   - renderError: Function(container, error) [optional]
     */
    bind({ key, container, renderSkeleton, renderContent, renderError, retry }) {
      const el = getEl(container, false);
      if (!el) return () => {};

      const dataBus = window.EcoDataBus;

      // 1. Initial State: Check if data is already cached
      let hasContent = dataBus && dataBus.getCached(key) !== null;
      if (hasContent) {
        const cached = dataBus.getCached(key);
        el.classList.add('eco-content-fade-in');
        renderContent(el, cached);
      } else {
        // Show skeleton immediately
        renderSkeleton(el);
      }

      if (!dataBus) return () => {};

      // 2. Subscribe to query lifecycle events
      const unsub = dataBus.onQuery(key, {
        onStart: ({ isBackground }) => {
          el.setAttribute('aria-busy', 'true');
          // Only show skeleton if not doing a silent background revalidation
          if (!isBackground && !hasContent) {
            renderSkeleton(el);
          }
        },
        onSuccess: ({ data }) => {
          hasContent = true;
          el.setAttribute('aria-busy', 'false');
          el.classList.remove('eco-content-fade-in');
          // Force reflow for smooth fade-in
          void el.offsetWidth;
          el.classList.add('eco-content-fade-in');
          renderContent(el, data);
        },
        onCancel: () => el.setAttribute('aria-busy', 'false'),
        onError: ({ error }) => {
          el.setAttribute('aria-busy', 'false');
          if (hasContent) {
            window.EcoToast?.warning('Refresh failed. Showing previously loaded data; retry to update.');
            return;
          }
          if (renderError) {
            renderError(el, error);
          } else {
            const message = document.createElement('p');
            message.className = 'p-4 text-sm text-rose-500';
            message.setAttribute('role', 'alert');
            message.textContent = `Unable to load ${key}. ${error?.message || 'Please retry.'}`;
            const button = document.createElement('button');
            button.type = 'button'; button.className = 'px-4 py-2 text-sm text-emerald-600';
            button.textContent = 'Retry loading';
            button.addEventListener('click', () => retry ? retry() : window.location.reload());
            el.replaceChildren(message, button);
          }
        }
      });

      return unsub;
    }
  };

  window.EcoTrackSkeletons = EcoTrackSkeletons;
})(window);
