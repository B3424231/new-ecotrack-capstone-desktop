// ===== ANALYTICS PAGE LOGIC =====

// Initialize Database Clients (telemetry -> PocketBase, analytics & metadata -> Supabase)
const sb = window.supabaseClient || window.sb;
const pb = window.pb || (typeof PocketBase === 'function' ? new PocketBase() : null);

let tempChart, pressureChart, pressureHeatmapChart, nodeDetailTempChart, nodeDetailPressureChart;
let ruleComplianceChart;
let batteryDegradationChart, tempStabilityChart, roomHealthRadarChart, signalReliabilityChart;

function getChartTheme() {
  const isDark = localStorage.getItem('ecoTrackTheme') === 'dark' || document.documentElement.classList.contains('dark');
  return {
    isDark,
    textColor: isDark ? '#cbd5e1' : '#334155',
    tickColor: isDark ? '#cbd5e1' : '#475569',
    gridColor: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)',
    legendColor: isDark ? '#e2e8f0' : '#1e293b',
    radarAngleLines: isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(24, 57, 43, 0.15)',
    radarGrid: isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(24, 57, 43, 0.15)'
  };
}

function updateAllChartsTheme() {
  const ct = getChartTheme();

  const charts = [
    tempChart, pressureChart, pressureHeatmapChart,
    nodeDetailTempChart, nodeDetailPressureChart, ruleComplianceChart,
    batteryDegradationChart, tempStabilityChart, roomHealthRadarChart,
    signalReliabilityChart
  ];

  charts.forEach(chart => {
    if (!chart) return;

    if (chart === ruleComplianceChart && chart.options && chart.options.scales) {
      if (chart.options.scales.x) {
        if (chart.options.scales.x.ticks) chart.options.scales.x.ticks.color = ct.isDark ? '#94a3b8' : '#64748b';
        if (chart.options.scales.x.grid) chart.options.scales.x.grid.color = ct.isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.05)';
        if (chart.options.scales.x.title) chart.options.scales.x.title.color = ct.isDark ? '#64748b' : '#94a3b8';
      }
      if (chart.options.scales.y) {
        if (chart.options.scales.y.ticks) chart.options.scales.y.ticks.color = ct.isDark ? '#f1f5f9' : '#1e293b';
        if (chart.options.scales.y.grid) chart.options.scales.y.grid.display = false;
      }
      chart.update('none');
      return;
    }

    if (chart.options && chart.options.scales) {
      Object.values(chart.options.scales).forEach(scale => {
        if (scale && typeof scale === 'object') {
          if (scale.ticks && scale.ticks.display !== false) scale.ticks.color = ct.tickColor;
          if (scale.grid) scale.grid.color = ct.gridColor;
        }
      });
    }
    if (chart.options && chart.options.scales && chart.options.scales.r) {
      const rScale = chart.options.scales.r;
      if (rScale.pointLabels) rScale.pointLabels.color = ct.textColor;
      if (rScale.grid) rScale.grid.color = ct.radarGrid;
      if (rScale.angleLines) rScale.angleLines.color = ct.radarAngleLines;
    }
    if (chart.options && chart.options.plugins && chart.options.plugins.legend && chart.options.plugins.legend.labels) {
      chart.options.plugins.legend.labels.color = ct.legendColor;
    }
    chart.update('none');
  });
}

window.addEventListener('theme:changed', updateAllChartsTheme);

let pullDownActiveRoomId = 'all';
let selectedNodeId = 'all';
let analyticsPeriod = 'active';

const analyticsPeriods = {
  active: { label: 'Active Unit', ms: 24 * 60 * 60 * 1000, fallbackPoints: 24 },
  alerts: { label: 'Alerts', ms: 30 * 24 * 60 * 60 * 1000, fallbackPoints: 30 }
};

// Multi-Node Data Structure
const nodesData = {};
let globalTelemetryItems = [];

let analyticsTimerId1, analyticsTimerId2;

async function setupAnalyticsPage() {
  console.log('Analytics Page Loaded');
  if (tempChart) tempChart.destroy();
  if (pressureChart) pressureChart.destroy();
  if (pressureHeatmapChart) pressureHeatmapChart.destroy();
  if (nodeDetailTempChart) nodeDetailTempChart.destroy();
  if (nodeDetailPressureChart) nodeDetailPressureChart.destroy();
  if (ruleComplianceChart) ruleComplianceChart.destroy();
  if (batteryDegradationChart) batteryDegradationChart.destroy();
  if (tempStabilityChart) tempStabilityChart.destroy();
  if (roomHealthRadarChart) roomHealthRadarChart.destroy();
  if (signalReliabilityChart) signalReliabilityChart.destroy();

  if (typeof checkBackendConnection === 'function') checkBackendConnection();
  await updateMultiNodeData(); // Fetch initial nodes data
  await initAnalytics();
  initNodeSelector();
  startDataCollection();
  updateAllChartsTheme();

  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      const icon = refreshBtn.querySelector('svg');
      if (icon) icon.classList.add('spin-icon');

      await updateMultiNodeData();
      await initAnalytics();

      if (icon) {
        setTimeout(() => icon.classList.remove('spin-icon'), 500);
      }

      if (typeof showNotification === 'function') {
        showNotification('Analytics data refreshed');
      }
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupAnalyticsPage);
} else {
  setupAnalyticsPage();
}

window.addEventListener('page:init', () => {
  if (window.location.pathname.includes('analytics.html') || window.location.hash.includes('analytics')) {
    setupAnalyticsPage();
  }
});

async function fetchHistoricalData() {
  try {
    const response = await fetch('http://127.0.0.1:5000/api/historical');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();

    ensureHistoricalState();

    // Clear existing data
    appState.historicalData.temps = [];
    appState.historicalData.pressures = [];
    appState.historicalData.timestamps = [];
    appState.historicalData.rawTemps = [];
    appState.historicalData.rawPressures = [];
    appState.historicalData.rawTimestamps = [];

    // Use data from backend
    appState.historicalData.rawTemps = data.temperatures || [];
    appState.historicalData.rawPressures = data.pressures || [];

    let rawTimestamps = data.timestamps || [];
    const now = new Date();
    const intervalMs = rawTimestamps.length > 0 ? (24 * 60 * 60 * 1000) / rawTimestamps.length : 60000;
    rawTimestamps = rawTimestamps.map((t, idx) => {
      if (!t) {
        // Backfill legacy timestamp spanning 24h
        const d = new Date(now.getTime() - (rawTimestamps.length - idx) * intervalMs);
        return d.toISOString().replace('T', ' ');
      }
      return t;
    });

    appState.historicalData.rawTimestamps = rawTimestamps.map(t => normalizeTimestamp(t));

    if (appState.historicalData.rawTemps.length > 0) {
      appState.currentTemp = appState.historicalData.rawTemps[appState.historicalData.rawTemps.length - 1];
      appState.currentPressure = appState.historicalData.rawPressures[appState.historicalData.rawPressures.length - 1];
    }

    applyPeriodFilter();

  } catch (error) {
    console.error("Could not fetch historical data:", error);
  }
}


async function initAnalytics() {
  await fetchHistoricalData();
  initTempChart();
  initPressureChart();

  // Initialize multi-node charts
  initPressureHeatmap();
  initNodePerformanceRanking();

  // Advanced Analytics
  initBatteryDegradationChart();
  initTempStabilityChart();
  initSignalReliabilityChart();

  // Populate charts with initial data
  if (tempChart && appState.historicalData.temps.length > 0) {
    tempChart.data.labels = appState.historicalData.timestamps;
    tempChart.data.datasets[0].data = appState.historicalData.temps;
    tempChart.update('none');
  }

  if (pressureChart && appState.historicalData.pressures.length > 0) {
    pressureChart.data.labels = appState.historicalData.timestamps;
    pressureChart.data.datasets[0].data = appState.historicalData.pressures;
    pressureChart.update('none');
  }

  initRuleComplianceBenchmarking();

  // Update multi-node summary
  updateMultiNodeSummary();

  initPeriodTabs();
  applyPeriodFilter();
  updateAllChartsTheme();

  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', exportPDF);
  }
}

function ensureHistoricalState() {
  if (!appState.historicalData) appState.historicalData = {};
  if (!Array.isArray(appState.historicalData.rawTemps)) appState.historicalData.rawTemps = [];
  if (!Array.isArray(appState.historicalData.rawPressures)) appState.historicalData.rawPressures = [];
  if (!Array.isArray(appState.historicalData.rawTimestamps)) appState.historicalData.rawTimestamps = [];
  if (!Array.isArray(appState.historicalData.temps)) appState.historicalData.temps = [];
  if (!Array.isArray(appState.historicalData.pressures)) appState.historicalData.pressures = [];
  if (!Array.isArray(appState.historicalData.timestamps)) appState.historicalData.timestamps = [];
}

function normalizeTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function formatTimestampForPeriod(date, period) {
  if (!date || Number.isNaN(date.getTime())) return '';
  if (period === 'alerts') {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getFilteredSeries(rawValues, rawTimestamps, periodKey) {
  const cfg = analyticsPeriods[periodKey] || analyticsPeriods.active;
  const now = new Date();
  const cutoff = new Date(now.getTime() - cfg.ms);
  const timestamps = Array.isArray(rawTimestamps) ? rawTimestamps : [];
  const values = Array.isArray(rawValues) ? rawValues : [];

  const filteredValues = [];
  const filteredLabels = [];
  let hasValidTimestamp = false;

  const dateSelect = document.getElementById('dateRangeSelect');
  const selectedDateKey = dateSelect ? dateSelect.value : 'all';
  // isHistorical = a specific date is selected (not 'all')
  const isHistorical = selectedDateKey && selectedDateKey !== 'all';
  // isAllTime = 'all' is selected — skip the 24h cutoff entirely
  const isAllTime = !selectedDateKey || selectedDateKey === 'all';

  values.forEach((value, idx) => {
    const ts = timestamps[idx];
    if (ts instanceof Date && !Number.isNaN(ts.getTime())) {
      hasValidTimestamp = true;
      // Show: specific date selected → always include (data is pre-filtered by date)
      //       all time selected    → include all records regardless of cutoff
      //       default (active)     → apply 24h cutoff
      if (isHistorical || isAllTime || ts >= cutoff) {
        filteredValues.push(value);
        filteredLabels.push(formatTimestampForPeriod(ts, periodKey));
      }
    }
  });

  if (!hasValidTimestamp) {
    const fallback = cfg.fallbackPoints;
    const start = Math.max(0, values.length - fallback);
    for (let i = start; i < values.length; i += 1) {
      filteredValues.push(values[i]);
      filteredLabels.push('');
    }
  }

  return { values: filteredValues, labels: filteredLabels };
}

function applyPeriodFilter() {
  ensureHistoricalState();
  const { values, labels } = getFilteredSeries(
    appState.historicalData.rawTemps,
    appState.historicalData.rawTimestamps,
    analyticsPeriod
  );
  const { values: pressureValues, labels: pressureLabels } = getFilteredSeries(
    appState.historicalData.rawPressures,
    appState.historicalData.rawTimestamps,
    analyticsPeriod
  );

  appState.historicalData.temps = values;
  appState.historicalData.pressures = pressureValues;
  appState.historicalData.timestamps = labels.length > 0 ? labels : pressureLabels;

  if (tempChart) {
    tempChart.data.labels = appState.historicalData.timestamps;
    tempChart.data.datasets[0].data = appState.historicalData.temps;
    tempChart.update('none');
  }

  if (pressureChart) {
    pressureChart.data.labels = appState.historicalData.timestamps;
    pressureChart.data.datasets[0].data = appState.historicalData.pressures;
    pressureChart.update('none');
  }
}

function initPeriodTabs() {
  const tabs = document.querySelectorAll('.period-tab');
  if (!tabs.length) return;

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      setAnalyticsPeriod(tab.dataset.period || 'active');
    });
  });

  updatePeriodTabsUI();
}

function setAnalyticsPeriod(periodKey) {
  if (!analyticsPeriods[periodKey]) return;
  analyticsPeriod = periodKey;
  updatePeriodTabsUI();
  applyPeriodFilter();
  updateNodeDetails();
}

function updatePeriodTabsUI() {
  const tabs = document.querySelectorAll('.period-tab');
  tabs.forEach(tab => {
    const isActive = tab.dataset.period === analyticsPeriod;

    if (isActive) {
      tab.classList.add('bg-cyan-900/40', 'border', 'border-cyan-500/50', 'text-white', 'font-bold');
      tab.classList.remove('text-gray-400', 'hover:text-white', 'font-semibold', 'border-transparent');
    } else {
      tab.classList.remove('bg-cyan-900/40', 'border', 'border-cyan-500/50', 'text-white', 'font-bold');
      tab.classList.add('text-gray-400', 'hover:text-white', 'font-semibold', 'border', 'border-transparent');
    }

    tab.classList.toggle('is-active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
}

function initTempChart() {
  const ctx = document.getElementById('tempChart');
  if (!ctx) return;
  const ct = getChartTheme();

  tempChart = new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: {
      labels: generateTimeLabels(24),
      datasets: [{
        label: 'Temperature (°C)',
        data: Array(24).fill(0),
        borderColor: '#06b6d4',
        backgroundColor: 'rgba(6, 182, 212, 0.1)',
        tension: 0.4,
        fill: true,
        pointRadius: 3,
        pointBackgroundColor: '#06b6d4'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          beginAtZero: true,
          max: 50,
          ticks: { color: ct.tickColor },
          grid: { color: ct.gridColor }
        },
        x: {
          ticks: { color: ct.tickColor },
          grid: { color: ct.gridColor }
        }
      }
    }
  });
}

function initPressureChart() {
  const ctx = document.getElementById('pressureChart');
  if (!ctx) return;
  const ct = getChartTheme();

  pressureChart = new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: {
      labels: generateTimeLabels(24),
      datasets: [{
        label: 'Airflow Pressure (kPa)',
        data: Array(24).fill(0),
        borderColor: '#8b5cf6',
        backgroundColor: 'rgba(139, 92, 246, 0.1)',
        tension: 0.4,
        fill: true,
        pointRadius: 3,
        pointBackgroundColor: '#8b5cf6'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { color: ct.tickColor },
          grid: { color: ct.gridColor }
        },
        x: {
          ticks: { color: ct.tickColor },
          grid: { color: ct.gridColor }
        }
      }
    }
  });
}



async function startDataCollection() {
  if (analyticsTimerId1) clearInterval(analyticsTimerId1);
  if (analyticsTimerId2) clearInterval(analyticsTimerId2);

  analyticsTimerId1 = setInterval(async () => {
    await fetchTelemetryData();
    updateHistoricalData();
    await updateMultiNodeData(); // Pull live backend data instead of mock
  }, 3000);

  analyticsTimerId2 = setInterval(() => {
    initRuleComplianceBenchmarking();
  }, 20000);
}

async function fetchTelemetryData() {
  try {
    const response = await fetch('http://127.0.0.1:5000/api/telemetry');
    if (!response.ok) {
      if (response.status !== 404) { // Don't log error for expected "no data"
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return; // No new data
    }
    const data = await response.json();
    appState.currentTemp = data.temperature;
    appState.currentPressure = data.pressure;
    // You can also update other appState properties here, e.g., RSSI, voltage
  } catch (error) {
    console.error("Could not fetch telemetry data:", error);
  }
}

async function updateMultiNodeData() {
  try {
    let nodeNameMap = {};
    if (window.sb) {
      try {
        const { data: realNodes } = await window.sb.from('nodes').select('id, name');
        if (realNodes) realNodes.forEach(n => nodeNameMap[n.id] = n.name || n.id);
      } catch (e) { }
    } else if (Array.isArray(window.activeNodesData)) {
      window.activeNodesData.forEach(n => nodeNameMap[n.id] = n.name || n.id);
    }

    // Read the selected date from the dropdown
    // 'all' means no date filter — show data across all dates
    const dateSelect = document.getElementById('dateRangeSelect');
    let selectedDateKey = dateSelect && dateSelect.value ? dateSelect.value : 'all';

    // Fetch up to 1000 newest telemetry records, then reverse so chart timelines display correctly (oldest to newest)
    const result = await pb.collection('telemetry').getList(1, 1000, { sort: '-created', expand: 'node_id' });
    let items = result.items || [];
    items.reverse();

    // Backfill empty 'created' dates for legacy data so charts can render properly spanning 24h
    const now = new Date();
    const intervalMs = items.length > 0 ? (24 * 60 * 60 * 1000) / items.length : 60000;
    items.forEach((item, idx) => {
      if (!item.created) {
        const d = new Date(now.getTime() - (items.length - idx) * intervalMs);
        item.created = d.toISOString().replace('T', ' ');
      }
    });

    // Apply client-side date filter
    if (selectedDateKey && selectedDateKey !== 'all') {
      items = items.filter(item => {
        const d = new Date(item.created);
        if (isNaN(d.getTime())) return false;
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}` === selectedDateKey;
      });
    }

    globalTelemetryItems = items;
    const grouped = {};

    items.forEach(r => {
      const nId = r.node_id;
      if (!grouped[nId]) {
        grouped[nId] = {
          id: nId,
          name: nodeNameMap[nId] || nId,
          currentTemp: 0,
          currentPressure: 0,
          battery: 0,
          rssi: 0,
          status: r.status || 'online',
          efficiency: 100,
          historicalData: { temps: [], pressures: [], timestamps: [], rawTimestamps: [] }
        };
      }
      const node = grouped[nId];
      node.currentTemp = r.temperature;
      node.currentPressure = r.pressure;
      node.battery = r.battery;
      node.rssi = r.rssi;
      node.status = r.status || 'online';

      // Use exact timestamp from telemetry
      const createdAt = new Date(r.created);
      node.historicalData.temps.push(r.temperature);
      node.historicalData.pressures.push(r.pressure);
      node.historicalData.rawTimestamps.push(createdAt);
      node.historicalData.timestamps.push(createdAt ? createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

      // Limit to last 50 points per node for charts
      if (node.historicalData.temps.length > 50) {
        node.historicalData.temps.shift();
        node.historicalData.pressures.shift();
        node.historicalData.timestamps.shift();
        node.historicalData.rawTimestamps.shift();
      }

      const tempDeviation = Math.abs(node.currentTemp - 24); // 24 is optimal
      node.efficiency = Math.max(50, 100 - (tempDeviation * 5));
    });

    // Try to get real names from Supabase nodes table and filter out deleted nodes
    try {
      let allNodes = [];
      if (sb) {
        const { data, error } = await sb.from('nodes').select('*');
        if (!error && data) allNodes = data;
      }
      const liveNodeIds = new Set(allNodes.map(n => n.id));

      allNodes.forEach(pn => {
        if (grouped[pn.id]) {
          grouped[pn.id].name = pn.name;
          grouped[pn.id].room_id = pn.room_id;
        }
      });

      // Remove orphaned nodes (nodes that have telemetry but were deleted from the DB)
      Object.keys(grouped).forEach(nId => {
        if (!liveNodeIds.has(nId)) {
          delete grouped[nId];
        }
      });
    } catch (e) { }

    Object.keys(nodesData).forEach(k => delete nodesData[k]);
    Object.assign(nodesData, grouped);

    updateMultiNodeSummary();
    initNodePerformanceRanking();
    await updateAnalyticsAlertsBadge();

    // Refresh node selector options WITHOUT destroying the existing change event listener.
    // Setting innerHTML = '' kills the listener, so we add/remove individual <option> elements.
    refreshNodeSelectorOptions();

    // Attempt to update heatmap if it exists, otherwise init
    if (pressureHeatmapChart) {
      initPressureHeatmap(); // Heatmap is complex so re-init is safer
    }

    updateNodeDetails();
  } catch (e) {
    console.error("Multi-node data update failed:", e);
  }
}

async function updateAnalyticsAlertsBadge() {
  if (typeof updateGlobalNotificationBadge === 'function') {
    await updateGlobalNotificationBadge();
  }
}

function updateHistoricalData() {
  const now = new Date();
  ensureHistoricalState();
  appState.historicalData.rawTemps.push(appState.currentTemp);
  appState.historicalData.rawPressures.push(appState.currentPressure);
  appState.historicalData.rawTimestamps.push(now);

  if (appState.historicalData.rawTemps.length > 720) {
    appState.historicalData.rawTemps.shift();
    appState.historicalData.rawPressures.shift();
    appState.historicalData.rawTimestamps.shift();
  }

  applyPeriodFilter();
}



async function exportPDF() {
  try {
    addLog('Generating PDF Report...');

    let nodes = [];
    let roomsList = [];

    if (sb) {
      const [nRes, rRes] = await Promise.all([
        sb.from('nodes').select('*').order('name'),
        sb.from('rooms').select('*')
      ]);
      nodes = nRes.data || [];
      roomsList = rRes.data || [];
    }
    const roomMap = {};
    roomsList.forEach(r => roomMap[r.id] = r.name);

    // ── Resolve the currently selected control ──────────────────────────────
    const isFiltered = selectedNodeId && selectedNodeId !== 'all';
    const selectedNode = isFiltered ? nodesData[selectedNodeId] : null;
    const controlLabel = isFiltered && selectedNode
      ? selectedNode.name
      : 'All AC Control Nodes';

    // Filter the node list for the directory page
    const exportNodes = isFiltered
      ? nodes.filter(n => n.id === selectedNodeId)
      : nodes;

    // Read live KPIs from the page
    const currentTemp = document.getElementById('nodeCurrentTemp')?.textContent || '--';
    const currentPressure = document.getElementById('nodeCurrentPressure')?.textContent || '--';
    const batteryPercent = document.getElementById('nodeBatteryPercent')?.textContent || '--';
    const rssiValue = document.getElementById('nodeRSSI')?.textContent || '--';
    const avgCompliance = document.getElementById('avgCompliance')?.textContent || '--';
    const nonCompliantRooms = document.getElementById('nonCompliantRooms')?.textContent || '--';
    const violatingNodesVal = document.getElementById('violatingNodes')?.textContent || '--';
    const roomsNoRules = document.getElementById('roomsNoRules')?.textContent || '--';
    const selectedDate = document.getElementById('dateRangeSelect')?.selectedOptions[0]?.text
      || new Date().toLocaleDateString();

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    const M = 14;
    const cW = W - 2 * M;

    const P = {
      bg: [255, 255, 255], card: [255, 255, 255], bdr: [16, 185, 129],
      cyan: [24, 57, 43], wh: [24, 57, 43], gr: [24, 57, 43],
      gn: [16, 185, 129], rd: [239, 68, 68], pu: [16, 185, 129],
      or: [249, 115, 22], bl: [16, 185, 129]
    };

    function drawBg() { doc.setFillColor(...P.bg); doc.rect(0, 0, W, H, 'F'); }

    function drawFooter(pn, tot) {
      doc.setDrawColor(...P.bdr); doc.setLineWidth(0.3);
      doc.line(M, H - 14, W - M, H - 14);
      doc.setFontSize(8); doc.setTextColor(...P.gr); doc.setFont('helvetica', 'normal');
      doc.text('EcoTrack Analytics Report  |  Control: ' + controlLabel, M, H - 9);
      doc.text('Page ' + pn + ' of ' + tot, W - M, H - 9, { align: 'right' });
    }

    function drawHeader(title) {
      // Title
      doc.setFontSize(20); doc.setTextColor(...P.cyan); doc.setFont('helvetica', 'bold');
      doc.text(title, M, 16);

      // Top-right: Generated date + period
      doc.setFontSize(9); doc.setTextColor(...P.gr); doc.setFont('helvetica', 'normal');
      doc.text('Generated: ' + new Date().toLocaleString(), W - M, 12, { align: 'right' });
      doc.text('Period: ' + selectedDate, W - M, 18, { align: 'right' });

      // Control filter badge — highlighted green if a specific control is selected
      if (isFiltered) {
        const badge = 'Control: ' + controlLabel;
        doc.setFontSize(9); doc.setFont('helvetica', 'bold');
        const badgeW = doc.getTextWidth(badge) + 8;
        doc.setFillColor(16, 185, 129);
        doc.roundedRect(M, 21, badgeW, 7, 1.5, 1.5, 'F');
        doc.setTextColor(255, 255, 255);
        doc.text(badge, M + 4, 26);
      } else {
        doc.setFontSize(9); doc.setFont('helvetica', 'normal');
        doc.setTextColor(...P.gr);
        doc.text('Control: All AC Control Nodes', M, 26);
      }

      doc.setDrawColor(...P.cyan); doc.setLineWidth(0.4);
      doc.line(M, 31, W - M, 31);
      return 38;
    }

    function drawCard(x, y, w, h, label, value, color) {
      doc.setFillColor(...P.card); doc.setDrawColor(...P.bdr);
      doc.roundedRect(x, y, w, h, 2, 2, 'FD');
      doc.setFillColor(...color); doc.rect(x, y, w, 1.5, 'F');
      doc.setFontSize(8); doc.setTextColor(...P.gr); doc.setFont('helvetica', 'normal');
      doc.text(label, x + w / 2, y + 11, { align: 'center' });
      doc.setFontSize(18); doc.setTextColor(...color); doc.setFont('helvetica', 'bold');
      doc.text(String(value), x + w / 2, y + 23, { align: 'center' });
    }

    function drawLabel(text, x, y, color) {
      doc.setFontSize(12); doc.setTextColor(...color); doc.setFont('helvetica', 'bold');
      doc.text(text, x, y);
    }

    function getChart(id) {
      var el = document.getElementById(id);
      if (!el) return null;
      try { return el.toDataURL('image/png', 1.0); } catch (e) { return null; }
    }

    var gap = 6, ch = 28;
    function cardRow(y, cards) {
      var w = (cW - gap * (cards.length - 1)) / cards.length;
      cards.forEach(function (c, i) { drawCard(M + i * (w + gap), y, w, ch, c.l, c.v, c.c); });
      return y + ch;
    }

    // ═══ PAGE 1: System Overview ═══
    drawBg();
    var y = drawHeader('System Overview');
    y = cardRow(y, [
      { l: 'CURRENT TEMPERATURE', v: currentTemp, c: P.cyan },
      { l: 'CURRENT AIRFLOW', v: currentPressure, c: P.pu },
      { l: 'BATTERY LEVEL', v: batteryPercent, c: P.gn },
      { l: 'SIGNAL STRENGTH', v: rssiValue, c: P.bl }
    ]);
    y += 8;
    var hw = (cW - 8) / 2;
    drawLabel('Temperature Trend', M, y, P.cyan);
    drawLabel('Airflow Trend', M + hw + 8, y, P.pu);
    y += 3;
    var ti = getChart('nodeDetailTempChart');
    if (ti) doc.addImage(ti, 'PNG', M, y, hw, 60);
    var pi = getChart('nodeDetailPressureChart');
    if (pi) doc.addImage(pi, 'PNG', M + hw + 8, y, hw, 60);
    y += 65;
    drawLabel('Rule Compliance', M, y, P.cyan);
    y += 4;
    y = cardRow(y, [
      { l: 'AVG COMPLIANCE', v: avgCompliance, c: P.cyan },
      { l: 'NON-COMPLIANT ROOMS', v: nonCompliantRooms, c: P.or },
      { l: 'VIOLATING NODES', v: violatingNodesVal, c: P.rd },
      { l: 'ROOMS WITHOUT RULES', v: roomsNoRules, c: P.gr }
    ]);

    // ═══ PAGE 2: Compliance & Network ═══
    doc.addPage(); drawBg();
    y = drawHeader('Compliance & Network');
    drawLabel('Rule Compliance by Room', M, y, P.cyan);
    y += 3;
    var ci = getChart('ruleComplianceChart');
    if (ci) doc.addImage(ci, 'PNG', M, y, cW, 70);
    y += 78;
    drawLabel('Network Reliability (RSSI Trend)', M, y, P.bl);
    y += 3;
    var si = getChart('signalReliabilityChart');
    if (si) doc.addImage(si, 'PNG', M, y, cW, 65);

    // ═══ PAGE 3: Predictive Analytics ═══
    doc.addPage(); drawBg();
    y = drawHeader('Predictive Analytics');
    drawLabel('Battery Degradation Predictor', M, y, P.gn);
    drawLabel('Temp Stability Variance', M + hw + 8, y, P.or);
    y += 3;
    var bi = getChart('batteryDegradationChart');
    if (bi) doc.addImage(bi, 'PNG', M, y, hw, 80);
    var tsi = getChart('tempStabilityChart');
    if (tsi) doc.addImage(tsi, 'PNG', M + hw + 8, y, hw, 80);

    // ═══ PAGE 4: Node Directory (filtered to selected control) ═══
    doc.addPage(); drawBg();
    const dirTitle = isFiltered
      ? 'AC Control: ' + controlLabel
      : 'AC Control Node Directory';
    y = drawHeader(dirTitle);

    var assignedNodes = exportNodes.filter(function (n) { return !!n.room_id; });
    var onl = assignedNodes.filter(function (n) { return n.status === 'online' || n.status === 'active'; }).length;
    doc.setFontSize(10); doc.setTextColor(...P.gr); doc.setFont('helvetica', 'normal');

    // Show control scope note
    const scopeNote = isFiltered
      ? 'Showing data for control: ' + controlLabel
      : onl + ' of ' + assignedNodes.length + ' nodes online';
    doc.text(scopeNote, M, y);
    y += 6;

    var tbl = exportNodes.map(function (n) {
      // Pull latest telemetry from globalTelemetryItems for more accurate values
      const latestTel = globalTelemetryItems.filter(t => t.node_id === n.id).slice(-1)[0];
      const temp = latestTel ? parseFloat(latestTel.temperature || 0).toFixed(1)
        : parseFloat(n.temp || 0).toFixed(1);
      const pressure = latestTel ? parseFloat(latestTel.pressure || 0).toFixed(1)
        : parseFloat(n.pressure || 0).toFixed(1);
      const battery = latestTel
        ? Math.max(0, Math.min(100, Math.round(((latestTel.battery - 3.0) / (4.7 - 3.0)) * 100))) + '%'
        : Math.round((n.battery / 4.2) * 100) + '%';
      const rssi = latestTel ? (latestTel.rssi || -100) + ' dBm'
        : (n.rssi || -100) + ' dBm';
      return [
        n.name || 'Unknown',
        roomMap[n.room_id] || 'Unassigned',
        (n.status === 'online' || n.status === 'active') ? 'ONLINE' : 'OFFLINE',
        temp + ' \u00b0C',
        pressure + ' kPa',
        battery,
        rssi
      ];
    });

    doc.autoTable({
      startY: y,
      head: [['AC Control Node', 'Room', 'Status', 'Temperature', 'Airflow Pressure', 'Battery', 'Signal']],
      body: tbl,
      margin: { left: M, right: M },
      theme: 'plain',
      styles: {
        fontSize: 11, cellPadding: 5, textColor: [24, 57, 43],
        fillColor: false, lineColor: P.bdr, lineWidth: 0.25
      },
      headStyles: {
        fillColor: P.bdr, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 10, cellPadding: 6
      },
      alternateRowStyles: { fillColor: [240, 253, 244] },
      columnStyles: {
        0: { fontStyle: 'bold', textColor: P.wh, cellWidth: 45 },
        1: { cellWidth: 55 }, 2: { halign: 'center', cellWidth: 30 },
        3: { halign: 'center' }, 4: { halign: 'center' },
        5: { halign: 'center', cellWidth: 30 }, 6: { halign: 'center', cellWidth: 30 }
      },
      didParseCell: function (data) {
        if (data.section === 'body' && data.column.index === 2) {
          data.cell.styles.textColor = data.cell.raw === 'ONLINE' ? P.gn : P.rd;
          data.cell.styles.fontStyle = 'bold';
        }
      },
      willDrawPage: function () { drawBg(); }
    });

    // ── Footers ──
    var tot = doc.internal.getNumberOfPages();
    for (var p = 1; p <= tot; p++) { doc.setPage(p); drawFooter(p, tot); }

    // Filename includes the control name when filtered
    const safeControlName = isFiltered
      ? '_' + controlLabel.replace(/[^a-zA-Z0-9-_]/g, '_')
      : '';
    doc.save('EcoTrack_Analytics' + safeControlName + '_' + new Date().toISOString().slice(0, 10) + '.pdf');
    addLog('Analytics PDF Report exported successfully' + (isFiltered ? ' for ' + controlLabel : ''));

  } catch (error) {
    console.error('Could not export PDF:', error);
    addLog('Failed to export PDF report.');
  }
}




function generateTimeLabels(count) {
  const labels = [];
  const now = new Date();
  for (let i = count - 1; i >= 0; i--) {
    const time = new Date(now.getTime() - i * 60 * 60 * 1000);
    labels.push(time.getHours() + ':00');
  }
  return labels;
}

// ===== MULTI-NODE ANALYTICS FUNCTIONS =====

/**
 * Safely refreshes <option> elements in the node selector without wiping
 * event listeners (setting innerHTML destroys them).
 * Called on every updateMultiNodeData() poll cycle.
 */
function refreshNodeSelectorOptions() {
  const selector = document.getElementById('nodeSelector');
  if (!selector) return;

  const currentVal = selector.value;

  // Remove stale options (any node that no longer exists in nodesData)
  Array.from(selector.options).forEach(opt => {
    if (opt.value !== 'all' && !nodesData[opt.value]) {
      selector.removeChild(opt);
    }
  });

  // Add options for newly discovered nodes
  Object.keys(nodesData).forEach(nodeId => {
    if (!selector.querySelector(`option[value="${CSS.escape(nodeId)}"]`)) {
      const node = nodesData[nodeId];
      const option = document.createElement('option');
      option.value = nodeId;
      option.textContent = node.name;
      selector.appendChild(option);
    }
  });

  // Restore the previously selected value if still valid
  if (currentVal === 'all' || nodesData[currentVal]) {
    selector.value = currentVal;
    selectedNodeId = currentVal;
  } else {
    // Previously selected node was removed — fall back to 'all'
    selector.value = 'all';
    selectedNodeId = 'all';
  }
}

/**
 * One-time initialisation of the node selector.
 * Uses a data-bound flag to ensure the change listener is attached only once,
 * even if initNodeSelector() is ever called again (e.g. after date change).
 */
function initNodeSelector() {
  const selector = document.getElementById('nodeSelector');
  if (!selector) return;

  // Populate initial options
  refreshNodeSelectorOptions();

  // Attach the change listener only once
  if (!selector.dataset.listenerAttached) {
    selector.dataset.listenerAttached = 'true';

    selector.addEventListener('change', async (e) => {
      selectedNodeId = e.target.value;

      // Destroy all charts before re-init to avoid canvas conflicts
      if (nodeDetailTempChart) { nodeDetailTempChart.destroy(); nodeDetailTempChart = null; }
      if (nodeDetailPressureChart) { nodeDetailPressureChart.destroy(); nodeDetailPressureChart = null; }
      if (batteryDegradationChart) { batteryDegradationChart.destroy(); batteryDegradationChart = null; }
      if (tempStabilityChart) { tempStabilityChart.destroy(); tempStabilityChart = null; }
      if (signalReliabilityChart) { signalReliabilityChart.destroy(); signalReliabilityChart = null; }
      if (ruleComplianceChart) { ruleComplianceChart.destroy(); ruleComplianceChart = null; }

      // Re-render every chart for the newly selected node
      updateNodeDetails();
      await initRuleComplianceBenchmarking();
    });
  }



  const activeNodes = Object.values(nodesData).filter(n => (n.status === 'active' || n.status === 'online') && !!n.room_id).length;
  const activeNodesCountEl = document.getElementById('activeNodesCount');
  if (activeNodesCountEl) {
    activeNodesCountEl.textContent = `Monitoring ${activeNodes} nodes`;
  }

  // Initialize Date Selector
  initDateSelector();
}

function initDateSelector() {
  const dateSelect = document.getElementById('dateRangeSelect');
  if (!dateSelect) return;

  dateSelect.innerHTML = '';

  // Add 'All Time' as the first/default option so charts show data even when
  // today has no telemetry records (common during development/testing).
  const allOption = document.createElement('option');
  allOption.value = 'all';
  allOption.textContent = 'All Time';
  dateSelect.appendChild(allOption);

  // Populate the last 7 days
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const dateKey = `${year}-${month}-${day}`;

    const label = i === 0 ? 'Today' : (i === 1 ? 'Yesterday' : d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }));

    const option = document.createElement('option');
    option.value = dateKey;
    option.textContent = label;
    dateSelect.appendChild(option);
  }

  // Default to 'Today' instead of 'All Time'
  const today = new Date();
  const tYear = today.getFullYear();
  const tMonth = String(today.getMonth() + 1).padStart(2, '0');
  const tDay = String(today.getDate()).padStart(2, '0');
  dateSelect.value = `${tYear}-${tMonth}-${tDay}`;

  dateSelect.addEventListener('change', async () => {
    // Destroy existing charts to prevent Chart.js canvas overlap glitches
    if (tempChart) tempChart.destroy();
    if (pressureChart) pressureChart.destroy();
    if (pressureHeatmapChart) pressureHeatmapChart.destroy();
    if (nodeDetailTempChart) nodeDetailTempChart.destroy();
    if (nodeDetailPressureChart) nodeDetailPressureChart.destroy();
    if (ruleComplianceChart) ruleComplianceChart.destroy();
    if (batteryDegradationChart) batteryDegradationChart.destroy();
    if (tempStabilityChart) tempStabilityChart.destroy();
    if (roomHealthRadarChart) roomHealthRadarChart.destroy();
    if (signalReliabilityChart) signalReliabilityChart.destroy();

    // When date changes, refresh all analytics data
    await updateMultiNodeData();
    await initAnalytics();

  });
}

function updateMultiNodeSummary() {
  const nodes = Object.values(nodesData);
  const activeNodes = nodes.filter(n => (n.status === 'active' || n.status === 'online') && !!n.room_id);

  const avgTempSource = activeNodes
    .map(n => Number(n.currentTemp))
    .filter(value => Number.isFinite(value));
  const avgTemp = avgTempSource.length > 0
    ? avgTempSource.reduce((sum, value) => sum + value, 0) / avgTempSource.length
    : null;
  const avgTempEl = document.getElementById('avgTempAllNodes');
  if (avgTempEl) {
    avgTempEl.textContent = avgTemp === null
      ? '--°C'
      : `${Math.round(avgTemp)}°C`;
  }

  const peakPressureSource = nodes
    .map(n => Number(n.currentPressure))
    .filter(value => Number.isFinite(value));
  const peakPressure = peakPressureSource.length > 0
    ? Math.max(...peakPressureSource)
    : null;
  const peakPressureEl = document.getElementById('peakPressureAllNodes');
  if (peakPressureEl) {
    peakPressureEl.textContent = peakPressure === null
      ? '-- kPa'
      : `${peakPressure.toFixed(1)} kPa`;
  }

  const activeUnitsEl = document.getElementById('activeUnitsCount');
  if (activeUnitsEl) {
    activeUnitsEl.textContent = activeNodes.length;
  }

  const criticalCount = nodes.filter(n => n.efficiency < 80 || n.currentTemp > 28).length;
  const criticalAlertsEl = document.getElementById('criticalAlertsCount');
  if (criticalAlertsEl) {
    criticalAlertsEl.textContent = criticalCount;
  }

  const activeControlsBadge = document.getElementById('activeControlsBadge');
  if (activeControlsBadge) {
    activeControlsBadge.textContent = activeNodes.length;
  }

  const activeUnitsStatusEl = document.getElementById('activeUnitsStatus');
  if (activeUnitsStatusEl) {
    activeUnitsStatusEl.textContent = activeNodes.length > 0 ? 'Online' : 'Idle';
  }

  const criticalAlertsStatusEl = document.getElementById('criticalAlertsStatus');
  if (criticalAlertsStatusEl) {
    criticalAlertsStatusEl.textContent = criticalCount > 0 ? 'Investigate' : 'Clear';
  }
}

function initNodePerformanceRanking() {
  const container = document.getElementById('nodePerformanceContainer');
  if (!container) return;

  container.innerHTML = '';
  const sorted = Object.values(nodesData).sort((a, b) => b.efficiency - a.efficiency);

  sorted.forEach((node, index) => {
    const statusColor = node.efficiency >= 90 ? 'from-green-500 to-green-600' :
      node.efficiency >= 80 ? 'from-yellow-500 to-yellow-600' : 'from-red-500 to-red-600';
    const statusText = node.efficiency >= 90 ? 'Optimal' : node.efficiency >= 80 ? 'Good' : 'Needs Attention';

    const rowDiv = document.createElement('div');
    rowDiv.className = 'flex items-center gap-4 p-4 bg-slate-700/30 rounded-lg border border-slate-700 hover:border-slate-600 transition-colors cursor-pointer';
    rowDiv.onclick = () => {
      document.getElementById('nodeSelector').value = node.id;
      updateNodeDetails();
    };

    rowDiv.innerHTML = `
      <div class="text-lg font-bold text-cyan-400 min-w-[2rem]">#${index + 1}</div>
      <div class="flex-1">
        <div class="font-semibold text-gray-200">${node.name}</div>
        <div class="text-xs text-gray-500">Temp: ${node.currentTemp}&deg;C | Airflow: ${node.currentPressure.toFixed(1)} kPa | Battery: ${Math.round((node.battery / 4.2) * 100)}%</div>
      </div>
      <div class="text-right">
        <div class="flex items-center gap-2">
          <div style="width: 120px; height: 8px;" class="bg-slate-700 rounded-full overflow-hidden">
            <div style="width: ${node.efficiency}%" class="h-full bg-gradient-to-r ${statusColor} transition-all duration-500"></div>
          </div>
          <span class="text-sm font-bold text-gray-200 min-w-[3rem]">${node.efficiency}%</span>
        </div>
        <span class="text-xs text-gray-400 block mt-1">${statusText}</span>
      </div>
      <span class="text-2xl ${node.status === 'active' || node.status === 'online' ? 'text-green-400' : 'text-red-400'}">●</span>
    `;

    container.appendChild(rowDiv);
  });
}

function initPressureHeatmap() {
  const ctx = document.getElementById('pressureHeatmapChart');
  if (!ctx) return;

  const nodes = Object.values(nodesData);
  const timeLabels = [];
  for (let i = 0; i < 24; i++) {
    timeLabels.push(i + ':00');
  }

  const colors = ['#06b6d4', '#8b5cf6', '#ec4899', '#f59e0b', '#ef4444'];

  const datasets = nodes.map((node, index) => {
    const data = node.historicalData.pressures.map(p => {
      return p < 0.1 ? 0 : p < 0.5 ? 50 : 100;
    });

    return {
      label: node.name,
      data: data,
      borderColor: colors[index % colors.length],
      backgroundColor: colors[index % colors.length],
      borderWidth: 2,
      fill: true,
      tension: 0.4,
      pointRadius: 0
    };
  });

  const ct = getChartTheme();
  pressureHeatmapChart = new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: {
      labels: timeLabels,
      datasets: datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false  // Disable Chart.js legend
        },
        title: {
          display: true,
          text: 'Airflow Health Timeline (24h)',
          color: ct.isDark ? '#ffffff' : '#18392B',
          font: { size: 14, weight: 'bold' }
        },
        filler: { propagate: true }
      },
      scales: {
        y: {
          min: 0,
          max: 100,
          ticks: { color: ct.tickColor },
          grid: { color: ct.gridColor }
        },
        x: {
          ticks: { color: ct.tickColor },
          grid: { color: ct.gridColor }
        }
      }
    }
  });

  // Create HTML legend
  const legendContainer = document.getElementById('pressureChartLegend');
  if (legendContainer) {
    legendContainer.innerHTML = '';
    datasets.forEach((dataset, index) => {
      const legendItem = document.createElement('div');
      legendItem.className = 'flex items-center gap-2';
      legendItem.innerHTML = `
        <div style="width: 12px; height: 12px; background-color: ${dataset.borderColor}; border: 2px solid ${dataset.borderColor};"></div>
        <span class="text-white font-semibold text-sm">${dataset.label}</span>
      `;
      legendContainer.appendChild(legendItem);
    });
  }
}

function updateNodeDetails() {
  const fallbackNode = Object.values(nodesData)[0];
  const node = selectedNodeId === 'all' ? fallbackNode : nodesData[selectedNodeId];
  if (!node) return;

  // Update the node name label (if it exists in the DOM)
  const nodeName = document.getElementById('currentNodeName');
  if (nodeName) {
    nodeName.textContent = selectedNodeId === 'all' ? 'All AC Control Nodes' : node.name;
  }

  // KPI stats — use the selected node's latest values
  const tempEl = document.getElementById('nodeCurrentTemp');
  const pressEl = document.getElementById('nodeCurrentPressure');
  const battPctEl = document.getElementById('nodeBatteryPercent');
  const rssiEl = document.getElementById('nodeRSSI');

  if (tempEl) tempEl.textContent = (Number(node.currentTemp) || 0).toFixed(1) + '°C';
  if (pressEl) pressEl.textContent = (Number(node.currentPressure) || 0).toFixed(1) + ' kPa';

  // Convert voltage to percentage (3.0V = 0 %, 4.7V = 100 %)
  const batteryPercent = Math.max(0, Math.min(100,
    ((Number(node.battery) - 3.0) / (4.7 - 3.0)) * 100
  ));
  if (battPctEl) {
    battPctEl.textContent = batteryPercent.toFixed(0) + '%';
    battPctEl.className = 'text-2xl font-bold mb-2 ' + (
      batteryPercent >= 60 ? 'text-green-400' :
        batteryPercent >= 30 ? 'text-yellow-400' : 'text-red-400'
    );
  }
  if (rssiEl) rssiEl.textContent = (Number(node.rssi) || 0).toFixed(0) + ' dBm';

  // Destroy existing chart instances before re-creating to avoid canvas conflicts
  if (nodeDetailTempChart) { nodeDetailTempChart.destroy(); nodeDetailTempChart = null; }
  if (nodeDetailPressureChart) { nodeDetailPressureChart.destroy(); nodeDetailPressureChart = null; }
  if (batteryDegradationChart) { batteryDegradationChart.destroy(); batteryDegradationChart = null; }
  if (tempStabilityChart) { tempStabilityChart.destroy(); tempStabilityChart = null; }
  if (signalReliabilityChart) { signalReliabilityChart.destroy(); signalReliabilityChart = null; }

  // Re-render every chart scoped to the selected node
  initNodeDetailTempChart();
  initNodeDetailPressureChart();
  initBatteryDegradationChart();
  initTempStabilityChart();
  initSignalReliabilityChart();
  // Compliance chart is async; called separately to avoid blocking KPI updates
  initRuleComplianceBenchmarking();
  updateAllChartsTheme();
}


function getFilteredNodeHistory(node) {
  const rawTimestamps = Array.isArray(node.historicalData?.rawTimestamps)
    ? node.historicalData.rawTimestamps
    : [];
  const temps = Array.isArray(node.historicalData?.temps) ? node.historicalData.temps : [];
  const pressures = Array.isArray(node.historicalData?.pressures) ? node.historicalData.pressures : [];

  const tempResult = getFilteredSeries(temps, rawTimestamps, analyticsPeriod);
  const pressureResult = getFilteredSeries(pressures, rawTimestamps, analyticsPeriod);
  const fallbackLabels = Array.isArray(node.historicalData?.timestamps)
    ? node.historicalData.timestamps.slice(-tempResult.values.length)
    : [];
  const labels = tempResult.labels.length > 0
    ? tempResult.labels
    : (pressureResult.labels.length > 0 ? pressureResult.labels : fallbackLabels);

  return {
    labels,
    temps: tempResult.values,
    pressures: pressureResult.values
  };
}

function initNodeDetailTempChart() {
  const ctx = document.getElementById('nodeDetailTempChart');
  if (!ctx) return;

  const node = selectedNodeId === 'all' ? Object.values(nodesData)[0] : nodesData[selectedNodeId];
  if (!node) return;

  const history = getFilteredNodeHistory(node);

  if (nodeDetailTempChart) nodeDetailTempChart.destroy();
  const ct = getChartTheme();

  nodeDetailTempChart = new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: {
      labels: history.labels,
      datasets: [{
        label: 'Temperature (°C)',
        data: history.temps,
        borderColor: '#06b6d4',
        backgroundColor: 'rgba(6, 182, 212, 0.1)',
        tension: 0.4,
        fill: true,
        pointRadius: 2,
        pointBackgroundColor: '#06b6d4'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          beginAtZero: true,
          max: 35,
          ticks: { color: ct.tickColor },
          grid: { color: ct.gridColor }
        },
        x: {
          ticks: { color: ct.tickColor },
          grid: { color: ct.gridColor }
        }
      }
    }
  });
}

function initNodeDetailPressureChart() {
  const ctx = document.getElementById('nodeDetailPressureChart');
  if (!ctx) return;

  const node = selectedNodeId === 'all' ? Object.values(nodesData)[0] : nodesData[selectedNodeId];
  if (!node) return;

  const history = getFilteredNodeHistory(node);

  if (nodeDetailPressureChart) nodeDetailPressureChart.destroy();
  const ct = getChartTheme();

  nodeDetailPressureChart = new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: {
      labels: history.labels,
      datasets: [{
        label: 'Airflow Pressure (kPa)',
        data: history.pressures,
        borderColor: '#8b5cf6',
        backgroundColor: 'rgba(139, 92, 246, 0.1)',
        tension: 0.4,
        fill: true,
        pointRadius: 2,
        pointBackgroundColor: '#8b5cf6'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { color: ct.tickColor },
          grid: { color: ct.gridColor }
        },
        x: {
          ticks: { color: ct.tickColor },
          grid: { color: ct.gridColor }
        }
      }
    }
  });
}

// ===== RULE COMPLIANCE BENCHMARKING =====
async function initRuleComplianceBenchmarking() {
  const ctx = document.getElementById('ruleComplianceChart');
  if (!ctx) return;

  let rooms = [];
  let rules = [];
  let telemetryItems = [];
  let notificationsList = [];

  try {
    let roomsResult = [];
    let rulesResult = [];
    let nodesResult = [];
    let floorsResult = [];
    let buildingsResult = [];

    let notificationsResult = [];

    if (window.electron && typeof window.electron.invoke === 'function') {
      try {
        const [rData, notifRes] = await Promise.all([
          window.electron.invoke('rules-fetch-data'),
          window.electron.invoke('notifications-fetch-all')
        ]);
        if (rData && rData.success) {
          roomsResult = rData.rooms || [];
          rulesResult = rData.rules || [];
          nodesResult = rData.nodes || [];
          floorsResult = rData.floors || [];
          buildingsResult = rData.buildings || [];
        }
        if (notifRes && notifRes.success) {
          notificationsResult = notifRes.data || [];
        }
      } catch (ipcErr) {
        console.warn('IPC fetch error in analytics.js, fallback to sb:', ipcErr);
      }
    }

    if (!rulesResult.length && sb) {
      const [rRes, rulRes, nRes, fRes, bRes, notifRes] = await Promise.all([
        sb.from('rooms').select('*').order('created', { ascending: false }),
        sb.from('rules').select('*').order('created', { ascending: false }),
        sb.from('nodes').select('*'),
        sb.from('floors').select('*'),
        sb.from('buildings').select('*'),
        sb.from('notifications').select('*').order('created', { ascending: false })
      ]);
      roomsResult = rRes.data || [];
      rulesResult = rulRes.data || [];
      nodesResult = nRes.data || [];
      floorsResult = fRes.data || [];
      buildingsResult = bRes.data || [];
      notificationsResult = notifRes?.data || [];
    }

    rooms = roomsResult || [];
    rules = rulesResult || [];
    const allNodes = (nodesResult && nodesResult.length > 0) ? nodesResult : [];
    telemetryItems = globalTelemetryItems;
    const rawNotifs = (notificationsResult || []).filter(notif => notif.type !== 'controller_installation');
    notificationsList = rawNotifs.map(notif => {
      let content = notif.content || '';
      if (typeof content === 'string' && content.startsWith('__INBOX_DISMISSED__|||')) {
        content = content.replace('__INBOX_DISMISSED__|||', '');
      }
      return { ...notif, content };
    });
    if (typeof getStoredViolationAuditHistory === 'function') {
      const auditViolations = getStoredViolationAuditHistory();
      auditViolations.forEach(av => {
        const exists = notificationsList.some(n =>
          (n.id && av.id && String(n.id) === String(av.id)) ||
          (n.date === av.date && n.time === av.time && String(n.room_id) === String(av.room_id) && n.content === av.content)
        );
        if (!exists) notificationsList.push(av);
      });
    }

    // Create mapping dictionaries for hierarchy
    const buildingsMap = {};
    if (buildingsResult) buildingsResult.forEach(b => buildingsMap[b.id] = b.name);

    const floorsMap = {};
    if (floorsResult) floorsResult.forEach(f => floorsMap[f.id] = { name: f.name, building_id: f.building_id });

function formatTitleCase(str) {
  if (!str) return '';
  return String(str)
    .replace(/[_-]+/g, ' ')
    .replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
    .trim();
}

    rooms.forEach(r => {
      r.nodes = allNodes.filter(n => n.room_id === r.id);

      // Store ladder hierarchy
      const floor = floorsMap[r.floor_id];
      const rawBuilding = (floor && buildingsMap[floor.building_id]) || r.building_name || r.building || (buildingsResult && buildingsResult[0]?.name) || 'Main Campus';
      const rawFloor = (floor && floor.name) || r.floor_name || r.floor || 'First Floor';
      const rawRoom = r.name || r.room_name || r.id || 'Room';

      const bName = formatTitleCase(rawBuilding);
      const fName = formatTitleCase(rawFloor);
      const rName = formatTitleCase(rawRoom);

      r.buildingName = bName;
      r.floorName = fName;
      r.roomName = rName;
      r.fullName = `${bName} › ${fName} › ${rName}`;

      if (rawBuilding === 'Unknown Building' && rawFloor === 'Unknown Floor') {
        r.ladderLabel = [rName];
      } else if (rawBuilding === 'Unknown Building') {
        r.ladderLabel = [rName, fName];
      } else {
        r.ladderLabel = [rName, `${bName} • ${fName}`];
      }
    });

    if (selectedNodeId !== 'all') {
      rooms = rooms.filter(r => r.nodes.some(n => n.id === selectedNodeId));
    }

    // Fetch rule_nodes from Supabase
    try {
      let ruleNodes = [];
      if (sb) {
        const { data: rnData } = await sb.from('rule_nodes').select('*');
        if (rnData) ruleNodes = rnData;
      }
      rules.forEach(r => {
        r.nodeIds = ruleNodes.filter(rn => rn.rule_id === r.id).map(rn => rn.node_id);
      });
    } catch (ruleNodeErr) {
      console.warn('rule_nodes unavailable, using rule room_id only:', ruleNodeErr.message);
      rules.forEach(r => { r.nodeIds = r.nodeIds || []; });
    }
  } catch (error) {
    console.warn('Rule compliance load error:', error);
    return;
  }

  // Filter ONLY actively enabled rules!
  // A rule that is disabled in the rules modal must NEVER evaluate violations,
  // count breaches against live telemetry, or trigger violation records.
  const activeEnabledRules = rules.filter(r => isRuleActiveAndEnabled(r));
  const disabledRuleIds = new Set(rules.filter(r => !isRuleActiveAndEnabled(r)).map(r => String(r.id)));

  // Environmental / compliance violation rules (temperature threshold alerts)
  // Note: Battery rules are device notifications only, NOT room violations.
  const complianceViolationRules = activeEnabledRules.filter(r => r.type !== 'battery');
  const batteryRuleIds = new Set(rules.filter(r => r.type === 'battery').map(r => String(r.id)));

  const roomLabels = [];
  const complianceValues = [];
  const barColors = [];
  const borderColors = [];
  const roomMeta = [];

  let totalCompliance = 0;
  let complianceCount = 0;
  let nonCompliantRooms = 0;
  let violatingNodesTotal = 0;
  let roomsNoRules = 0;

  rooms.forEach(room => {
    const parsedNodes = parseRoomNodes(room.nodes);
    let roomHasRules = false;
    let nodesEvaluated = 0;
    let nodesViolating = 0;
    const violatingNodeKeys = new Set();

    // Collect all configured rule IDs (active and historical) and node identifiers for this room
    const allRoomRuleIds = new Set(rules.filter(r => r.room_id === room.id || r.room === room.id).map(r => String(r.id)));
    const roomRuleIds = new Set(complianceViolationRules.filter(r => r.room_id === room.id || r.room === room.id).map(r => String(r.id)));
    const roomNodeKeys = new Set();
    parsedNodes.forEach(node => {
      const nName = typeof node === 'string' ? node : node.name;
      const nId = typeof node === 'object' ? node.id : node;
      if (nName) roomNodeKeys.add(String(nName).toLowerCase());
      if (nId) roomNodeKeys.add(String(nId).toLowerCase());
    });

    parsedNodes.forEach(node => {
      const nodeId = typeof node === 'string' ? node : (node.name || node.id);
      const nodePbId = typeof node === 'object' ? node.id : node;
      if (!nodeId) return;

      // Battery rules are excluded: only check compliance violation rules
      const nodeRules = getApplicableRules(complianceViolationRules, room.id, nodeId, nodePbId);
      if (nodeRules.length > 0) roomHasRules = true;

      const telemetry = latestByNode[nodeId] || latestByNode[nodePbId];
      if (!telemetry || nodeRules.length === 0) return;

      nodesEvaluated += 1;
      const violated = nodeRules.some(rule => isRuleViolated(rule, telemetry));
      if (violated) {
        nodesViolating += 1;
        violatingNodeKeys.add(String(nodeId).toLowerCase());
      }
    });

    // Count all triggered notifications for this room (each notification = 1 violation)
    // Note: Battery alerts and routine schedule notices (wake/sleep) are NOT room violations.
    // Historical violations must be preserved even if the specific rule is currently disabled.
    const roomTriggeredNotifs = notificationsList.filter(notif => {
      if (notif.triggered === false) return false;

      // Battery alerts are device notifications only, NOT room violations
      if (isBatteryNotification(notif, batteryRuleIds)) return false;

      // Routine schedule alerts (wake up, sleep time, schedules) are NOT room violations
      if (isRoutineScheduleNotification(notif)) return false;

      // Must match this room
      const matchesRoom = (
        (notif.room_id && String(notif.room_id) === String(room.id)) ||
        (notif.roomId && String(notif.roomId) === String(room.id)) ||
        (notif.room && String(notif.room) === String(room.id))
      );

      // 1. Direct rule ID match (environmental compliance rules)
      if (notif.rule_id && allRoomRuleIds.has(String(notif.rule_id))) return true;

      // 2. Direct room match: ONLY if content is an environmental threshold breach
      if (matchesRoom) {
        const text = String(notif.content || notif.message || '').toLowerCase();
        const isViolationContent = (
          text.includes('temperature') ||
          text.includes('temp ') ||
          text.includes('threshold') ||
          text.includes('breach') ||
          text.includes('went above') ||
          text.includes('went below') ||
          text.includes('condition:')
        );
        if (isViolationContent) return true;
      }

      // 3. Node ID match (only if explicit violation content)
      const notifNode = notif.node_id || notif.node || notif.control;
      if (notifNode && roomNodeKeys.has(String(notifNode).toLowerCase())) {
        const text = String(notif.content || notif.message || '').toLowerCase();
        const isViolationContent = (
          text.includes('temperature') ||
          text.includes('temp ') ||
          text.includes('threshold') ||
          text.includes('breach') ||
          text.includes('went above') ||
          text.includes('went below') ||
          text.includes('condition:')
        );
        if (isViolationContent) return true;
      }

      return false;
    });

    const triggeredNotifCount = roomTriggeredNotifs.length;

    // Extract unique nodes that triggered notifications
    roomTriggeredNotifs.forEach(notif => {
      const text = String(notif.content || notif.message || '').toLowerCase();
      for (const nKey of roomNodeKeys) {
        if (nKey && text.includes(nKey)) {
          violatingNodeKeys.add(nKey);
        }
      }
      const notifNode = notif.node_id || notif.node || notif.control;
      if (notifNode && roomNodeKeys.has(String(notifNode).toLowerCase())) {
        violatingNodeKeys.add(String(notifNode).toLowerCase());
      }
    });

    // Every notification triggered counts as a violation (preserve historical count + active)
    const violations = Math.max(triggeredNotifCount, nodesViolating);

    if (!roomHasRules && triggeredNotifCount === 0) {
      roomsNoRules += 1;
      return; // Skip drawing rooms with no rules and no violations
    }

    if (violations !== null) {
      totalCompliance += violations; // Using this as sum of violations
      complianceCount += 1;
      if (violations > 0) nonCompliantRooms += 1;
    }

    violatingNodesTotal += violatingNodeKeys.size > 0 ? violatingNodeKeys.size : nodesViolating;

    roomLabels.push(room.ladderLabel || [room.roomName || room.name || room.id]);
    complianceValues.push(violations);

    // Determine color based on violations with modern palette
    let color = 'rgba(244, 63, 94, 0.88)'; // Rose for >2
    let borderCol = '#e11d48';
    if (violations === 0) {
      color = 'rgba(16, 185, 129, 0.88)'; // Emerald for 0
      borderCol = '#059669';
    } else if (violations <= 2) {
      color = 'rgba(245, 158, 11, 0.88)'; // Amber for 1-2
      borderCol = '#d97706';
    }

    barColors.push(color);
    borderColors.push(borderCol);

    roomMeta.push({
      violations,
      triggeredNotifs: triggeredNotifCount,
      nodesEvaluated,
      nodesViolating,
      hasRules: roomHasRules,
      buildingName: room.buildingName,
      floorName: room.floorName,
      roomName: room.roomName,
      fullName: room.fullName
    });
  });

  const totalAllViolations = totalCompliance;

  // Update Summary Metrics
  const avgEl = document.getElementById('totalViolations');
  const nonCompliantEl = document.getElementById('nonCompliantRooms');
  const violatingEl = document.getElementById('violatingNodes');
  const noRulesEl = document.getElementById('roomsNoRules');
  const countBadge = document.getElementById('monitoredRoomsCountBadge');

  if (avgEl) avgEl.textContent = totalAllViolations;
  if (nonCompliantEl) nonCompliantEl.textContent = nonCompliantRooms;
  if (violatingEl) violatingEl.textContent = violatingNodesTotal;
  if (noRulesEl) noRulesEl.textContent = roomsNoRules;
  if (countBadge) {
    countBadge.textContent = `${roomLabels.length} Monitored Room${roomLabels.length === 1 ? '' : 's'}`;
  }

  // Dynamically set container height so 1 room looks compact and sleek, and multiple rooms scale naturally
  const chartWrapper = document.getElementById('ruleComplianceChartWrapper') || ctx.parentElement;
  const emptyStateEl = document.getElementById('ruleComplianceEmptyState');

  if (roomLabels.length === 0) {
    if (emptyStateEl) emptyStateEl.classList.remove('hidden');
    if (ctx) ctx.style.display = 'none';
    if (chartWrapper) chartWrapper.style.height = 'auto';
    return;
  } else {
    if (emptyStateEl) emptyStateEl.classList.add('hidden');
    if (ctx) ctx.style.display = 'block';
  }

  if (chartWrapper) {
    let computedHeight = 135;
    if (roomLabels.length === 1) {
      computedHeight = 125;
    } else if (roomLabels.length === 2) {
      computedHeight = 175;
    } else {
      computedHeight = Math.min(650, Math.max(140, roomLabels.length * 52 + 50));
    }
    chartWrapper.style.height = `${computedHeight}px`;
  }

  const isDark = localStorage.getItem('ecoTrackTheme') === 'dark' || document.documentElement.classList.contains('dark');
  const maxVal = Math.max(0, ...complianceValues);

  if (ruleComplianceChart) ruleComplianceChart.destroy();
  ruleComplianceChart = new Chart(ctx.getContext('2d'), {
    type: 'bar',
    data: {
      labels: roomLabels,
      datasets: [{
        label: 'Total Violations',
        data: complianceValues,
        backgroundColor: barColors,
        borderColor: borderColors,
        borderWidth: 1.5,
        borderRadius: 8,
        borderSkipped: false,
        minBarLength: 6,
        maxBarThickness: 24
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: {
          left: 6,
          right: 20,
          top: 6,
          bottom: 6
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: isDark ? 'rgba(12, 19, 40, 0.95)' : 'rgba(255, 255, 255, 0.96)',
          titleColor: isDark ? '#38bdf8' : '#0f172a',
          bodyColor: isDark ? '#cbd5e1' : '#334155',
          borderColor: isDark ? 'rgba(56, 189, 248, 0.25)' : 'rgba(0, 0, 0, 0.1)',
          borderWidth: 1,
          cornerRadius: 8,
          padding: 12,
          boxPadding: 4,
          callbacks: {
            title: (tooltipItems) => {
              const item = tooltipItems[0];
              if (!item) return '';
              const meta = roomMeta[item.dataIndex];
              return meta?.roomName || (Array.isArray(item.label) ? item.label[0] : String(item.label || ''));
            },
            beforeBody: (tooltipItems) => {
              const item = tooltipItems[0];
              const meta = roomMeta[item.dataIndex];
              if (meta && meta.buildingName && meta.floorName) {
                return `📍 ${meta.buildingName} • ${meta.floorName}`;
              }
              return '';
            },
            label: (context) => {
              const meta = roomMeta[context.dataIndex];
              if (!meta) return 'No active rules or data';
              const statusText = meta.violations > 2 ? '⚠️ Critical' : meta.violations > 0 ? '⚡ Warning' : '✅ Compliant';
              return [
                `Violations: ${meta.violations}`,
                `Active Nodes: ${meta.nodesEvaluated}`,
                `Status: ${statusText}`
              ];
            }
          }
        }
      },
      scales: {
        x: {
          beginAtZero: true,
          suggestedMax: Math.max(4, maxVal + 1),
          ticks: {
            color: isDark ? '#94a3b8' : '#64748b',
            font: {
              size: 11,
              weight: '600',
              family: "'Manrope', 'Inter', system-ui, sans-serif"
            },
            stepSize: 1,
            precision: 0
          },
          grid: {
            color: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.05)',
            drawBorder: false
          },
          title: {
            display: true,
            text: 'Violations Count',
            color: isDark ? '#64748b' : '#94a3b8',
            font: {
              size: 11,
              weight: '600',
              family: "'Manrope', system-ui, sans-serif"
            },
            padding: { top: 6 }
          }
        },
        y: {
          ticks: {
            color: isDark ? '#f1f5f9' : '#1e293b',
            font: {
              size: 12,
              weight: '700',
              family: "'Manrope', 'Inter', system-ui, -apple-system, sans-serif"
            },
            lineHeight: 1.35,
            padding: 12,
            crossAlign: 'far',
            autoSkip: false
          },
          grid: {
            display: false
          }
        }
      }
    }
  });
  updateAllChartsTheme();
}

function parseRoomNodes(nodesField) {
  if (!nodesField) return [];
  if (Array.isArray(nodesField)) return nodesField;
  if (typeof nodesField === 'string') {
    try {
      return nodesField ? JSON.parse(nodesField) : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

function getApplicableRules(rules, roomId, nodeId, nodePbId = null) {
  return rules.filter(rule => {
    // Strictly require the rule to be associated with this room if specified
    if (rule.room_id && rule.room_id !== roomId) return false;

    // Check if the rule specifically targets this node (by hardware ID or UUID)
    const targetsNode = (rule.nodeIds && (rule.nodeIds.includes(nodeId) || (nodePbId && rule.nodeIds.includes(nodePbId)))) ||
                        (rule.nodes && (rule.nodes.includes(nodeId) || (nodePbId && rule.nodes.includes(nodePbId))));

    // Check if the rule is room-wide (no specific nodes selected)
    const isRoomWide = (!rule.nodeIds || rule.nodeIds.length === 0) && (!rule.nodes || rule.nodes.length === 0);

    return targetsNode || isRoomWide;
  });
}

function isRuleActiveAndEnabled(rule) {
  if (!rule) return false;
  if (rule.enabled === false || rule.enabled === 'false' || rule.enabled === 0) return false;
  if (rule.active === false || rule.active === 'false' || rule.active === 0) return false;
  if (rule.status === 'disabled' || rule.status === 'inactive') return false;
  return true;
}

function isRuleViolated(rule, telemetry) {
  if (!telemetry || !rule) return false;
  // A rule that is disabled in the rules modal must NEVER evaluate violations
  if (!isRuleActiveAndEnabled(rule)) return false;

  // Battery rules are device notifications only, NOT compliance violations
  if (rule.type === 'battery') return false;

  if (rule.type === 'temperature') {
    const temp = Number(telemetry.temperature ?? telemetry.temp);
    if (Number.isNaN(temp)) return false;
    const ruleValue = normalizeTemperatureRuleValue(rule.value, rule.unit);
    if (rule.condition === 'above') return temp > ruleValue;
    if (rule.condition === 'below') return temp < ruleValue;
    return false;
  }

  return false;
}

function isBatteryNotification(notif, batteryRuleIds = new Set()) {
  if (!notif) return false;
  if (notif.rule_id && batteryRuleIds.has(String(notif.rule_id))) return true;
  const text = String(notif.content || notif.message || notif.title || '').toLowerCase();
  if (text.includes('battery')) return true;
  return false;
}

function isRoutineScheduleNotification(notif) {
  if (!notif) return false;
  if (notif.type === 'schedule' || notif.category === 'schedule' || notif.is_schedule) return true;
  if (notif.type === 'wake' || notif.type === 'sleep' || notif.type === 'system') return true;

  const text = String(notif.content || notif.message || notif.title || '').toLowerCase();
  return (
    text.includes('wake') ||
    text.includes('sleep') ||
    text.includes('schedule') ||
    text.includes('scheduled') ||
    text.includes('scheduler') ||
    text.includes('interval') ||
    text.includes('cycle') ||
    text.includes('routine')
  );
}

function normalizeTemperatureRuleValue(value, unit) {
  const numericValue = Number(value);
  if (Number.isNaN(numericValue)) return 0;
  if (unit === '°F') return (numericValue - 32) * (5 / 9);
  return numericValue;
}

function getComplianceColor(compliance) {
  if (compliance === null) return '#475569';
  if (compliance >= 90) return '#22c55e';
  if (compliance >= 70) return '#f59e0b';
  return '#ef4444';
}

function updateComplianceSummary(avgCompliance, nonCompliantRooms, violatingNodes, roomsNoRules) {
  const avgEl = document.getElementById('avgCompliance');
  const nonCompliantEl = document.getElementById('nonCompliantRooms');
  const violatingEl = document.getElementById('violatingNodes');
  const noRulesEl = document.getElementById('roomsNoRules');

  if (avgEl) avgEl.textContent = `${avgCompliance}%`;
  if (nonCompliantEl) nonCompliantEl.textContent = nonCompliantRooms;
  if (violatingEl) violatingEl.textContent = violatingNodes;
  if (noRulesEl) noRulesEl.textContent = roomsNoRules;
}

// ===== ADVANCED ANALYTICS =====

function formatDateTimeShort(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function initBatteryDegradationChart() {
  const ctx = document.getElementById('batteryDegradationChart');
  if (!ctx) return;
  if (batteryDegradationChart) {
    batteryDegradationChart.destroy();
  }

  const telemetryItems = globalTelemetryItems;

  let nodes = [...new Set(telemetryItems.map(t => t.node_id).filter(Boolean))];
  if (selectedNodeId !== 'all') {
    nodes = nodes.filter(id => id === selectedNodeId);
  }

  const timeSet = new Set();
  telemetryItems.forEach(t => timeSet.add(new Date(t.created).getTime()));
  const sortedTimes = Array.from(timeSet).sort((a, b) => a - b);
  const labels = sortedTimes.map(ms => formatDateTimeShort(ms));

  const datasets = nodes.map((nodeId, idx) => {
    const nodeData = telemetryItems.filter(t => t.node_id === nodeId).sort((a, b) => new Date(a.created) - new Date(b.created));
    const colors = ['#22c55e', '#06b6d4', '#8b5cf6', '#f97316', '#ec4899', '#eab308'];
    const color = colors[idx % colors.length];

    // Map data to labels to ensure alignment using exact ms timestamps
    const dataMap = {};
    nodeData.forEach(t => {
      const ms = new Date(t.created).getTime();
      const b = t.battery || 0;
      dataMap[ms] = b <= 5 ? Math.round((b / 4.2) * 100) : b;
    });
    const data = sortedTimes.map(ms => dataMap[ms] !== undefined ? dataMap[ms] : null);

    return {
      label: nodesData[nodeId] ? nodesData[nodeId].name : nodeId,
      data: data,
      borderColor: color,
      backgroundColor: color + '20',
      borderWidth: 2,
      tension: 0.4,
      pointRadius: 0,
      pointHitRadius: 10,
      fill: false,
      spanGaps: true
    };
  });

  const ct = getChartTheme();
  batteryDegradationChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { mode: 'index', intersect: false }
      },
      scales: {
        x: { grid: { color: ct.gridColor }, ticks: { color: ct.tickColor, maxTicksLimit: 8 } },
        y: { min: 0, max: 100, grid: { color: ct.gridColor }, ticks: { color: ct.tickColor, callback: v => v + '%' } }
      }
    }
  });
}

async function initTempStabilityChart() {
  const ctx = document.getElementById('tempStabilityChart');
  if (!ctx) return;
  if (tempStabilityChart) {
    tempStabilityChart.destroy();
  }

  let rooms = [];
  let telemetryItems = globalTelemetryItems;
  try {
    let rRes = [];
    let nRes = [];
    if (sb) {
      const [rData, nData] = await Promise.all([
        sb.from('rooms').select('*'),
        sb.from('nodes').select('*')
      ]);
      rRes = rData.data || [];
      nRes = nData.data || [];
    }
    rooms = rRes || [];
    const allNodes = nRes || [];
    rooms.forEach(r => {
      r.nodes = allNodes.filter(n => n.room_id === r.id);
    });
  } catch (e) {
    rooms = [];
  }

  // Pick the first room with nodes that actually have telemetry data
  let room = null;
  let nodeId = null;
  let nodeData = [];

  for (const r of rooms) {
    const nodes = typeof r.nodes === 'string' ? JSON.parse(r.nodes || '[]') : r.nodes;
    if (!Array.isArray(nodes) || nodes.length === 0) continue;

    for (const n of nodes) {
      const nId = typeof n === 'string' ? n : n.id;
      if (!nId) continue;

      // If filtering by specific node, skip others
      if (selectedNodeId !== 'all' && nId !== selectedNodeId) continue;

      const data = telemetryItems.filter(t => t.node_id === nId).sort((a, b) => new Date(a.created) - new Date(b.created));
      if (data.length > 0) {
        room = r;
        nodeId = nId;
        nodeData = data;
        break;
      }
    }
    if (room) break;
  }

  // Fallback if room mapping fails
  if (!room || nodeData.length === 0) {
    let fallbackNodeIds = [...new Set(telemetryItems.map(t => t.node_id).filter(Boolean))];
    if (selectedNodeId !== 'all') {
      fallbackNodeIds = fallbackNodeIds.filter(id => id === selectedNodeId);
    }
    if (fallbackNodeIds.length > 0) {
      nodeId = fallbackNodeIds[0];
      nodeData = telemetryItems.filter(t => t.node_id === nodeId).sort((a, b) => new Date(a.created) - new Date(b.created));
      room = { target_temperature: 24 };
    } else {
      return;
    }
  }

  const target = parseFloat(room.target_temperature) || 24;
  const labels = nodeData.map(t => formatDateTimeShort(t.created));
  const data = nodeData.map(t => t.temperature);

  const ct = getChartTheme();
  tempStabilityChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Target Temp',
          data: labels.map(() => target),
          borderColor: '#f97316',
          borderWidth: 2,
          borderDash: [5, 5],
          pointRadius: 0,
          fill: false
        },
        {
          label: 'Actual Temp',
          data: data,
          borderColor: '#06b6d4',
          backgroundColor: 'rgba(6, 182, 212, 0.15)',
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: ct.legendColor, font: { weight: 'bold' } } } },
      scales: {
        x: { grid: { color: ct.gridColor }, ticks: { color: ct.tickColor, maxTicksLimit: 8 } },
        y: { grid: { color: ct.gridColor }, ticks: { color: ct.tickColor, callback: v => Number(v).toFixed(1) + '°C' } }
      }
    }
  });

  const inputEl = document.getElementById('targetTempInput');
  if (inputEl) {
    inputEl.value = target;
    inputEl.addEventListener('input', (e) => {
      const newTarget = parseFloat(e.target.value);
      if (!isNaN(newTarget) && tempStabilityChart) {
        tempStabilityChart.data.datasets[0].data = tempStabilityChart.data.labels.map(() => newTarget);
        tempStabilityChart.update('none');
      }
    });
  }
}

async function initRoomRadarChart() {
  const ctx = document.getElementById('roomHealthRadarChart');
  if (!ctx) return;

  let rooms = [];
  let telemetryItems = [];
  try {
    let rRes = [];
    let tRes = [];
    let nRes = [];

    const fetchOps = [];
    if (sb) {
      fetchOps.push(sb.from('rooms').select('*'));
      fetchOps.push(sb.from('nodes').select('*'));
    }
    if (pb && typeof pb.collection === 'function') {
      fetchOps.push(pb.collection('telemetry').getList(1, 200, { sort: '-created' }));
    }

    const results = await Promise.all(fetchOps);
    if (sb) {
      rRes = results[0]?.data || [];
      nRes = results[1]?.data || [];
      tRes = results[2]?.items || [];
    } else {
      tRes = results[0]?.items || [];
    }

    rooms = rRes || [];
    telemetryItems = tRes || [];
    const allNodes = nRes || [];
    rooms.forEach(r => {
      r.nodes = allNodes.filter(n => n.room_id === r.id);
    });
  } catch (e) {
    rooms = [];
    telemetryItems = [];
  }

  const roomLabels = [];
  const tempScores = [];
  const battScores = [];
  const rssiScores = [];
  const compScores = [];

  rooms.forEach(room => {
    roomLabels.push(room.room_name || `Room ${room.id}`);
    const rNodes = typeof room.nodes === 'string' ? JSON.parse(room.nodes || '[]') : room.nodes;

    let tempSum = 0, battSum = 0, rssiSum = 0, count = 0;

    rNodes.forEach(n => {
      const nid = n.id || n;
      const latest = telemetryItems.find(t => t.node_id === nid);
      if (latest) {
        const diff = Math.abs((latest.temperature || 24) - (room.target_temperature || 24));
        tempSum += Math.max(0, 100 - (diff * 15)); // Harsher penalty
        battSum += latest.battery || 100;
        let rssiScore = (((latest.rssi || -70) + 100) / 70) * 100;
        rssiSum += Math.min(100, Math.max(0, rssiScore));
        count++;
      }
    });

    tempScores.push(count ? Math.round(tempSum / count) : 0);
    battScores.push(count ? Math.round(battSum / count) : 0);
    rssiScores.push(count ? Math.round(rssiSum / count) : 0);
    const complianceScore = count ? Math.round(((tempSum / count) * 0.6) + ((battSum / count) * 0.4)) : 100;
    compScores.push(complianceScore);
  });

  const ct = getChartTheme();
  roomHealthRadarChart = new Chart(ctx, {
    type: 'radar',
    data: {
      labels: roomLabels,
      datasets: [
        { label: 'Temp Stability', data: tempScores, borderColor: '#f97316', backgroundColor: 'rgba(249, 115, 22, 0.2)', borderWidth: 2 },
        { label: 'Battery Health', data: battScores, borderColor: '#22c55e', backgroundColor: 'rgba(34, 197, 94, 0.2)', borderWidth: 2 },
        { label: 'Signal Quality', data: rssiScores, borderColor: '#3b82f6', backgroundColor: 'rgba(59, 130, 246, 0.2)', borderWidth: 2 },
        { label: 'Compliance', data: compScores, borderColor: '#a855f7', backgroundColor: 'rgba(168, 85, 247, 0.2)', borderWidth: 2 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        r: {
          angleLines: { color: ct.radarAngleLines },
          grid: { color: ct.radarGrid },
          pointLabels: { color: ct.textColor, font: { size: 11, weight: 'bold' } },
          ticks: { display: false, min: 0, max: 100 }
        }
      },
      plugins: { legend: { position: 'bottom', labels: { color: ct.legendColor, font: { size: 10, family: 'Inter, sans-serif', weight: 'bold' } } } }
    }
  });
}

async function initSignalReliabilityChart() {
  const ctx = document.getElementById('signalReliabilityChart');
  if (!ctx) return;
  if (signalReliabilityChart) {
    signalReliabilityChart.destroy();
  }

  const telemetryItems = globalTelemetryItems;

  let nodes = [...new Set(telemetryItems.map(t => t.node_id).filter(Boolean))];
  if (selectedNodeId !== 'all') {
    nodes = nodes.filter(id => id === selectedNodeId);
  }

  const timeSet = new Set();
  telemetryItems.forEach(t => timeSet.add(new Date(t.created).getTime()));
  const sortedTimes = Array.from(timeSet).sort((a, b) => a - b);
  const labels = sortedTimes.map(ms => formatDateTimeShort(ms));

  const datasets = nodes.map((nodeId, idx) => {
    const nodeData = telemetryItems.filter(t => t.node_id === nodeId).sort((a, b) => new Date(a.created) - new Date(b.created));
    const colors = ['#3b82f6', '#06b6d4', '#6366f1', '#a855f7', '#ec4899', '#f43f5e'];
    const color = colors[idx % colors.length];

    const dataMap = {};
    nodeData.forEach(t => {
      const ms = new Date(t.created).getTime();
      dataMap[ms] = t.rssi;
    });
    const data = sortedTimes.map(ms => dataMap[ms] !== undefined ? dataMap[ms] : null);

    return {
      label: nodesData[nodeId] ? nodesData[nodeId].name : nodeId,
      data: data,
      borderColor: color,
      backgroundColor: color + '20',
      borderWidth: 2,
      tension: 0.4,
      pointRadius: 0,
      fill: false,
      spanGaps: true
    };
  });

  const ct = getChartTheme();
  signalReliabilityChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { mode: 'index', intersect: false }
      },
      scales: {
        x: { grid: { color: ct.gridColor }, ticks: { color: ct.tickColor, maxTicksLimit: 8 } },
        y: { max: -30, min: -100, grid: { color: ct.gridColor }, ticks: { color: ct.tickColor, callback: v => v + ' dBm' } }
      }
    }
  });
}
