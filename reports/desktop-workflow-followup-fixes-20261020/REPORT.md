# Desktop workflow follow-up fixes

20 October 2026 · Facility timezone UTC+08:00

All six defects reproduced in the preceding workflow audit are fixed. The changes retain real telemetry, unknown power states, historical cadence and the existing controller/monitoring separation.

## Corrected behavior

| Defect | Result | Evidence |
| --- | --- | --- |
| Current-day runtime included future cadence | Confirmed and observed intervals stop at the current time or selected end, whichever is earlier. Future clock-tolerated samples do not count as elapsed feedback. | `scripts/test_followup_monitoring.py`: 30 seconds elapsed produces 30 seconds, and a future sample adds no elapsed runtime. |
| Failed target replacement erased existing rule links | Rule fields and targets commit together through an authenticated, administrator-only PostgreSQL function. A rejected insert rolls back both changes. New rules return their actual database identity. | `scripts/test_atomic_rule_workflows.js`: real in-memory PostgreSQL transactions, RLS, successful creation, rejected target and rollback checks. |
| Failed rule toggles displayed a paused state | Individual and bulk changes require complete persistence receipts before updating local state, clearing timers or broadcasting status. Pending clicks cannot overlap. Errors preserve the previous state and allow retry. | `scripts/test_workflow_followup.js`: failed individual/bulk saves, incomplete receipts, duplicate clicks and confirmed changes. |
| Rejected profile saves displayed success | The profile cache and display change only after the server confirms the matching profile ID. A failed or empty receipt shows an error and leaves the saved profile intact. | Three profile persistence cases in `scripts/test_workflow_followup.js`. |
| PDF/Excel exports accepted incomplete or changing history | The backend supplies an ingestion high-water mark; telemetry pages, analytics and modeled energy use that same bound. Export code validates total count, snapshot identity and distinct record IDs. Incomplete or changing unfrozen responses fail without downloading a partial report. | API snapshot/backfill checks and four real-browser cases in `scripts/test_workflow_followup_browser.js`. |
| A retired sensor silently became All Sensors | The selected sensor remains explicitly marked unavailable. The label, filter and displayed history continue to identify the same sensor until the user changes the selection. | Real monitoring-page browser reproduction now retains the selected identity and its two fixture records. |

## Database delivery

**PASS:** `supabase/migrations/20261020085939_atomic_rule_workflows.sql` was applied to the configured Supabase project. This additive migration introduces two functions and preserves existing tables and records. Both functions use invoker privileges, an empty search path, existing RLS and administrator checks. Post-deployment inspection confirms authenticated execution and no anonymous execution. No production rule/profile/telemetry rows were created, replaced or deleted for testing.

Security advisors still report existing findings on other functions and policies. These are outside the six audited defects; this report does not claim a complete security remediation.

## Validation

| Check | Status | Detail |
| --- | --- | --- |
| Existing core suites | PASS | 13 suites: dashboard/page connections, registration recovery, runtime, telemetry cadence, logs, deletion, notifications, prior workflow repairs, scheduler identity, operating history, Future Cost and no-mock-data verification. |
| Existing backend/model suites | PASS | Six suites: schedule forwarding, cloud telemetry sync, monitoring APIs, registry reconciliation and both selected energy model pipelines. Disposable databases and isolated network fixtures. |
| Existing browser suites | PASS | Three suites: Future Cost interactions, sensor report format and offline logs. |
| Atomic rule database checks | PASS | 12 cases, including successful creation, rollback, authorization and bulk receipts. PGlite 0.5.8 is pinned as a test-only development dependency. |
| Profile/rule renderer fault checks | PASS | Nine cases using production functions and failed/partial transport receipts. |
| Monitoring API edge cases | PASS | 27 cases including existing monitoring checks, elapsed runtime and frozen export pages. |
| Export/scope browser edge cases | PASS | Four cases; complete 201-row Excel/PDF export, rejected incomplete/changing exports and retained unavailable sensor selection. No live external requests or production writes. |
| Full monitoring workspace browser suite | PASS | 16 scenarios across modes, five screens, responsive layouts, dark/light themes, filters, schedules, reports and hanging-cloud recovery. No runtime errors or external requests. |
| Static JavaScript and page references | PASS | 44 production JavaScript files and 29 inline scripts parse; all 212 local script references resolve. |
| Firmware compile | PASS | ESP32-S3 Huge APP build with preserved private local settings: 1,492,069 bytes program storage (47%) and 50,268 bytes global memory (15%). No flashing or physical behavior claim. |
| Clean publication copy | PASS | Repeated rule transactions, profile/rule renderer checks and both model test suites from the source-only copy using the installed dependency runtimes. Required model-validation fixtures are included. |

Per-suite machine-readable results are stored beside this report. The earlier audit probes intentionally asserted the old failures and are retained locally as historical evidence, not rerun as passing regression tests.

## Publication and local setup

The requested destination was empty. Publish a clean initial source snapshot rather than carrying the old repository's browser session caches and unrelated generated artifacts into its history. Preserve the original checkout, index, existing Git history and original remote. Include current application source, firmware source, runtime models, SQL migrations, regression scripts and their small model-validation fixtures. Exclude credentials, local SQLite data, browser profiles, raw downloaded datasets, virtual environments, dependencies and generated build binaries.

Existing sketch fallback Wi-Fi values were moved into an ignored local `wifi-secrets.h` file. The publishable sketch uses the same provisioned NVS workflow and accepts the private header when present. `wifi-secrets.example.h` contains empty fallback values. The installed device was not reflashed.

After updating, restart Electron and the Flask backend so their new IPC handlers and API code load together. New installations need their own `.env`, Python virtual environment and `npm install`; the configured existing Supabase project already has the atomic functions. Review and apply the migration explicitly for a different database.

**NOT RUN:** physical ESP32/AC/IR verification, firmware flashing and packaged installer verification. Automated checks do not establish physical AC state or command receipt.

## Focused reproduction commands

```powershell
node scripts/test_atomic_rule_workflows.js
node scripts/test_workflow_followup.js
venv\Scripts\python.exe -B scripts/test_followup_monitoring.py
# With Playwright available via ECOTRACK_PLAYWRIGHT or the local package:
node scripts/test_workflow_followup_browser.js
node scripts/test_sensor_workspace_browser.js
```
