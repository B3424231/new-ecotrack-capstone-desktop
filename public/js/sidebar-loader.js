// Early Theme Initialization (prevents flash of light theme)
(function() {
  const currentTheme = localStorage.getItem('ecoTrackTheme');
  if (currentTheme === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
})();

// Listen for storage changes to sync tabs in real time
window.addEventListener('storage', (e) => {
  if (e.key === 'ecoTrackTheme') {
    if (e.newValue === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    window.dispatchEvent(new CustomEvent('theme:changed', { detail: e.newValue }));
  }
});

// Ensure EcoNetwork, EcoDataBus, and EcoTrackSkeletons are globally loaded on every page
if (!window.EcoNetwork) {
  const netScript = document.createElement('script');
  netScript.src = './js/eco-network.js';
  (document.head || document.documentElement).appendChild(netScript);
}
if (!window.EcoDataBus) {
  const busScript = document.createElement('script');
  busScript.src = './js/eco-data-bus.js';
  (document.head || document.documentElement).appendChild(busScript);
}
if (!window.EcoTrackSkeletons) {
  const skelScript = document.createElement('script');
  skelScript.src = './js/skeletons.js';
  (document.head || document.documentElement).appendChild(skelScript);
}

// Style all visible selects while retaining native values, forms and change events.
if (!window.EcoTrackSelectControls && !document.querySelector('script[data-eco-selects]')) {
  const selectScript = document.createElement('script');
  selectScript.src = './js/select-controls.js?v=3';
  selectScript.dataset.ecoSelects = 'true';
  (document.head || document.documentElement).appendChild(selectScript);
}

// ===== SIDEBAR LOADER =====
// This script loads and injects the sidebar from sidebar-template.html into any page

// Create a sleek, non-blocking top progress bar (NO full-screen blackout, NO blocking spinner)
if (!document.getElementById('eco-loader')) {
  const loader = document.createElement('div');
  loader.id = 'eco-loader';
  loader.innerHTML = '<div class="eco-loader-bar"></div>';
  (document.body || document.documentElement).appendChild(loader);

  const style = document.createElement('style');
  style.id = 'eco-loader-style';
  style.textContent = `
    #eco-loader {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      z-index: 999999;
      pointer-events: none;
      background: transparent;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.12s ease, visibility 0.12s ease;
    }
    .eco-loader-bar {
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #10b981, #06b6d4, #10b981);
      box-shadow: 0 0 10px rgba(16, 185, 129, 0.7);
      transition: width 0.15s ease-out;
    }
  `;
  if (document.head) document.head.appendChild(style);
}

function showLoader() {
  const loader = document.getElementById('eco-loader');
  if (!loader) return;
  const bar = loader.querySelector('.eco-loader-bar');
  if (bar) {
    bar.style.transition = 'width 0.15s ease-out';
    bar.style.width = '70%';
  }
  loader.style.opacity = '1';
  loader.style.visibility = 'visible';
}

function hideLoader() {
  const loader = document.getElementById('eco-loader');
  if (!loader) return;
  const bar = loader.querySelector('.eco-loader-bar');
  if (bar) {
    bar.style.transition = 'width 0.08s ease-out';
    bar.style.width = '100%';
  }
  setTimeout(() => {
    loader.style.opacity = '0';
    loader.style.visibility = 'hidden';
    setTimeout(() => {
      if (bar) {
        bar.style.transition = 'none';
        bar.style.width = '0%';
      }
    }, 120);
  }, 60);
}

// Add click listener for snappy top progress on navigation
document.addEventListener('click', (e) => {
  const link = e.target.closest('a');
  if (!link || !link.href) return;
  
  const href = link.getAttribute('href');
  if (!href || href === '#' || href.startsWith('javascript:') || link.target === '_blank' || link.hasAttribute('download')) {
    return;
  }

  // Skip if same page
  const currentPath = (window.location.pathname || '').split('/').pop() || 'index.html';
  const targetPath = href.split('?')[0].split('#')[0].split('/').pop();
  if (targetPath && targetPath === currentPath && !href.includes('?')) {
    return;
  }

  showLoader();
});

let sidebarLoaded = false;

// Align to an explicit page divider, otherwise to the full responsive header.
let shellHeaderResizeObserver = null;
function alignShellHeaderBorders() {
  shellHeaderResizeObserver?.disconnect();
  const header = document.querySelector('main > header');
  const sidebar = document.getElementById('sidebar');
  const sidebarHeader = sidebar?.querySelector('.sidebar-header');
  if (!header || !sidebarHeader) return;
  const divider = header.querySelector('[data-sidebar-divider="top"]');
  const update = () => {
    const dividerBottom = divider
      ? divider.getBoundingClientRect().top + parseFloat(getComputedStyle(divider).borderTopWidth)
      : header.getBoundingClientRect().bottom;
    const height = dividerBottom - sidebarHeader.getBoundingClientRect().top;
    if (height > 0) sidebar.style.setProperty('--eco-page-header-height', height + 'px');
  };
  update();
  if (typeof ResizeObserver === 'function') {
    shellHeaderResizeObserver = new ResizeObserver(update);
    shellHeaderResizeObserver.observe(header);
    if (divider) shellHeaderResizeObserver.observe(divider);
  }
}
window.addEventListener('page:init', alignShellHeaderBorders);
window.addEventListener('resize', alignShellHeaderBorders);
window.addEventListener('beforeunload', () => shellHeaderResizeObserver?.disconnect());

function initSidebarModules() {
  window.EcoTrackMode?.apply();
  alignShellHeaderBorders();
  if (typeof initializeSidebar !== 'undefined') initializeSidebar();
  if (typeof initializeSidebarToggle !== 'undefined') initializeSidebarToggle();
  if (typeof initializeLogout !== 'undefined') initializeLogout();
  if (typeof initializeSidebarTooltips !== 'undefined') initializeSidebarTooltips();
  if (document.body?.matches('.sensor-sidebar-open,.workspace-sidebar-open')) {
    document.getElementById('sidebar')?.classList.remove('collapsed');
  }

  // Load Global Notifications if needed
  if (typeof updateGlobalNotificationBadge === 'undefined' && !document.querySelector('script[src*="global-notifications.js"]')) {
    const notifScript = document.createElement('script');
    notifScript.src = './js/global-notifications.js';
    notifScript.onload = () => {
      if (typeof updateGlobalNotificationBadge !== 'undefined') updateGlobalNotificationBadge();
    };
    document.head.appendChild(notifScript);
  } else if (typeof updateGlobalNotificationBadge !== 'undefined') {
    updateGlobalNotificationBadge();
  }

  // Load Maintenance Modal if needed
  if (!window.EcoTrackMaintenance && !document.querySelector('script[src*="maintenance-modal.js"]')) {
    const maintScript = document.createElement('script');
    maintScript.src = './js/maintenance-modal.js';
    document.head.appendChild(maintScript);
  }
}

async function loadSidebar() {
  try {
    // Check if sidebar is already present in DOM
    if (sidebarLoaded || document.querySelector('aside#sidebar') || document.querySelector('aside.w-64')) {
      initSidebarModules();
      hideLoader();
      return;
    }

    const mainContainer = document.querySelector('#sidebar-container') ||
                          document.querySelector('.app-shell > .flex') ||
                          document.querySelector('body > .flex') ||
                          document.querySelector('.flex:not(body)') ||
                          document.querySelector('.flex');

    if (!mainContainer || mainContainer === document.body) {
      hideLoader();
      return;
    }

    // 1. Instant Synchronous Cache Check with versioning (0ms render!)
    const SIDEBAR_VERSION = 'v24-register-ac-devices';
    const cachedVer = sessionStorage.getItem('ecoTrack_sidebar_ver');
    const cachedHTML = sessionStorage.getItem('ecoTrack_sidebar_html');
    if (cachedHTML && cachedVer === SIDEBAR_VERSION) {
      mainContainer.insertAdjacentHTML('afterbegin', cachedHTML);
      sidebarLoaded = true;
      initSidebarModules();
      hideLoader();
      return;
    }

    // 2. Fetch fresh sidebar-template.html if not cached or version mismatch
    const response = await fetch(`./sidebar-template.html?v=${SIDEBAR_VERSION}`);
    if (response.ok) {
      const sidebarHTML = await response.text();
      try {
        sessionStorage.setItem('ecoTrack_sidebar_ver', SIDEBAR_VERSION);
        sessionStorage.setItem('ecoTrack_sidebar_html', sidebarHTML);
      } catch (_) {}
      mainContainer.insertAdjacentHTML('afterbegin', sidebarHTML);
      sidebarLoaded = true;
      initSidebarModules();
    }
  } catch (error) {
    console.warn('Sidebar load error:', error);
  } finally {
    hideLoader();
  }
}

// FAILSAFE: Ensure top bar is ALWAYS hidden quickly (max 300ms)
setTimeout(hideLoader, 300);

// Load sidebar when DOM is ready (or immediately if already parsed)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadSidebar);
} else {
  loadSidebar();
}
