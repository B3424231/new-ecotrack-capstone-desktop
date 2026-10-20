# EcoTrack device modes and sensor workspace verification

Latest update: the six follow-up workflow defects are fixed and regression-tested.
See [Desktop workflow follow-up fixes](reports/desktop-workflow-followup-fixes-20261020/REPORT.md)
for current database delivery, validation and publication details. The sections
below retain the evidence and scope of the earlier workspace changes.

Date: 20 October 2026 (Asia/Singapore). Target: controller desktop repository. The supplied desktop
Sensor repository was used read-only; the mobile project was not used as the UI
reference. Existing user changes were preserved. No commit, push, dependency
change, data replacement or firmware change was made. The approved additive
shared cloud device-role migration was applied on 20 October 2026.

## Delivered

Admin Profile → Device Mode retains Controller, Monitoring and Both, local
persistence, a preparation modal for every selection, window synchronization,
route guards and storage-failure handling. The Settings entry and Open workspace
button were removed. Rules Management retains its behavior.

Sensor Monitoring appears above Control Center. Register AC Devices replaces
AC Controller Devices in the sidebar and page heading. It has one shared link:
under System & Logs in Monitoring mode and Devices & IR in the other modes.
The device table filters saved roles before totals and pagination: Monitoring
includes Monitoring Only/Both, Controller includes Control Only/Both, and Both
includes all. Legacy nodes without a role remain controllers. IR Monitoring is
hidden in Monitoring and Both.

AC Device Scheduler is the single shared scheduler under System & Logs. The old
sensor scheduler URL redirects to it. The supplied controller cabinet/table UI
is preserved, including building/floor/room nesting, pagination and horizontal
scrolling. Rows separate registered Aircon Name and AC Device Name. Controller retains climate fields and
seconds; Monitoring/Both hide Target Temp, Control Mode and Power Mode and expose
Minutes and Hours. Existing sub-minute intervals remain visible as fractional minutes,
without changing the stored cadence. Missing intervals say Not set. Real
connectivity distinguishes Online, Sleeping, Offline and Unknown. Both merges
an exact controller/sensor AC pair into one row while preserving each delivery
status; queued commands/local configuration are not physical acknowledgments.

Sensor Energy Forecast reuses the controller header and four-KPI/three-chart
layout, with Top Consumers, shared tariff, highlighted PDF/Excel and icon refresh.
The filter row matches the supplied controller reference: sensor, date selector,
custom date, time range and clear action. Filters use UTC+08:00 and apply to the
local table, summaries and exports. Overnight and one-sided ranges are supported.
Runtime uses recorded timestamps/cadence, clips observation windows, and excludes
gaps. All 12 table headings remain present when empty. CSV is removed from the
UI. PDF exports controller-format sensor analysis and estimate coverage; Excel retains all selected raw rows. Empty reports preserve truthful availability.
Top Consumers and Electricity Tariff clone the actual controller dialog markup.
PDF/Excel use its cover, palette, section/table and workbook design with sensor
fields/data. Top Consumers keeps unavailable kWh truthful. The sensor table has
a centered icon/title/description empty state without the two shortcut buttons.

Telemetry follows the desktop Sensor interface and metric-card format. The final
layout has a Location cabinet and AC Sensor Interface, filling available desktop
height and stacking on narrow screens. All locations was removed. The shared cabinet CSS matches Notifications and the scheduler's
building/floor/room reference and shows real cached/authenticated rooms even
without sensor observations. Available AC Sensors, the All Sensors dropdown and
Register AC Sensor action were removed. Read-only details use a keyboard-friendly
dialog. Device registration navigation remains on Register AC Devices; existing
sensor provisioning APIs remain separate and compatible.

Analytics now has a compact forecast-style two-row header with its sensor/date
filters inside the header. Its former quick-link pills are removed. Empty
temperature charts use 0–40 °C, while real values determine populated bounds.
The history chart includes Cool, Fan Only, ON and OFF. Optional device-reported
`operating_mode` supplies Cool/Fan Only; independently confirmed `ac_on` supplies
ON/OFF. Mixed/missing buckets remain gaps. The mode field is additive/nullable,
old rows stay null, and legacy duplicate fingerprints remain compatible.

Initial/manual sensor refreshes and scheduler loads show skeletons. Location
selection, nesting, padding and selected room cards match across Notifications,
Scheduler and Telemetry. Legacy display locations are parsed into actual
building/floor/room parts; incomplete locations are flat Unassigned entries.
The scheduler hides default delivery notes and the equal-wake/sleep helper, uses
a compact interval dropdown, and provides mode-specific no-location/empty-room
wording and registration actions.
Controller and Both use desktop AC controls directly; Remote Layout, its imagery,
the layout switcher, selector arrows and quick power pill are removed.

Maintenance uses AC Sensor Device in Monitoring, AC Device in Both and AC
Controller in Controller. Device choices/reports use the real saved role. Sensor
diagnostics use actual fresh local readings, with pressure in Pa; zero is retained.

Registration Details requires AC Device: Monitoring Only, Control Only or Both
Controlling and Monitoring. Sensor roles require the actual pressure model/range
and omit IR registration for Monitoring Only. Step badges no longer duplicate
numbers and Cancel has a visible neutral border. The same role picker and RPC
behavior are implemented in the explicitly authorized mobile Control project,
`C:/Users/reygay/Desktop/EcoTrackAppMobileNew-master-control`. No mobile Sensor
project was edited.

Routine local-backend/cloud-backup text is removed from visual sensor flows;
real errors remain visible and connection status remains available to assistive
technology. Visible refresh controls are icons with accessible labels and actual
reload handlers. A dropdown layout issue was fixed by containing the hidden
native selects and stabilizing their options; filter controls no longer overlap.

## Data/model limits

The controller HGB and original sensor XGBoost remain independent. The original
sensor artifact needs ten inputs including undocumented pressure/previous-energy
features. That legacy path remains unavailable for missing inputs. The later
user-approved NREL comparison selected a separate temperature-history XGBoost
estimator, described below. No production training data, physical power or
temperatures were invented.
Reported mode is not mapped to the legacy model's undocumented `status_mode`.

SQLite adds the nullable reported-mode field at startup. Optional cloud backup
migration `20261019160000_monitor_reported_mode.sql` is supplied for review and
was not run. Local reads never wait for cloud backup. Sensor firmware, physical
calibration and hardware schedule application remain unverified/excluded.

## Verification

All tests used disposable SQLite databases/profiles or in-memory fixtures and
blocked/mocked external traffic. No live device or account was mutated.

| Check | Result | Coverage |
| --- | --- | --- |
| `scripts/test_monitoring.py` | PASS, 23 tests | Authentication, null/zero, history, duplicates, calibration, cadence/runtime, reported modes, same-minute/overnight/one-sided time filters, exports, schedules, independent models, optional backup fixtures |
| `scripts/test_monitoring_ipc.js` | PASS | Actual administrator guard, verified AC identity, loopback/credential boundary, insert-only controller-free assets |
| `scripts/test_sensor_workspace_browser.js` | PASS, 16 scenarios | Six mode transitions, shared registration placement, offline and storage errors, real temporary API, 58-row logs, empty/full PDF/Excel, filters, refreshed data, chart states, keyboard/dialogs, desktop/mobile dark/light, no document overflow |
| `scripts/test_device_scheduler_browser.js` | PASS, 12 cases | Three modes × two widths × two themes; single AC row, hierarchy, fields, saved cadence, refresh, connectivity and separate transport writes |
| `scripts/test_monitoring_native.js` | PASS, 5 checks | Actual Electron file renderer/preload isolation and Admin Profile Device Mode using a temporary profile |
| `npm test` | PASS, 34 checks | Existing no-mock-data audit |
| Controller regressions | PASS | Dashboard workflows and five-page integration (40 checks) |
| JavaScript syntax / tracked diff whitespace | PASS | Changed renderer scripts parsed; `git diff --check` has only existing Git line-ending notices |
| PDF/Excel artifact integrity | PASS | PDF summary excludes raw telemetry; Excel retains 12 headings and 58 fixture data rows; PDF rendered and inspected; real zero preserved |
| Existing hardware-control baseline | FAIL, pre-existing | `scripts/test_hardware_control.js:35`: undefined differs from 'on'; retained baseline in `reports/ac-monitoring/control-baseline.json`; not introduced by these changes |
| Physical sensors, calibration, AC response | BLOCKED | No connected monitor/reference equipment; no flashing or physical-success claim |
| Shared device-role migration | PASS | Approved migration applied; fields/constraints/index/trigger, RPC permissions and signed-out rejection verified; existing node identities/AC assignments unchanged |
| Live registration/physical hardware and optional backup migration | NOT RUN | No device registration, hardware command or optional backup migration was performed |
| Registration role UI/data | PASS | 29 registration checks, 5 role transport/metadata checks, six mode/theme UI cases including mixed saved roles and sensor maintenance diagnostics |
| Mobile Control | PASS | TypeScript check, 16 existing cloud-hardware tests, actual role component rendered at 320/390 px in dark/light; static web component preview, not native phone QA |
| Installer packaging | NOT RUN | Not requested |

Latest desktop/mobile screenshots were visually inspected for Telemetry,
Analytics and Sensor Energy Forecast. Layouts use 1460/390 px in both themes.
The native Electron check used normal renderer isolation outside the restricted
terminal sandbox, with external traffic blocked and a temporary profile. No
production sandbox setting or ACL was changed.

Evidence: `reports/workspace-modes/browser-verification.json`,
`reports/workspace-modes/device-scheduler-verification.json`, page screenshots,
empty/full sensor PDF/XLSX artifacts (8/10 PDF pages, 58 Excel rows),
`ui-consistency-verification.json`, `device-role-verification.json`,
`report-integrity-verification.json`, mobile component previews, and `reports/ac-monitoring/native-startup.log`.
The accepted UI specification is `docs/ac-monitoring-ui-spec.md`.

Restart Flask and Electron to load the updated API/scripts. Device Mode remains
under Admin Profile. Sensor operating-mode values must actually be reported by
the sensor integration; existing ON/OFF feedback cannot backfill Cool/Fan Only.

## Shared cloud migration applied after explicit approval

`supabase/migrations/20261019230000_ac_device_roles.sql` was applied and is copied
identically to the mobile project optional migrations. It adds role/sensor
metadata, authorized role-aware registration RPCs and a Monitoring Only command
guard. It preserves existing assignment, credential, staff-room and heartbeat
checks, with no sample/status fabrication. The authenticated main-process mirror
imports only verified metadata into SQLite, preserving credentials/calibration
and history; it does not provision or flash sensor firmware.

Read-only inspection confirmed the prerequisite controller/IR/staff functions
and compatible schema. After the initial automatic approval rejection, the user
explicitly approved this shared database write. The reviewed SQL was applied
successfully to project `ynopdmfhngooknybyahq`, migration history version
`20261019162831`, name `ac_device_roles` (20 October 2026 in Asia/Singapore).

Verification PASS: four node role fields; validated role/FK/unique constraints;
valid monitoring-assignment index; enabled command trigger; both RPC signatures
and fixed empty search paths. Anonymous execution is denied; authenticated
execution is permitted and both functions reject a missing user session. Before/
after counts remain one node and one aircon, with identical node identity and
AC assignment digests. No existing device was reclassified as a sensor.

Security and performance advisors were run. Neither new RPC is anonymous or
has a mutable search path. The security advisor flags authenticated SECURITY
DEFINER functions: the two new RPCs deliberately use that existing registration
pattern, with the administrator/staff-room authorization helper and heartbeat/
identity checks retained. See the [advisor explanation](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable).
Other advisor findings concern unchanged objects/settings and were not modified.
This is not a claim of a clean project-wide security audit.

Role-aware saving now has its shared server dependencies. No live registration,
hardware command, sensor reading or physical BLE/Wi-Fi/temperature/pressure/IR
behavior was tested. The optional sensor reported-mode backup migration remains
unapplied. Local isolated tests do not establish physical success. Detailed
migration evidence is `reports/workspace-modes/supabase-role-migration-verification.json`.

Scoped mobile diff whitespace checks PASS. An unscoped mobile diff check finds
pre-existing trailing whitespace in unrelated firmware/home/profile files; those
files were preserved. The full sensor browser harness uses a fixed disposable
backend/browser clock so crossing midnight cannot shift fixture dates.


## Three-model sensor training and final UI corrections

The user authorized comparing three real models and enabling clearly marked experimental temperature-based estimates. The unchanged NREL BENEFIT source files supplied 341,639 laboratory observations. Random Forest, HistGradientBoosting and XGBoost were trained with experiment-based validation and purged chronological boundaries. XGBoost won the predeclared validation criterion: MAE 103.623 W versus 117.322 W and 125.002 W. The final selection did not use the held-out chronological or 115°F tests. Random Forest had a slightly lower chronological test MAE; XGBoost performed best on the wholly withheld 115°F experiment. Full metrics, source/feature contracts and limitations: [training report](reports/sensor-nrel-model/REPORT.md).

The active sensor model estimates contemporaneous electrical power from six real temperature observations spanning five minutes. It integrates eligible adjacent estimates by actual elapsed seconds and clips them to the selected period. Gaps, faults, domain violations and overlapping readings from the same AC remain excluded. This is experimental covered energy, not utility-meter consumption or a validated future forecast. Cost requires a configured tariff. Independent confirmed power alone supplies runtime and active-unit KPIs. The previous sensor pickle and controller artifacts remain preserved.

Sensor Energy Forecast now uses short KPI labels, compact experimental labels, centered empty chart states with hidden axes, and concise current availability text. The full-width notice is removed. Consumption vs Cost removes the redundant correlation/banner text. Its PDF/Excel download modal follows the controller reference, with a visible explicit gradient, stage-based progress, focus restoration and functional Cancel/Escape. Canceled/failed exports do not download files. The same explicit bar fill repairs the controller's gradient visibility.

The PDF now follows the controller's cover, summary, tables, directory/ranking, energy/cost profiles, first/final readings, aggregation, visual analytics and executive-summary format with monitoring fields and monitoring estimates. Raw Recorded sensor telemetry is Excel only. Empty and 58-row fixture reports have 8 and 10 PDF pages respectively. Excel retains Analytics & Summary and Sensor Telemetry Logs, 12 raw columns and C5 freeze panes. The requested five-paragraph notes block is removed. Rendered PDF pages and saved-workbook style previews were inspected; the latter are not native Microsoft Excel QA.

Telemetry cards show the registered name, with the actual saved role in Details. Each sensor device/card is counted once. Two device cards fit per desktop row in a vertically scrollable container; narrow layouts use one column. Hardware model names and the AC Device eyebrow are removed from cards and remain available in Details. A compact count badge, simple card accent and shorter status remove the redundant dotted container and long hardware explanation. Readings remain unavailable until actually received.

Validation PASS: 16 complete browser scenarios (real disposable Flask/SQLite; external traffic blocked), 6 mode/theme UI scenarios, 5 native Electron checks, 9 estimator/API tests, 23 monitoring API regressions, controller dashboard workflows, 40 connection checks, 34 no-mock-data checks, syntax and report structure checks. Tests use isolated fixtures only. Physical sensing/calibration, firmware flashing and packaging were NOT RUN.

## Existing device configured on explicit user request

After the user requested database configuration and confirmed the installed components, the existing node was changed from Controller to Both, linked for monitoring to the same Matrix AC, and assigned a stable monitoring UUID. Sensor metadata now specifies MCP9808 and MPX5010DP, range 0–10,000 Pa (NXP's nominal 0–10 kPa range). The existing name, node identity, room, control assignment and IR capabilities were preserved. No verification stamp, credential, heartbeat, reading or physical power state was generated or changed. The database continues to contain one node and one aircon.

The two reviewed, guarded DML statements are in reports/workspace-modes/configure-existing-ac-device-both.sql and configure-existing-ac-sensors.sql. Their verified metadata outcome is recorded in configured-device-verification.json. The nominal component range is configuration, not a completed physical calibration. No sensor capability heartbeat or telemetry has been fabricated. Restart Flask/Electron and refresh Telemetry to load the updated local scripts and authenticated registry mirror.

The running local backend was restarted with its existing virtual environment. Its live /api/monitoring/energy-model response now confirms loaded=true, model_id=nrel_benefit_temperature_power_v1, experimental=true and history_seconds=300. The first readiness probe preceded lazy model loading; an energy request loaded the checksum-verified artifact and the follow-up status passed. With no eligible real measurements, the live estimate remains unavailable (SENSOR_REFERENCE_HISTORY_UNAVAILABLE). No synthetic telemetry was inserted for this verification. See running-model-verification.json.


## Corrected sensor-device count, card grid and schedule preview

The user clarified that two sensors means two AC sensor device cards, not the temperature/pressure components inside one device. Telemetry now counts each displayed physical device once (1 sensor for the existing device). Cards omit the AC Device eyebrow and MCP9808/MPX5010DP labels; their hardware configuration remains intact and is still available in Details. The desktop grid reserves two columns, including when only one device exists, and additional cards scroll vertically inside the fixed-height container. Narrow containers use one column. Keyboard scrolling and the scroll position after refresh are covered by the browser checks.

The schedule preview previously read only local sensor_schedules, while a newly configured shared device could have its saved schedule on the registered node. Telemetry now reads the registered wake_time/sleep_time/interval_val/interval_unit without supplying defaults and merges it by the exact monitoring UUID. Both uses the controller's saved values as the shared scheduler does; an independently saved monitoring-only schedule retains priority. Missing fields remain Not set. This only displays requested configuration and does not fabricate delivery receipts or physical power feedback.

Read-only inspection of the user's existing database record confirmed wake 05:00, sleep 05:00 and interval 1 Minute. No database write was needed for this correction. The focused UI suite passed all six workspace/theme cases, including one-device counting, hidden hardware labels, two-card rows, inner scroll/refresh, responsive stacking and saved-schedule precedence. Full Flask/SQLite browser regression status is recorded in browser-verification.json.

Final correction checks: PASS all 16 real disposable Flask/SQLite browser scenarios, including the saved monitoring schedule shown in Telemetry; PASS six mode/theme UI scenarios, with desktop/mobile screenshots visually inspected. Specific count/grid/scroll/schedule evidence is in reports/workspace-modes/telemetry-card-verification.json. JavaScript syntax and tracked diff whitespace checks pass. No production records/configuration were modified for this UI correction.

Latest UI-only corrections: removed the full-width Experimental estimates / Field accuracy unverified banner and its spacing from Sensor Energy Forecast. Compact estimate labels and calculations are preserved. Telemetry Details renders the stored role both as Monitoring and Controlling, including matched local/cloud device records. No database or hardware configuration was changed. Focused browser checks verified banner removal in dark/light; role label checks cover registry-only and paired devices in both themes.

## Controller-format exports with monitoring output

Compared the actual controller PDF and Excel runtime exporters with the sensor exporters using isolated fixtures. Monitoring now shares the controller's landscape cover, typography, palette, KPI/table treatment, directory/ranking, interval profiles, first/final readings, aggregation, visual analytics and executive-summary structure. Every value remains based on the selected monitoring rows and monitoring estimate response; controller commands, settings, model outputs and installation/rule sources are not copied. The five-paragraph notes block from the user's screenshot is removed. Complete raw telemetry remains Excel only. Weekly/monthly date metadata follows the selected UTC+08 range.

Excel matches the controller's summary column widths, fonts, fills and alignment. Cost formulas reference the tariff cell, and reconciled per-sensor energies sum to the authoritative monitoring total. Native UTC+08 dates, valid zero values, missing tariffs and unavailable estimates were verified with an independent workbook reader. Both sheets retain landscape print settings and the raw sheet retains its 12 columns and C5 freeze panes.

The AC Power badge now reads Not reported without actual ON/OFF feedback, or No recent feedback for a stale known state. Fresh explicit feedback still reads Confirmed ON/OFF. No power state, telemetry, schedule or database configuration was changed.

PASS: six focused export cases, 16 complete isolated Flask/browser scenarios, 21 existing controller report checks, four focused power-feedback label states, JavaScript syntax and diff whitespace. PDF pages were rendered and inspected; saved Excel styles were compared and rendered as HTML previews, without claiming native Excel validation. The empty/full Flask fixtures produce 8/10 PDF pages and 0/58 Excel data rows. No live external requests or writes were used. Evidence and the section mapping are in reports/workspace-modes/report-format/FORMAT_COMPARISON.md, verification.json, report-integrity-verification.json and power-feedback-label-verification.json.

## Authorized legacy table consolidation

On 20 October 2026, after the user's explicit instruction, the shared database
removed the empty registration_tasks and staff_locations tables. Custom cloud
tables decreased from 26 to 24. resolve_room_maintainer(text) now reads the existing
assignment fields on staff, with room/floor/building/all priority and the existing
oldest-active fallback. Archived and inactive staff are excluded. Its owner,
signature, execute grants and security-invoker behavior were preserved; its search
path is fixed. Existing staff assignments, device/AC links, credential count and
596 telemetry records were preserved. SQLite and application UI were unchanged.

PASS: 17 isolated PostgreSQL consolidation checks, 16 controller installation
regressions and live schema/record/permission verification. The guarded migration
refuses nonempty candidates and unexpected dependencies and never uses CASCADE.
The local CLI-generated migration is 20261019180417_consolidate_staff_assignments.sql;
shared history records version 20261019181458. The schema-only rollback was tested
in isolation and was not applied to the shared project. Details, original schema
and verification evidence are in reports/database-table-consolidation/.

## Compatible duplicate-column consolidation

On 20 October 2026, the user's requested duplicate-column audit consolidated
administrators.avatar_url and nodes.image_url into the respective photo_url
fields. Administrators now have 18 columns instead of 19; nodes have 31 instead
of 32. Custom cloud tables remain 24. Conflicting nonempty aliases abort the
transaction, and canonical image values are preserved.

The two profile RPCs retain their response/authentication/storage contracts and
permissions. staff.avatar_url stays available to installed mobile queries and
the staff editor's existing version checks. Default-avatar selection is retained.
Network/protocol aliases remain active contracts and were not removed blindly.
No renderer, mobile, firmware or SQLite changes were needed for this compatible
first pass.

PASS: 13 focused PostgreSQL checks, 39 existing mobile database contract checks
with the new migration included, and live image/record/permission verification.
No new security findings. Local migration 20261019182804_consolidate_unused_photo_aliases.sql
is recorded in shared history as version 20261019183311. Evidence and the tested
schema rollback are in reports/database-column-consolidation/.


## Desktop workflow fixes — 20 October 2026

Corrected alert telemetry/source handling, overnight and UTC+08 rule windows, cloud-managed sensor retirement without deleting history, Both-mode scheduling during local outages, and Telemetry loading/card skeletons. Verification and the four unchanged legacy test failures are documented in [the workflow fix report](reports/desktop-workflow-fixes-20261020/REPORT.md). Restart the desktop and Python backend to load the changes.
