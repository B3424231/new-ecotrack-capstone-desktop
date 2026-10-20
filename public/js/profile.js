let currentUser = null;

// Role spelling is presentation only; access comes from the authenticated RPC.
function isAdministratorProfile(user) {
  if (typeof user.adminAccess === 'boolean') return user.adminAccess;
  const role = String(user.role || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  return ['admin', 'administrator', 'system administrator', 'super admin'].includes(role) ||
    String(user.userType || '').toLowerCase() === 'admin';
}

async function verifyAdministratorAccess(sb) {
  if (!sb?.rpc) return null;
  try {
    const { data, error } = await sb.rpc('ecotrack_is_admin');
    return !error && typeof data === 'boolean' ? data : null;
  } catch (_) {
    return null;
  }
}

async function loadProfileWithSWR(forceRefresh = false) {
  const sb = window.supabaseClient || window.sb;
  const localUser = JSON.parse(localStorage.getItem('ecoTrack_profile_user') || '{}');
  
  const fetchProfileData = async (signal) => {
    let merged = { ...localUser };
    if (sb) {
      try {
        // Fetch real authenticated profile via RPC
        const { data: rpcProfile, error: rpcErr } = await sb.rpc('ecotrack_my_profile');
        if (!rpcErr && rpcProfile) {
          merged = {
            ...merged,
            id: rpcProfile.id || merged.id,
            username: rpcProfile.name || rpcProfile.username || merged.username,
            name: rpcProfile.name || merged.name,
            email: rpcProfile.email || merged.email,
            role: rpcProfile.role || (rpcProfile.userType === 'staff' ? 'Staff' : 'admin'),
            userType: rpcProfile.userType || merged.userType,
            phone: rpcProfile.phone || merged.phone,
            photoUrl: rpcProfile.photoUrl || merged.photoUrl,
            avatar: rpcProfile.photoUrl || rpcProfile.avatar || merged.avatar,
            assignment: rpcProfile.assignment || merged.assignment,
          };
          return merged;
        }
      } catch (err) {
        console.warn('Profile RPC fetch warning:', err);
      }

      try {
        const { data: { user: authUser } } = await sb.auth.getUser();
        if (authUser && authUser.id) {
          const { data: adminRows } = await sb.from('administrators').select('id, username, email, role, location, created, last_login, is_active, session_timeout').eq('auth_user_id', authUser.id).maybeSingle();
          if (adminRows) {
            merged = { ...merged, ...adminRows };
          }
        }
      } catch (err) {
        console.warn('Profile Supabase fetch warning:', err);
      }
    }
    return merged;
  };

  let loadedProfile;
  if (window.EcoDataBus) {
    loadedProfile = await window.EcoDataBus.query('profile:data', fetchProfileData, {
      forceRefresh,
      ttl: 60000
    });
  } else {
    loadedProfile = await fetchProfileData();
  }

  // Verify on each load, even when the profile itself came from the cache.
  const adminAccess = await verifyAdministratorAccess(sb);
  currentUser = {
    adminAccess,
    userType: loadedProfile?.userType || localUser.userType,
    id: loadedProfile?.id || localUser.id || 'admin_default_01',
    username: loadedProfile?.username || localUser.username || 'admin',
    email: loadedProfile?.email || localUser.email || 'admin@ecotrack.local',
    role: loadedProfile?.role || localUser.role || 'admin',
    location: loadedProfile?.location || localUser.location || 'Philippines',
    avatar: localStorage.getItem('ecoTrack_avatar') || '',
    created: loadedProfile?.created || localUser.created || '2026-07-03T00:00:00Z',
    last_login: loadedProfile?.last_login || localUser.last_login || '2026-07-03T08:00:00Z',
    is_active: loadedProfile?.is_active !== undefined ? loadedProfile.is_active : true,
    session_timeout: loadedProfile?.session_timeout || localUser.session_timeout || '30 minutes'
  };

  populateProfileUI(currentUser);
}

const formatDate = (dateStr) => {
  if (!dateStr) return 'N/A';
  const options = { year: 'numeric', month: 'long', day: 'numeric' };
  return new Date(dateStr).toLocaleDateString('en-US', options);
};

const formatDateTime = (dateStr) => {
  if (!dateStr) return 'N/A';
  const options = { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  return new Date(dateStr).toLocaleDateString('en-US', options);
};

function populateProfileUI(user) {
  const roleDisplay = isAdministratorProfile(user) ? 'Administrator' : (user.role || 'User');
  const roleTitle = isAdministratorProfile(user) ? 'System Administrator' : 'System User';
  const name = user.username || 'Administrator';
  
  const profileNameEl = document.getElementById('profile-name');
  if (profileNameEl) profileNameEl.textContent = name;
  
  const roleBadgeEl = document.getElementById('profile-role-badge');
  if (roleBadgeEl) roleBadgeEl.textContent = roleTitle;
  
  const profileEmailEl = document.getElementById('profile-email');
  if (profileEmailEl) profileEmailEl.textContent = user.email;
  
  const profileJoinedEl = document.getElementById('profile-joined');
  if (profileJoinedEl) profileJoinedEl.textContent = formatDate(user.created);

  const profileLocationEl = document.getElementById('profile-location');
  if (profileLocationEl) profileLocationEl.textContent = user.location;

  // Bind avatar
  const profileAvatarImg = document.getElementById('profileAvatarImg');
  const profileAvatarSvg = document.getElementById('profileAvatarSvg');
  if (user.avatar && profileAvatarImg && profileAvatarSvg) {
    profileAvatarImg.src = user.avatar;
    profileAvatarImg.classList.remove('hidden');
    profileAvatarSvg.classList.add('hidden');
  }
  
  const profileRoleTextEl = document.getElementById('profile-role-text');
  if (profileRoleTextEl) profileRoleTextEl.textContent = roleDisplay;
  
  const profilePermissionsEl = document.getElementById('profile-permissions');
  if (profilePermissionsEl) profilePermissionsEl.textContent = user.adminAccess === true ? 'Full Access' : user.adminAccess === false ? 'Limited Access' : 'Access unverified';
  
  const profileLastLoginEl = document.getElementById('profile-last-login');
  if (profileLastLoginEl) profileLastLoginEl.textContent = formatDateTime(user.last_login || user.created);
  
  const overviewUsernameEl = document.getElementById('overview-username');
  if (overviewUsernameEl) overviewUsernameEl.textContent = user.username;
  
  const overviewEmailEl = document.getElementById('overview-email');
  if (overviewEmailEl) overviewEmailEl.textContent = user.email;
}

document.addEventListener('DOMContentLoaded', async () => {
  // Tab Navigation Logic
  const tabs = [
    { btn: document.getElementById('tabBtnProfile'), panel: document.getElementById('panelProfile') },
    { btn: document.getElementById('tabBtnSecurity'), panel: document.getElementById('panelSecurity') },
    { btn: document.getElementById('tabBtnHistory'), panel: document.getElementById('panelHistory'), onOpen: () => renderLoginHistory() },
    { btn: document.getElementById('tabBtnDeviceMode'), panel: document.getElementById('panelDeviceMode') }
  ];

  function switchTab(activeTab) {
    tabs.forEach(tab => {
      if (!tab.btn || !tab.panel) return;
      tab.btn.setAttribute('aria-selected', String(tab === activeTab));
      tab.btn.tabIndex = tab === activeTab ? 0 : -1;
      if (tab === activeTab) {
        tab.btn.classList.remove('border-transparent', 'text-gray-500', 'dark:text-gray-400');
        tab.btn.classList.add('border-emerald-500', 'text-emerald-600', 'dark:text-emerald-400');
        tab.panel.classList.remove('hidden');
        if (tab.onOpen) tab.onOpen();
        if (tab.btn.id === 'tabBtnDeviceMode') window.EcoTrackMode?.apply();
      } else {
        tab.btn.classList.remove('border-emerald-500', 'text-emerald-600', 'dark:text-emerald-400');
        tab.btn.classList.add('border-transparent', 'text-gray-500', 'dark:text-gray-400');
        tab.panel.classList.add('hidden');
      }
    });
  }

  tabs.forEach(tab => {
    if (tab.btn) {
      tab.btn.setAttribute('role', 'tab'); tab.btn.setAttribute('aria-controls', tab.panel.id);
      tab.panel.setAttribute('role', 'tabpanel'); tab.panel.setAttribute('aria-labelledby', tab.btn.id);
      tab.btn.addEventListener('click', () => {
        switchTab(tab);
        if (tab.btn.id === 'tabBtnDeviceMode') history.replaceState(null, '', '#device-mode');
        else if (location.hash === '#device-mode') history.replaceState(null, '', location.pathname + location.search);
      });
      tab.btn.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = tabs.indexOf(tab), next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next].btn.click(); tabs[next].btn.focus();
      });
    }
  });

  const openDeviceMode = () => { if (location.hash === '#device-mode') { switchTab(tabs[3]); tabs[3].btn.scrollIntoView({ block: 'start', inline: 'nearest' }); } };
  window.addEventListener('hashchange', openDeviceMode);
  switchTab(location.hash === '#device-mode' ? tabs[3] : tabs[0]);
  openDeviceMode();

  await loadProfileWithSWR();

  if (window.EcoDataBus) {
    window.EcoDataBus.on('data:invalidated', (payload) => {
      if (payload && payload.key === 'profile:data') {
        loadProfileWithSWR(true);
      }
    });
  }

  const sb = window.supabaseClient || window.sb;
  const user = currentUser || JSON.parse(localStorage.getItem('ecoTrack_profile_user') || '{}');
  const name = user.username || 'Administrator';
  const roleTitle = isAdministratorProfile(user) ? 'System Administrator' : 'System User';

  // Initialize and bind Dark Mode Toggle
  const darkModeToggle = document.getElementById('dark-mode-toggle-ui');
  const darkModeStatusText = document.getElementById('dark-mode-status-text');

  function updateDarkModeStatus(isDark) {
    if (!darkModeStatusText) return;
    if (isDark) {
      darkModeStatusText.textContent = 'Dark Mode';
      darkModeStatusText.className = 'theme-pill-badge theme-dark text-xs font-bold px-3 py-1 rounded-full border transition-all select-none cursor-pointer shadow-xs focus:outline-none';
    } else {
      darkModeStatusText.textContent = 'Light Mode';
      darkModeStatusText.className = 'theme-pill-badge theme-light text-xs font-bold px-3 py-1 rounded-full border transition-all select-none cursor-pointer shadow-xs focus:outline-none';
    }
  }

  if (darkModeToggle) {
    const isDark = localStorage.getItem('ecoTrackTheme') === 'dark' || document.documentElement.classList.contains('dark');
    darkModeToggle.checked = isDark;
    updateDarkModeStatus(isDark);

    darkModeToggle.addEventListener('change', () => {
      const isChecked = darkModeToggle.checked;
      const newTheme = isChecked ? 'dark' : 'light';
      localStorage.setItem('ecoTrackTheme', newTheme);
      updateDarkModeStatus(isChecked);
      
      if (newTheme === 'dark') {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
      
      window.dispatchEvent(new CustomEvent('theme:changed', { detail: newTheme }));
      
      // Sync other listeners on the same window
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'ecoTrackTheme',
        newValue: newTheme
      }));
    });

    if (darkModeStatusText) {
      darkModeStatusText.addEventListener('click', () => {
        darkModeToggle.checked = !darkModeToggle.checked;
        darkModeToggle.dispatchEvent(new Event('change'));
      });
    }

    window.addEventListener('storage', (e) => {
      if (e.key === 'ecoTrackTheme') {
        const isDarkNow = e.newValue === 'dark';
        darkModeToggle.checked = isDarkNow;
        updateDarkModeStatus(isDarkNow);
      }
    });

    window.addEventListener('theme:changed', (e) => {
      const isDarkNow = e.detail === 'dark';
      darkModeToggle.checked = isDarkNow;
      updateDarkModeStatus(isDarkNow);
    });
  }

  // Header notification badge live synchronization
  function updateHeaderNotificationBadge() {
    const badge = document.getElementById('headerNotificationBadge');
    if (!badge) return;
    const isEnabled = localStorage.getItem('ecoTrack_notifications_enabled') !== 'false';
    if (!isEnabled) {
      badge.classList.add('hidden');
      badge.style.display = 'none';
      return;
    }
    try {
      const readState = JSON.parse(localStorage.getItem('ecoTrackNotificationReadState') || '{}');
      
      const processNotifs = (data) => {
        if (localStorage.getItem('ecoTrack_notifications_enabled') === 'false') {
          badge.classList.add('hidden');
          badge.style.display = 'none';
          return;
        }
        const unread = (data || []).filter(n => 
          n.triggered && 
          n.is_dismissed_from_inbox !== true &&
          !(n.content && String(n.content).startsWith('__INBOX_DISMISSED__|||')) && 
          !readState[String(n.id || '')]
        ).length;
        if (unread > 0) {
          badge.textContent = unread > 99 ? '99+' : unread;
          badge.classList.remove('hidden');
          badge.style.display = 'flex';
        } else {
          badge.classList.add('hidden');
          badge.style.display = 'none';
        }
      };

      if (window.electron && typeof window.electron.invoke === 'function') {
        window.electron.invoke('notifications-fetch-all').then(res => {
          if (res && res.success && res.data) {
            processNotifs(res.data);
          }
        }).catch(() => {});
      } else {
        const sb = window.supabaseClient || window.sb;
        if (sb) {
          sb.from('notifications')
            .select('id, triggered, content')
            .then(({ data, error }) => {
              if (!error && data) processNotifs(data);
            }).catch(() => {});
        }
      }
    } catch (_) {}
  }
  updateHeaderNotificationBadge();
  setInterval(updateHeaderNotificationBadge, 8000);
  window.addEventListener('storage', (e) => {
    if (e.key === 'ecoTrackNotificationReadState') {
      updateHeaderNotificationBadge();
    }
    if (e.key === 'ecoTrack_notifications_enabled') {
      const isEnabled = e.newValue !== 'false';
      renderNotifToggleState(isEnabled);
      updateHeaderNotificationBadge();
    }
  });

  // ==========================================
  // Header Notification ON / OFF Toggle Button
  // ==========================================
  const notifToggleBtn = document.getElementById('headerNotificationToggleBtn');
  const notifBellIcon = document.getElementById('headerNotifBellIcon');
  const notifMutedIcon = document.getElementById('headerNotifMutedIcon');
  const notifStatusText = document.getElementById('headerNotifStatusText');
  const headerNotifBadge = document.getElementById('headerNotificationBadge');

  function renderNotifToggleState(isEnabled) {
    if (!notifToggleBtn) return;
    if (isEnabled) {
      if (notifBellIcon) notifBellIcon.classList.remove('hidden');
      if (notifMutedIcon) notifMutedIcon.classList.add('hidden');
      if (notifStatusText) {
        notifStatusText.textContent = 'Alerts ON';
        notifStatusText.className = 'theme-pill-badge notif-on text-xs font-bold px-2.5 py-1 rounded-full border transition-all select-none cursor-pointer shadow-xs focus:outline-none';
      }
      notifToggleBtn.title = 'Notifications: ON (Click to Mute / Turn OFF)';
      notifToggleBtn.setAttribute('aria-pressed', 'true');
      updateHeaderNotificationBadge();
    } else {
      if (notifBellIcon) notifBellIcon.classList.add('hidden');
      if (notifMutedIcon) notifMutedIcon.classList.remove('hidden');
      if (notifStatusText) {
        notifStatusText.textContent = 'Alerts OFF';
        notifStatusText.className = 'theme-pill-badge notif-off text-xs font-bold px-2.5 py-1 rounded-full border transition-all select-none cursor-pointer shadow-xs focus:outline-none';
      }
      notifToggleBtn.title = 'Notifications: OFF (Muted - Click to Turn ON)';
      notifToggleBtn.setAttribute('aria-pressed', 'false');
      if (headerNotifBadge) {
        headerNotifBadge.classList.add('hidden');
        headerNotifBadge.style.display = 'none';
      }
      const dialog = document.getElementById('globalNotificationDialog');
      if (dialog) dialog.style.display = 'none';
    }
  }

  const isNotifEnabled = localStorage.getItem('ecoTrack_notifications_enabled') !== 'false';
  renderNotifToggleState(isNotifEnabled);

  if (notifToggleBtn) {
    notifToggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const current = localStorage.getItem('ecoTrack_notifications_enabled') !== 'false';
      const newState = !current;
      localStorage.setItem('ecoTrack_notifications_enabled', newState ? 'true' : 'false');
      renderNotifToggleState(newState);

      window.dispatchEvent(new CustomEvent('notifications:toggled', { detail: { enabled: newState } }));
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'ecoTrack_notifications_enabled',
        newValue: newState ? 'true' : 'false'
      }));

      if (newState) {
        showProfileToast('🔔 Notifications turned ON', 'success');
      } else {
        showProfileToast('🔕 Notifications turned OFF (Muted)', 'info');
      }
    });
  }

  if (notifStatusText && notifToggleBtn) {
    notifStatusText.addEventListener('click', (e) => {
      e.preventDefault();
      notifToggleBtn.click();
    });
  }

  window.addEventListener('storage', (e) => {
    if (e.key === 'ecoTrack_notifications_enabled') {
      const isEnabled = e.newValue !== 'false';
      renderNotifToggleState(isEnabled);
      updateHeaderNotificationBadge();
    }
  });

  window.addEventListener('notifications:toggled', (e) => {
    if (e.detail && typeof e.detail.enabled === 'boolean') {
      renderNotifToggleState(e.detail.enabled);
      updateHeaderNotificationBadge();
    }
  });
  
  const overviewStatusEl = document.getElementById('overview-status');
  if (overviewStatusEl) {
    if (user.is_active === false) {
      overviewStatusEl.textContent = 'Inactive';
      overviewStatusEl.classList.replace('bg-emerald-50', 'bg-red-50');
      overviewStatusEl.classList.replace('text-[#10b981]', 'text-red-500');
    } else {
      overviewStatusEl.textContent = 'Active';
    }
  }

  // Populate Timeout dropdown
  const sessionTimeoutSelect = document.getElementById('session-timeout-select');
  if (sessionTimeoutSelect) {
    const savedTimeout = localStorage.getItem('ecoTrack_session_timeout') || user.session_timeout || '30 minutes';
    sessionTimeoutSelect.value = savedTimeout;
    sessionTimeoutSelect.addEventListener('change', () => {
      user.session_timeout = sessionTimeoutSelect.value;
      localStorage.setItem('ecoTrack_session_timeout', sessionTimeoutSelect.value);
      localStorage.setItem('ecoTrack_profile_user', JSON.stringify(user));
      
      if (typeof resetSessionTimeoutTimer === 'function') {
        resetSessionTimeoutTimer();
      }
      
      showProfileToast(`✓ Session timeout set to ${sessionTimeoutSelect.value}`, 'success');
    });
  }
  
  // Populate Edit Modal Fields
  const editNameEl = document.getElementById('edit-name');
  if (editNameEl) editNameEl.value = name;
  
  const editRoleEl = document.getElementById('edit-role');
  if (editRoleEl) {
    editRoleEl.value = roleTitle;
    editRoleEl.disabled = true; // Role shouldn't be casually editable by the user themselves here
  }
  
  const editEmailEl = document.getElementById('edit-email');
  if (editEmailEl) editEmailEl.value = user.email;

  const editLocationEl = document.getElementById('edit-location');
  if (editLocationEl) editLocationEl.value = user.location;

  // Top header button shortcuts to profile tab
  const editProfileBtn = document.getElementById('editProfileBtn');
  if (editProfileBtn) {
    editProfileBtn.addEventListener('click', () => {
      switchTab(tabs[0]);
      if (editNameEl) editNameEl.focus();
    });
  }

  // Legacy modal references handled safely
  const editProfileModal = document.getElementById('editProfileModal');
  const changePasswordModal = document.getElementById('changePasswordModal');
  const viewHistoryModal = document.getElementById('viewHistoryModal');
  const viewAirconTypesModal = document.getElementById('viewAirconTypesModal');
  const addAirconTypeModal = document.getElementById('addAirconTypeModal');

  // Helper toast notifier
  const notifySuccess = (msg) => (window.EcoToast ? window.EcoToast.success(msg) : alert(msg));
  const notifyError = (msg) => (window.EcoToast ? window.EcoToast.error(msg) : alert(msg));
  const notifyWarning = (msg) => (window.EcoToast ? window.EcoToast.warning(msg) : alert(msg));

  // Save Profile Changes
  const saveProfileBtn = document.getElementById('save-profile-btn');
  if (saveProfileBtn) {
    saveProfileBtn.addEventListener('click', async () => {
      const originalText = saveProfileBtn.innerHTML;
      saveProfileBtn.innerHTML = `
        <svg class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke-opacity="0.9"/></svg>
        Saving Profile...
      `;
      saveProfileBtn.disabled = true;
      
      try {
        const updatedData = {
          username: editNameEl.value.trim() || 'Administrator',
          email: editEmailEl.value.trim() || user.email,
          location: editLocationEl ? editLocationEl.value.trim() : 'Philippines'
        };
        
        const profileToSave = { ...user, ...updatedData };
        const clientToUpdate = window.supabaseClient || window.sb || sb;
        if (!user.id || !clientToUpdate) throw new Error('Sign in and reconnect before saving your profile.');
        const isStaff = user.id.startsWith('stf_') || user.userType === 'staff';
        const table = isStaff ? 'staff' : 'administrators';
        const payload = isStaff
          ? { name: updatedData.username, email: updatedData.email }
          : { username: updatedData.username, email: updatedData.email, location: updatedData.location, updated: new Date().toISOString() };
        const { data: receipt, error: sbUpdateErr } = await clientToUpdate.from(table).update(payload).eq('id', user.id).select('id').single();
        if (sbUpdateErr) throw new Error(sbUpdateErr.message || 'The profile could not be saved.');
        if (receipt?.id !== user.id) throw new Error('The server did not confirm your profile update.');
        localStorage.setItem('ecoTrack_profile_user', JSON.stringify(profileToSave));
        Object.assign(user, updatedData);
        
        // Update live fields on page immediately
        const profileNameEl = document.getElementById('profile-name');
        const profileEmailEl = document.getElementById('profile-email');
        const profileLocationEl = document.getElementById('profile-location');
        if (profileNameEl) profileNameEl.textContent = updatedData.username;
        if (profileEmailEl) profileEmailEl.textContent = updatedData.email;
        if (profileLocationEl) profileLocationEl.textContent = updatedData.location;
        populateProfileUI(profileToSave);

        notifySuccess('Profile updated successfully!');
        if (window.EcoDataBus) {
          window.EcoDataBus.invalidate('profile:data');
        }
      } catch (err) {
        console.error(err);
        notifyError('Failed to update profile: ' + (err.data?.message || err.message));
      } finally {
        saveProfileBtn.innerHTML = originalText;
        saveProfileBtn.disabled = false;
      }
    });
  }

  // Update Password
  const updatePasswordBtn = document.getElementById('update-password-btn');
  if (updatePasswordBtn) {
    updatePasswordBtn.addEventListener('click', async () => {
      const currentPassword = document.getElementById('current-password').value;
      const newPassword = document.getElementById('new-password').value;
      const confirmPassword = document.getElementById('confirm-password').value;
      
      if (!currentPassword || !newPassword || !confirmPassword) {
        notifyWarning('Please fill in all password fields.');
        return;
      }
      
      if (newPassword !== confirmPassword) {
        notifyWarning('New passwords do not match.');
        return;
      }

      if (newPassword.length < 6) {
        notifyWarning('New password should be at least 6 characters long.');
        return;
      }
      
      const originalText = updatePasswordBtn.innerHTML;
      updatePasswordBtn.innerHTML = `
        <svg class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke-opacity="0.9"/></svg>
        Updating...
      `;
      updatePasswordBtn.disabled = true;
      
      try {
        if (!sb?.auth || !user.id) throw new Error('Sign in before changing your password.');
        const { data: identity, error: identityError } = await sb.auth.getUser();
        if (identityError || !identity.user?.email) throw new Error('Sign in before changing your password.');
        const { error: currentError } = await sb.auth.signInWithPassword({ email: identity.user.email, password: currentPassword });
        if (currentError) throw new Error('Current password is incorrect.');
        const { error: pwdErr } = await sb.auth.updateUser({ password: newPassword });
        if (pwdErr) throw new Error(pwdErr.message);
        notifySuccess('Password updated successfully!');
        
        // Clear inputs
        document.getElementById('current-password').value = '';
        document.getElementById('new-password').value = '';
        document.getElementById('confirm-password').value = '';
        
      } catch (err) {
        console.error(err);
        notifyError('Failed to update password: ' + (err.data?.message || err.message));
      } finally {
        updatePasswordBtn.innerHTML = originalText;
        updatePasswordBtn.disabled = false;
      }
    });
  }

  // Avatar Upload Logic
  const avatarContainer = document.getElementById('avatarContainer');
  const avatarFileInput = document.getElementById('avatarFileInput');
  if (avatarContainer && avatarFileInput) {
    avatarContainer.addEventListener('click', () => {
      avatarFileInput.click();
    });

    avatarFileInput.addEventListener('change', () => {
      const file = avatarFileInput.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (e) => {
        const base64Data = e.target.result;
        localStorage.setItem('ecoTrack_avatar', base64Data);
        
        if (profileAvatarImg && profileAvatarSvg) {
          profileAvatarImg.src = base64Data;
          profileAvatarImg.classList.remove('hidden');
          profileAvatarSvg.classList.add('hidden');
        }
        notifySuccess('Profile picture updated successfully!');
      };
      reader.readAsDataURL(file);
    });
  }

  // Login History Rendering
  function getLoginHistory() {
    let history = [];
    try {
      history = JSON.parse(localStorage.getItem('ecoTrack_loginHistory')) || [];
    } catch (e) {
      history = [];
    }
    if (!history.length) {
      const now = new Date();
      const formattedDate = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const formattedTime = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
      history = [
        { id: 'log_cur', device: 'Windows • Chrome', ip: '127.0.0.1 (Current Session)', time: `${formattedDate} • ${formattedTime}`, status: 'Active', isCurrent: true }
      ];
      localStorage.setItem('ecoTrack_loginHistory', JSON.stringify(history));
    }
    return history;
  }

  function renderLoginHistory() {
    const listEl = document.getElementById('login-history-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    const history = getLoginHistory();
    if (history.length === 0) {
      listEl.innerHTML = `
        <li class="py-12 px-4 text-center flex flex-col items-center justify-center">
          <div class="w-14 h-14 rounded-2xl bg-teal-500/10 dark:bg-teal-500/15 text-teal-600 dark:text-teal-400 border border-teal-500/30 flex items-center justify-center mb-3 shadow-xs">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
          </div>
          <p class="font-bold text-sm text-slate-800 dark:text-white mb-1">No Login History Recorded</p>
          <p class="text-xs text-slate-500 dark:text-gray-400 max-w-xs leading-relaxed">
            Authentication timestamps, IP addresses, and active browser sessions will be logged here.
          </p>
        </li>
      `;
      return;
    }

    history.forEach(item => {
      const isCur = item.isCurrent;
      const li = document.createElement('li');
      li.className = 'flex justify-between items-center p-3 rounded-xl bg-gray-50 dark:bg-slate-900/60 border border-gray-200 dark:border-white/5 transition-all';
      li.innerHTML = `
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-xl ${isCur ? 'bg-emerald-50 dark:bg-emerald-950/50 text-[#10b981] border border-emerald-500/30' : 'bg-gray-100 dark:bg-slate-800 text-gray-500'} flex items-center justify-center shrink-0">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
              <line x1="8" y1="21" x2="16" y2="21"></line>
              <line x1="12" y1="17" x2="12" y2="21"></line>
            </svg>
          </div>
          <div>
            <div class="flex items-center gap-2">
              <p class="font-bold text-gray-900 dark:text-gray-100 text-xs">${item.device || 'Desktop Dashboard'}</p>
              ${isCur ? '<span class="px-2 py-0.5 text-[10px] font-black uppercase tracking-wider rounded-full bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border border-emerald-500/40">Active Now</span>' : ''}
            </div>
            <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 flex items-center gap-1.5">
              <span>IP: ${item.ip || '127.0.0.1'}</span>
              <span>•</span>
              <span>${item.time}</span>
            </p>
          </div>
        </div>
      `;
      listEl.appendChild(li);
    });
  }

  const clearHistoryBtn = document.getElementById('clear-history-btn');
  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', () => {
      const history = getLoginHistory();
      const cur = history.find(h => h.isCurrent);
      const newHistory = cur ? [cur] : [];
      localStorage.setItem('ecoTrack_loginHistory', JSON.stringify(newHistory));
      renderLoginHistory();
      showProfileToast('Past login activity history cleared.', 'info');
    });
  }

  // Password Visibility Toggle Logic (2D Eye)
  document.querySelectorAll('.password-toggle-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const input = btn.parentElement.querySelector('input');
      if (!input) return;
      if (input.type === 'password') {
        input.type = 'text';
        btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
        btn.title = 'Hide Password';
      } else {
        input.type = 'password';
        btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
        btn.title = 'Show Password';
      }
    });
  });
});

// Profile Toast Helper
function showProfileToast(message, type = 'info') {
  let container = document.getElementById('ecoTrackToastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'ecoTrackToastContainer';
    container.className = 'fixed bottom-6 right-6 z-[99999] flex flex-col gap-2.5 pointer-events-none';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = 'pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-2xl shadow-2xl backdrop-blur-xl border text-sm font-semibold transition-all duration-300 transform translate-y-2 opacity-0';

  let borderColor = 'border-cyan-500/40';
  let bgColor = 'bg-slate-900/95';
  let textColor = 'text-gray-100';
  let iconSvg = '';

  if (type === 'success') {
    borderColor = 'border-emerald-500/50';
    iconSvg = `<div class="w-7 h-7 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
    </div>`;
  } else if (type === 'error') {
    borderColor = 'border-red-500/50';
    iconSvg = `<div class="w-7 h-7 rounded-full bg-red-500/20 text-red-400 flex items-center justify-center shrink-0">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </div>`;
  } else {
    borderColor = 'border-[#10b981]/50';
    iconSvg = `<div class="w-7 h-7 rounded-full bg-[#10b981]/20 text-[#10b981] flex items-center justify-center shrink-0">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
    </div>`;
  }

  toast.classList.add(borderColor, bgColor, textColor);
  toast.innerHTML = `
    ${iconSvg}
    <span class="flex-1">${message}</span>
  `;

  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
    toast.classList.add('translate-y-0', 'opacity-100');
  });

  setTimeout(() => {
    toast.classList.remove('translate-y-0', 'opacity-100');
    toast.classList.add('translate-y-2', 'opacity-0');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}
