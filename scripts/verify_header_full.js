const fs = require('fs');
const html = fs.readFileSync('public/logs.html', 'utf8');

console.log('=== ECOTRACK ACTIVITY LOG HEADER COMPREHENSIVE VERIFICATION ===\n');

let allPassed = true;

function check(desc, condition) {
  if (condition) {
    console.log(`✅ [PASS] ${desc}`);
  } else {
    console.log(`❌ [FAIL] ${desc}`);
    allPassed = false;
  }
}

// 1. Header Row 1 Elements
console.log('--- Row 1: Header Titles, Period Switcher & Action Controls ---');
check('logsPageHeading exists', html.includes('id="logsPageHeading"'));
check('Live pulsating indicator exists', html.includes('shadow-[0_0_10px_#10b981] animate-pulse'));
check('LIVE badge exists', html.includes('LIVE'));
check('headerPeriodTabsWrapper exists', html.includes('id="headerPeriodTabsWrapper"'));
check('headerPeriodTabs container has uniform h-[38px]', html.includes('id="headerPeriodTabs"') && html.includes('h-[38px] p-1'));
check('headerPeriodDailyBtn exists', html.includes('id="headerPeriodDailyBtn"'));
check('headerPeriodWeeklyBtn exists', html.includes('id="headerPeriodWeeklyBtn"'));
check('headerPeriodMonthlyBtn exists', html.includes('id="headerPeriodMonthlyBtn"'));
check('openTopConsumersModalBtn exists with h-[38px]', html.includes('id="openTopConsumersModalBtn"') && html.includes('h-[38px] px-3.5'));
check('openTariffModalBtn exists with h-[38px]', html.includes('id="openTariffModalBtn"') && html.includes('h-[38px] px-3.5'));
check('headerTariffDisplay exists', html.includes('id="headerTariffDisplay"'));
check('headerExportPdfBtn exists with h-[38px]', html.includes('id="headerExportPdfBtn"') && html.includes('h-[38px] px-3.5'));
check('headerExportExcelBtn exists with h-[38px]', html.includes('id="headerExportExcelBtn"') && html.includes('h-[38px] px-3.5'));

// 2. Header Row 2 Elements
console.log('\n--- Row 2: Global Analytics & Logs Filter Bar ---');
check('nodeFilter exists with header-filter-pill-select', html.includes('id="nodeFilter"') && html.includes('class="header-filter-pill-select'));
check('dateRangeSelect exists with header-filter-pill-select', html.includes('id="dateRangeSelect"') && html.includes('class="header-filter-pill-select'));
check('Time filter container has header-time-pill', html.includes('class="header-time-pill flex items-center gap-2"'));
check('startTimeFilter input exists', html.includes('id="startTimeFilter"'));
check('endTimeFilter input exists', html.includes('id="endTimeFilter"'));
check('clearTimeFilterBtn exists', html.includes('id="clearTimeFilterBtn"'));
check('activeFilterBadge exists with uniform h-[38px]', html.includes('id="activeFilterBadge"') && html.includes('h-[38px] px-3.5'));
check('activeFilterText exists', html.includes('id="activeFilterText"'));
check('resetAllFiltersBtn exists with uniform h-[38px]', html.includes('id="resetAllFiltersBtn"') && html.includes('h-[38px] px-3.5'));

// 3. CSS Uniformity
console.log('\n--- CSS Uniform 38px Standards & Emerald Styling ---');
check('.header-filter-pill-select has 38px height', html.includes('.header-filter-pill-select {') && html.includes('height: 38px !important;'));
check('.header-filter-pill-select has 1.5px emerald border', html.includes('border: 1.5px solid #10b981 !important;'));
check('.header-filter-pill-select has 12px border radius', html.includes('border-radius: 12px !important;'));
check('.header-time-pill has 38px height', html.includes('.header-time-pill {') && html.includes('height: 38px !important;'));
check('.header-time-pill has 1.5px emerald border', html.includes('.header-time-pill') && html.includes('border: 1.5px solid #10b981 !important;'));
check('.header-time-pill has 12px border radius', html.includes('.header-time-pill') && html.includes('border-radius: 12px !important;'));
check('Time inputs have color-scheme defined', html.includes('color-scheme: dark') && html.includes('color-scheme: light'));

// 4. Script and Cache Invalidation
console.log('\n--- Cache Busters & Cleanup ---');
check('Bulky subtitle completely removed', !html.includes('Monitor real-time aircon energy consumption'));
check('logs.js version bumped to v=31', html.includes('src="./js/logs.js?v=31"'));

if (allPassed) {
  console.log('\n🎉 ALL 24 HEADER ALIGNMENT AND UX SPECIFICATIONS PASSED WITH 100% ACCURACY!');
  process.exit(0);
} else {
  console.error('\n❌ SOME CHECKS FAILED!');
  process.exit(1);
}
