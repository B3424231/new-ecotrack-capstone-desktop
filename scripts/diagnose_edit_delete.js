const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const logFile = path.join(__dirname, 'diagnose_edit_delete.log');
fs.writeFileSync(logFile, 'Diagnosis started at ' + new Date().toISOString() + '\n');

function log(msg) {
  console.log(msg);
  fs.appendFileSync(logFile, msg + '\n');
}

app.on('ready', async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../src/preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  win.webContents.on('console-message', (e, level, msg, line, source) => {
    log(`[PAGE LOG level=${level}] ${msg} (${source}:${line})`);
  });

  await win.loadFile(path.join(__dirname, '../public/staff.html'));
  log('Loaded staff.html');

  setTimeout(async () => {
    try {
      const pageInfo = await win.webContents.executeJavaScript(`
        (() => {
          const reports = window.EcoTrackMaintenance ? window.EcoTrackMaintenance.getReports() : [];
          const rep = reports.find(r => r.id === 'REP-TEST-VERIFY-1790834512059');
          const row = document.querySelector('tr td:first-child');
          const allRowIds = Array.from(document.querySelectorAll('#pageReportTableBody tr td:nth-child(1), #pageReportTableBody tr td:nth-child(2)')).map(td => td.textContent.trim());
          return {
            reportsCount: reports.length,
            targetReport: rep,
            tableRowsCount: document.querySelectorAll('#pageReportTableBody tr').length,
            allRowIdsSample: allRowIds.slice(0, 10)
          };
        })()
      `);
      log('Page Info:\n' + JSON.stringify(pageInfo, null, 2));

      // Now test clicking Edit on REP-TEST-VERIFY-1790834512059
      log('\n--- TESTING EDIT ON REP-TEST-VERIFY-1790834512059 ---');
      const editResult = await win.webContents.executeJavaScript(`
        (() => {
          try {
            window.EcoTrackMaintenance.openEditModal('REP-TEST-VERIFY-1790834512059');
            const createModal = document.getElementById('ecoCreateReportModal');
            const repairModal = document.getElementById('ecoEditRepairTaskModal');
            return {
              createModalVisible: createModal && !createModal.classList.contains('hidden') && createModal.style.display !== 'none',
              repairModalVisible: repairModal && !repairModal.classList.contains('hidden') && repairModal.style.display !== 'none',
              createModalTitle: document.getElementById('ecoCreateModalTitle')?.textContent,
              repairModalHeader: document.getElementById('ecoEditRepairTaskModalHeader')?.innerText?.slice(0, 100)
            };
          } catch (e) {
            return { error: e.stack };
          }
        })()
      `);
      log('Edit Result:\n' + JSON.stringify(editResult, null, 2));

      // Close modals
      await win.webContents.executeJavaScript(`
        (() => {
          const c = document.getElementById('ecoCreateReportModal');
          if (c) { c.classList.add('hidden'); c.style.display = 'none'; }
          const r = document.getElementById('ecoEditRepairTaskModal');
          if (r) { r.classList.add('hidden'); r.style.display = 'none'; }
        })()
      `);

      // Now test clicking Delete on REP-TEST-VERIFY-1790834512059
      log('\n--- TESTING DELETE ON REP-TEST-VERIFY-1790834512059 ---');
      const deleteResult = await win.webContents.executeJavaScript(`
        (async () => {
          try {
            // First simulate clicking delete button
            const rows = Array.from(document.querySelectorAll('#pageReportTableBody tr'));
            const targetRow = rows.find(r => r.innerText.includes('REP-TEST-VERIFY-1790834512059'));
            const deleteBtn = targetRow ? targetRow.querySelector('button[title=\"Delete Report\"]') : null;
            if (deleteBtn) {
              deleteBtn.click();
            } else {
              deleteReportPrompt('REP-TEST-VERIFY-1790834512059');
            }
            const modal = document.getElementById('deleteReportModal');
            const modalVisible = modal && !modal.classList.contains('hidden') && modal.style.display !== 'none';
            const modalMsg = document.getElementById('deleteReportModalMessage')?.innerText;

            // Now call confirmDeleteReportAction()
            await confirmDeleteReportAction();

            // Check if report still exists in getReports() and in table
            const afterReports = window.EcoTrackMaintenance ? window.EcoTrackMaintenance.getReports() : [];
            const stillInCache = afterReports.some(r => r.id === 'REP-TEST-VERIFY-1790834512059');
            const stillInDOM = Array.from(document.querySelectorAll('#pageReportTableBody tr')).some(r => r.innerText.includes('REP-TEST-VERIFY-1790834512059'));

            return {
              modalVisible,
              modalMsg,
              stillInCache,
              stillInDOM,
              afterCount: afterReports.length
            };
          } catch (e) {
            return { error: e.stack };
          }
        })()
      `);
      log('Delete Result:\n' + JSON.stringify(deleteResult, null, 2));

    } catch (e) {
      log('Error during test: ' + e.stack);
    }
    app.quit();
    process.exit(0);
  }, 4000);
});
