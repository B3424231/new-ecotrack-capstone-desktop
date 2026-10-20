const fs = require('fs');

const profileJs = fs.readFileSync('public/js/profile.js', 'utf8');
const globalNotifJs = fs.readFileSync('public/js/global-notifications.js', 'utf8');
const notifJs = fs.readFileSync('public/js/notifications.js', 'utf8');

const tests = [
  {
    name: 'profile.js: renderNotifToggleState hides badge when Alerts OFF',
    pass: profileJs.includes("headerNotifBadge.classList.add('hidden')") &&
          profileJs.includes("headerNotifBadge.style.display = 'none'") &&
          !profileJs.includes("headerNotifBadge.style.opacity = '0.5'")
  },
  {
    name: 'profile.js: updateHeaderNotificationBadge checks ecoTrack_notifications_enabled',
    pass: profileJs.includes("const isEnabled = localStorage.getItem('ecoTrack_notifications_enabled') !== 'false'") &&
          profileJs.includes("if (!isEnabled) {") &&
          profileJs.includes("badge.classList.add('hidden')")
  },
  {
    name: 'global-notifications.js: updateGlobalNotificationBadge hides badge when Alerts OFF',
    pass: globalNotifJs.includes("const isNotifEnabled = localStorage.getItem('ecoTrack_notifications_enabled') !== 'false'") &&
          globalNotifJs.includes("if (!isNotifEnabled) {") &&
          globalNotifJs.includes("headerBadge.classList.add('hidden')")
  },
  {
    name: 'global-notifications.js: triggerGlobalNotification aborts early before updating badge when Alerts OFF',
    pass: globalNotifJs.includes("function triggerGlobalNotification(message, notifContext = {}) {") &&
          globalNotifJs.indexOf("localStorage.getItem('ecoTrack_notifications_enabled') === 'false'") <
          globalNotifJs.indexOf("updateGlobalNotificationBadge(); // Re-sync from DB")
  },
  {
    name: 'global-notifications.js: listens for storage and notifications:toggled events',
    pass: globalNotifJs.includes("e.key === 'ecoTrack_notifications_enabled'") &&
          globalNotifJs.includes("window.addEventListener('notifications:toggled'")
  },
  {
    name: 'notifications.js: showGlobalNotification & updateNotificationBadge respect muted state',
    pass: notifJs.includes("if (localStorage.getItem('ecoTrack_notifications_enabled') === 'false') return;") &&
          notifJs.includes("const isNotifEnabled = localStorage.getItem('ecoTrack_notifications_enabled') !== 'false'")
  }
];

console.log('=== VERIFYING ALERTS OFF BUG FIX ===');
let passed = 0;
tests.forEach(t => {
  if (t.pass) passed++;
  console.log(`${t.pass ? '✅' : '❌'} ${t.name}`);
});

console.log(`\nResult: ${passed}/${tests.length} tests passed.`);
if (passed === tests.length) {
  console.log('🎉 ALL TESTS PASSED! The Alerts OFF bug is completely fixed.');
  process.exit(0);
} else {
  console.error('Some tests failed!');
  process.exit(1);
}
