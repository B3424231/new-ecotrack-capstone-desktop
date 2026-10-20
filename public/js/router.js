// ===== ECOTRACK PJAX ROUTER =====
// Intercepts link clicks to fetch new content and replace <main> without reloading the sidebar.

(function() {
  if (window.__pjaxRouterInitialized) return;
  window.__pjaxRouterInitialized = true;

  // 1. Create top loading bar
  const loadingBar = document.createElement('div');
  loadingBar.id = 'pjax-loading-bar';
  Object.assign(loadingBar.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '0%',
    height: '3px',
    background: 'linear-gradient(90deg, #18392B, #10b981)',
    boxShadow: '0 0 10px #10b981',
    zIndex: '99999',
    transition: 'width 0.3s ease, opacity 0.3s ease',
    opacity: '0',
    pointerEvents: 'none'
  });
  document.body.appendChild(loadingBar);

  let loadInterval;
  
  function startLoading() {
    clearInterval(loadInterval);
    loadingBar.style.opacity = '1';
    loadingBar.style.width = '0%';
    
    let width = 0;
    loadInterval = setInterval(() => {
      width += (100 - width) * 0.1; // Ease towards 100%
      loadingBar.style.width = width + '%';
    }, 100);
  }

  function finishLoading() {
    clearInterval(loadInterval);
    loadingBar.style.width = '100%';
    setTimeout(() => {
      loadingBar.style.opacity = '0';
      setTimeout(() => {
        loadingBar.style.width = '0%';
      }, 300);
    }, 300);
  }

  // 2. Fetch and swap content
  async function navigateTo(url, pushState = true) {
    startLoading();
    
    try {
      // Clean up before navigating away
      window.dispatchEvent(new Event('page:leave'));

      const response = await fetch(url);
      if (!response.ok) throw new Error('Network response was not ok');
      const htmlString = await response.text();
      
      const parser = new DOMParser();
      const newDoc = parser.parseFromString(htmlString, 'text/html');
      
      const newMain = newDoc.querySelector('main');
      const newTitle = newDoc.querySelector('title');
      
      if (newMain) {
        const currentMain = document.querySelector('main');
        if (currentMain) {
          // Replace content
          currentMain.parentNode.replaceChild(newMain, currentMain);
          
          if (newTitle) {
            document.title = newTitle.textContent;
          }

          if (pushState) {
            try {
              window.history.pushState({ url: url }, '', url);
            } catch (err) {
              console.warn('history.pushState failed (expected on file:// protocol)', err);
            }
          }

          updateSidebarActiveState(url);

          // Find and load any missing scripts (e.g. analytics.js, logs.js)
          const currentScripts = Array.from(document.querySelectorAll('script')).map(s => s.getAttribute('src')).filter(Boolean);
          const newScripts = Array.from(newDoc.querySelectorAll('script')).filter(s => s.getAttribute('src'));
          
          let scriptsLoadedCount = 0;
          let scriptsToLoad = 0;

          newScripts.forEach(script => {
            const src = script.getAttribute('src');
            if (src && !currentScripts.includes(src)) {
              scriptsToLoad++;
              const newScript = document.createElement('script');
              newScript.src = src;
              newScript.onload = () => {
                scriptsLoadedCount++;
                if (scriptsLoadedCount === scriptsToLoad) {
                  window.dispatchEvent(new Event('page:init'));
                }
              };
              document.body.appendChild(newScript);
            }
          });
          
          // Re-initialize scripts for the new page if no new scripts needed loading
          if (scriptsToLoad === 0) {
            setTimeout(() => {
              window.dispatchEvent(new Event('page:init'));
            }, 10);
          }
        } else {
          // Fallback if no <main> tag found
          window.location.href = url;
        }
      } else {
        // Fallback
        window.location.href = url;
      }
    } catch (error) {
      console.error('PJAX navigation failed:', error);
      window.location.href = url; // Fallback to hard load
    } finally {
      finishLoading();
    }
  }

  // 3. Update active link in sidebar
  function updateSidebarActiveState(url) {
    const currentPath = new URL(url, window.location.href).pathname.split('/').pop();
    
    const sidebarLinks = document.querySelectorAll('.sidebar-nav a, [aria-label="Quick links"] a');
    sidebarLinks.forEach(link => {
      const linkPath = link.getAttribute('href');
      // Simple path matching
      if (linkPath === currentPath) {
        // We know what active sidebar links look like: bg-slate-800 border-cyan-500
        if (link.closest('.sidebar-nav')) {
          link.classList.add('bg-slate-800', 'border-l-4', 'border-cyan-500', 'text-white');
          link.classList.remove('text-gray-400', 'border-l-4', 'border-transparent');
        }
      } else {
        if (link.closest('.sidebar-nav')) {
          link.classList.remove('bg-slate-800', 'border-l-4', 'border-cyan-500', 'text-white');
          link.classList.add('text-gray-400', 'border-l-4', 'border-transparent');
        }
      }
    });
  }

  // 4. Listeners
  document.addEventListener('click', (e) => {
    // Find closest anchor tag
    const link = e.target.closest('a');
    
    if (!link) return;
    if (link.hasAttribute('download') || link.getAttribute('target') === '_blank') return;
    
    // Check if it's a relative link or same origin
    const url = link.href;
    let isLocal = false;
    
    try {
      const targetUrl = new URL(url);
      isLocal = (targetUrl.origin === window.location.origin) || 
                (window.location.protocol === 'file:' && targetUrl.protocol === 'file:');
    } catch (e) {}
    
    if (isLocal && !url.includes('#')) {
      e.preventDefault();
      navigateTo(url);
    }
  });

  window.addEventListener('popstate', (e) => {
    if (e.state && e.state.url) {
      navigateTo(e.state.url, false);
    } else {
      navigateTo(window.location.href, false);
    }
  });

  // Initial trigger for the first load
  window.addEventListener('DOMContentLoaded', () => {
    updateSidebarActiveState(window.location.href);
    window.dispatchEvent(new Event('page:init'));
  });

})();
