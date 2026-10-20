(function () {
  'use strict';
  const menu = document.getElementById('profileModeMenu');
  const close = () => { document.body.classList.remove('workspace-sidebar-open'); menu.setAttribute('aria-expanded', 'false'); };
  menu.addEventListener('click', () => {
    const open = document.body.classList.toggle('workspace-sidebar-open');
    if (open) document.getElementById('sidebar')?.classList.remove('collapsed');
    menu.setAttribute('aria-expanded', String(open));
  });
  document.getElementById('profileModeBackdrop').addEventListener('click', close);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !document.querySelector('dialog[open]')) { close(); menu.focus(); } });
  window.addEventListener('resize', () => { if (innerWidth > 760) { close(); document.getElementById('sidebar')?.classList.toggle('collapsed', localStorage.getItem('sidebarCollapsed') === 'true'); } });
})();
