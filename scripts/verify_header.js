const fs = require('fs');
const html = fs.readFileSync('public/logs.html', 'utf8');

const ids = [
  'logsPageHeading',
  'headerPeriodTabsWrapper',
  'headerPeriodDailyBtn',
  'headerPeriodWeeklyBtn',
  'headerPeriodMonthlyBtn',
  'openTopConsumersModalBtn',
  'openTariffModalBtn',
  'headerTariffDisplay',
  'headerExportPdfBtn',
  'headerExportExcelBtn'
];

console.log('=== HEADER ROW 1 INTEGRITY CHECK ===');
let allOk = true;
ids.forEach(id => {
  const exists = html.includes(`id="${id}"`);
  if (!exists) allOk = false;
  console.log(`${exists ? '✅' : '❌'} #${id}`);
});

const hasSubtitle = html.includes('Monitor real-time aircon energy consumption');
console.log(`${!hasSubtitle ? '✅ Bulky subtitle successfully removed' : '❌ Bulky subtitle still present'}`);

if (allOk && !hasSubtitle) {
  console.log('🎉 HEADER VERIFICATION PASSED PERFECTLY!');
  process.exit(0);
} else {
  console.error('Header verification failed!');
  process.exit(1);
}
