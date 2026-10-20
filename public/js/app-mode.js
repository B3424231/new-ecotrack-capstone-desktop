// Local workspace preference. This never sends commands or changes device operation.
(function () {
  'use strict';
  const key = 'ecoTrack_workspace_mode';
  const labels = { controller: 'Controller mode', monitoring: 'Monitoring mode', both: 'Both modes' };
  const controllerPages = new Set(['dashboard.html', 'control.html', 'aircons.html', 'ir-library.html', 'logs.html']);
  const monitoringPages = new Set(['analytics.html', 'telemetry.html', 'sensor-logs.html']);
  const valid = value => Object.hasOwn(labels, value);
  const filename = value => new URL(value, location.href).pathname.split('/').pop().toLowerCase();
  let mode = 'both', busy = false, queued = null;
  try { const stored = localStorage.getItem(key); if (valid(stored)) mode = stored; } catch (_) {}
  const root = document.documentElement;
  root.dataset.ecoMode = mode;
  const style = document.createElement('style');
  style.textContent = 'html[data-eco-mode="monitoring"] [data-eco-mode="controller"],html[data-eco-mode="controller"] [data-eco-mode="monitoring"]{display:none!important}html.eco-mode-redirecting body{visibility:hidden!important}';
  document.head.appendChild(style);
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = './css/app-mode.css?v=3'; document.head.appendChild(css);

  function allowsPage(value, page) {
    return valid(value) && !(value === 'monitoring' && controllerPages.has(page)) && !(value === 'controller' && monitoringPages.has(page));
  }
  function home(value = mode) { return value === 'monitoring' ? 'analytics.html' : 'dashboard.html'; }
  function redirect() {
    if (allowsPage(mode, filename(location.href))) return false;
    root.classList.add('eco-mode-redirecting');
    location.replace(new URL(home(), location.href).href);
    return true;
  }
  function apply() {
    root.dataset.ecoMode = mode;
    document.querySelectorAll('a[href]').forEach(link => {
      let url; try { url = new URL(link.getAttribute('href'), location.href); } catch (_) { return; }
      if (url.protocol !== location.protocol || url.host !== location.host) return;
      const page = filename(url.href);
      if (controllerPages.has(page)) link.dataset.ecoMode = 'controller';
      else if (monitoringPages.has(page)) link.dataset.ecoMode = 'monitoring';
      else if (page === 'nodes.html') delete link.dataset.ecoMode;
    });
    const registration = document.querySelector('#sidebarNav a[href="nodes.html"]');
    const section = document.getElementById(mode === 'monitoring' ? 'systemLogsSection' : 'deviceRegistrationSection');
    if (registration && section && section.nextElementSibling !== registration) section.insertAdjacentElement('afterend', registration);
    document.querySelectorAll('[data-workspace-label]').forEach(el => { el.textContent = labels[mode]; });
    document.querySelectorAll('[data-select-mode]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.selectMode === mode));
      button.disabled = busy;
      const state = button.querySelector('[data-mode-state]');
      if (state) state.textContent = button.dataset.selectMode === mode ? 'Active' : 'Select mode';
    });
  }
  function modal() {
    let dialog = document.getElementById('workspaceProcessing');
    if (dialog) return dialog;
    dialog = document.createElement('dialog'); dialog.id = 'workspaceProcessing'; dialog.className = 'workspace-processing';
    dialog.setAttribute('aria-labelledby', 'workspaceProcessingTitle'); dialog.setAttribute('aria-describedby', 'workspaceProcessingDetail');
    dialog.innerHTML = '<div class="workspace-spinner" aria-hidden="true"></div><h2 id="workspaceProcessingTitle" tabindex="-1">Preparing your workspace</h2><p id="workspaceProcessingDetail" role="status" aria-live="polite"></p><button type="button" class="workspace-button" id="workspaceProcessingClose" hidden>Close</button>';
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.querySelector('button').addEventListener('click', () => dialog.close());
    document.body.appendChild(dialog); return dialog;
  }
  async function setMode(value, { external = false } = {}) {
    if (!valid(value)) throw new Error('Choose Controller, Monitoring, or Both.');
    if (!document.body) await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    if (busy) { queued = { value, external }; return; }
    busy = true;
    const previous = mode, focus = document.activeElement, dialog = modal();
    dialog.classList.remove('failed'); dialog.querySelector('button').hidden = true;
    dialog.querySelector('h2').textContent = 'Preparing ' + labels[value].toLowerCase();
    dialog.querySelector('p').textContent = value === 'both' ? 'Preparing controller and sensor monitoring navigation…' : value === 'monitoring' ? 'Preparing sensor analytics, telemetry, and logs…' : 'Preparing AC controls, schedules, and forecasts…';
    apply(); dialog.showModal(); dialog.querySelector('h2').focus();
    try {
      // Give the requested preparation dialog time to paint; no cloud work is needed.
      await new Promise(resolve => setTimeout(resolve, 650));
      if (!external) {
        localStorage.setItem(key, value);
        if (localStorage.getItem(key) !== value) throw new Error('Mode was not saved.');
      } else {
        const latest = localStorage.getItem(key);
        value = valid(latest) ? latest : 'both';
      }
      mode = value; apply();
      window.dispatchEvent(new CustomEvent('workspace:changed', { detail: { mode } }));
      const status = document.getElementById('workspaceStatus');
      if (status) status.textContent = labels[mode] + ' ready.';
      dialog.close();
      if (!redirect()) focus?.focus?.();
    } catch (_) {
      mode = previous; apply();
      dialog.classList.add('failed'); dialog.querySelector('h2').textContent = 'Mode could not be saved';
      dialog.querySelector('p').textContent = 'Local settings storage is unavailable. Your previous workspace is still active. Close this dialog and try again.';
      dialog.querySelector('button').hidden = false; dialog.querySelector('button').focus();
    } finally {
      busy = false; apply();
      if (queued) {
        const next = queued; queued = null;
        if (next.external) {
          try { const latest = localStorage.getItem(key); next.value = valid(latest) ? latest : 'both'; } catch (_) {}
        }
        if (!next.external || next.value !== mode) {
          if (dialog.open) dialog.close();
          setMode(next.value, next);
        }
      }
    }
  }
  window.EcoTrackMode = Object.freeze({ get mode() { return mode; }, labels: Object.freeze(labels), home, allowsPage, apply, setMode });
  redirect();
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.querySelectorAll('[data-select-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.selectMode)));
  });
  window.addEventListener('pageshow', () => {
    let saved = mode;
    try { const value = localStorage.getItem(key); saved = valid(value) ? value : 'both'; } catch (_) {}
    if (saved !== mode) setMode(saved, { external: true });
    else { redirect(); apply(); }
  });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) {
      const value = valid(event.newValue) ? event.newValue : 'both';
      if (value !== mode || busy) setMode(value, { external: true });
    }
  });
})();
