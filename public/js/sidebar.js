// ===== SIDEBAR NAVIGATION =====
function initializeSidebar() {
  let currentFile = (window.location.pathname.split('/').pop() || '').toLowerCase();
  if (!currentFile || currentFile === 'index.html') {
    currentFile = 'dashboard.html';
  }

  // Setup nav links styling only - let anchor tags handle navigation naturally
  const navLinks = document.querySelectorAll('.nav-link');
  navLinks.forEach(link => {
    const href = link.getAttribute('href');
    let hrefFile = (href || '').split('/').pop().toLowerCase();
    hrefFile = hrefFile.split('?')[0].split('#')[0];
    
    // Determine if this is the active link
    const isActive = currentFile && hrefFile === currentFile;

    if (isActive) {
      link.classList.add('active');
      link.classList.remove('hover:bg-slate-700/50', 'text-gray-300', 'text-cyan-400');
    } else {
      link.classList.remove('active', 'bg-emerald-500/20', 'border-emerald-400/50', 'text-white');
    }

    link.addEventListener('click', (e) => {
      if (!href || href === '#' || href.startsWith('#')) {
        e.preventDefault();
        return;
      }
      const targetFile = (href || '').split('/').pop().toLowerCase().split('?')[0].split('#')[0];
      if (targetFile === currentFile) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      window.location.href = href;
    });
  });
}

// ===== SIDEBAR TOGGLE FUNCTIONALITY =====
function initializeSidebarToggle() {
  const sidebar = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('sidebarToggle');

  if (!sidebar || !toggleBtn) return;

  // Disable transitions during page load
  sidebar.classList.add('sidebar-no-anim');

  // Restore sidebar state from localStorage on page load (no animation)
  const isSidebarCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';
  if (isSidebarCollapsed) {
    sidebar.classList.add('collapsed');
  } else {
    sidebar.classList.remove('collapsed');
  }

  // Enable transitions after state is restored
  setTimeout(() => {
    sidebar.classList.remove('sidebar-no-anim');
  }, 100);

  // Toggle functionality for hamburger button (with animation)
  toggleBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    sidebar.classList.toggle('collapsed');
    // Save the state to localStorage
    localStorage.setItem('sidebarCollapsed', sidebar.classList.contains('collapsed'));
  });
}

// ===== LOGOUT FUNCTIONALITY =====
function initializeLogout() {
  const logoutButton = document.getElementById('logoutButton');
  const logoutModal = document.getElementById('logoutModal');
  const logoutCancel = document.getElementById('logoutCancel');
  const logoutConfirm = document.getElementById('logoutConfirm');

  if (!logoutButton || !logoutModal) return;

  // Show logout confirmation modal
  logoutButton.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    logoutModal.style.display = 'flex';
  });

  // Cancel logout
  logoutCancel.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    logoutModal.style.display = 'none';
  });

  // Confirm logout
  logoutConfirm.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Save analytics snapshot before logging out
    try {
      const dateKey = new Date().toISOString().split('T')[0];
      await fetch(`http://127.0.0.1:5000/api/analytics/snapshot?date=${dateKey}`, { method: 'POST' });
      console.log('Snapshot saved successfully on logout');
    } catch(err) {
      console.error('Failed to save snapshot on logout:', err);
    }
    
    // Clear authentication data and Supabase session
    try {
      const sb = window.supabaseClient || window.sb;
      if (sb && sb.auth && typeof sb.auth.signOut === 'function') {
        await sb.auth.signOut();
      }
    } catch (_) {}

    localStorage.removeItem('userToken');
    localStorage.removeItem('ecoTrack_auth_token');
    localStorage.removeItem('ecoTrack_profile_user');
    localStorage.removeItem('sidebarCollapsed');
    sessionStorage.clear();
    
    // Redirect to login page
    window.location.href = 'login.html';
  });

  // Close modal when clicking outside of it
  logoutModal.addEventListener('click', (e) => {
    if (e.target === logoutModal) {
      logoutModal.style.display = 'none';
    }
  });
}

// ===== SIDEBAR COLLAPSED TOOLTIPS =====
function initializeSidebarTooltips() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  let tooltip = document.getElementById('ecoTrackSidebarTooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'ecoTrackSidebarTooltip';
    document.body.appendChild(tooltip);
  }

  const hideTooltip = () => {
    tooltip.classList.remove('visible');
  };

  const showTooltip = (el) => {
    if (!sidebar.classList.contains('collapsed')) {
      hideTooltip();
      return;
    }

    const text = el.getAttribute('data-tooltip') || 
                 el.querySelector('span:not(.notif-badge)')?.textContent?.trim() || 
                 el.getAttribute('title') || 
                 '';
    if (!text) {
      hideTooltip();
      return;
    }

    tooltip.textContent = text;
    const rect = el.getBoundingClientRect();
    
    // Position vertically centered, 12px to the right of the button
    const top = rect.top + (rect.height / 2);
    const left = rect.right + 12;

    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
    tooltip.classList.add('visible');
  };

  // Find all interactive items in the sidebar
  const items = sidebar.querySelectorAll('.nav-link, #sidebarToggle, #logoutButton');
  items.forEach(item => {
    // Populate data-tooltip if missing
    if (!item.hasAttribute('data-tooltip')) {
      const spanText = item.querySelector('span:not(.notif-badge)')?.textContent?.trim();
      if (spanText) {
        item.setAttribute('data-tooltip', spanText);
      } else if (item.id === 'sidebarToggle') {
        item.setAttribute('data-tooltip', 'Toggle Sidebar');
      }
    }

    item.addEventListener('mouseenter', () => showTooltip(item));
    item.addEventListener('mouseleave', hideTooltip);
  });

  // Hide tooltip when scrolling or clicking or resizing
  window.addEventListener('scroll', hideTooltip, { passive: true });
  window.addEventListener('resize', hideTooltip, { passive: true });
  document.addEventListener('click', hideTooltip);
}

document.addEventListener('DOMContentLoaded', () => {
  initializeSidebar();
  initializeSidebarToggle();
  initializeLogout();
  initializeSidebarTooltips();
});
