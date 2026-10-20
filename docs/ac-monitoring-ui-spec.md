# Current workspace UI acceptance specification

Source: the user's mode, scheduler, forecast, Analytics and Telemetry references.
The desktop Sensor repository is a read-only layout reference. The mobile project
is not the reference. Dedicated sensor firmware remains excluded.

- Use the controller shell, theme tokens, sidebar and dialog conventions.
- Admin Profile → Device Mode offers Controller, Monitoring and Both. Every
  selection shows preparation, persists locally and synchronizes windows.
  Keep Account, Security and Login Activity. Remove Settings and Open workspace.
- Sensor Monitoring appears above Control Center. It contains Analytics,
  Telemetry and Sensor Energy Forecast. Register AC Devices is shared: put its
  single link under System & Logs in Monitoring mode, Devices & IR otherwise.
- One AC Device Scheduler appears under System & Logs in every mode. Redirect
  the former sensor scheduler URL to it. Keep Rules Management unchanged.
- Scheduler uses the supplied building/floor/room cabinet, bordered matrix,
  horizontal table scrolling and pagination. Use the registered AC name.
  Controller keeps Target Temp, Control Mode, Power Mode and seconds. Monitoring
  and Both hide those fields and use Minutes and Hours. Preserve saved sub-minute
  cadence as fractional minutes. Missing configuration stays Not set.
- Device State means Online, Sleeping, Offline or Unknown from connectivity
  evidence. Keep unknown connection information unknown. Queued configuration
  is not physically confirmed; report sensor/controller delivery separately.
- Sensor Energy Forecast matches the controller header, four KPI cards and three
  charts. Include Top Consumers, shared tariff, green PDF/Excel, and icon refresh.
  Its second header row has Filter Sensor, date selector, custom date, time range
  and clear action. Apply selection to table, charts, summaries and all export rows.
- Remove CSV from the sensor forecast UI. Always retain all 12 table headers,
  including when empty. Empty PDF/Excel exports contain headers and an empty status.
- Analytics has a compact two-row header with its sensor/date filters inside it.
  Remove the three quick-link pills. Temperature charts use a 0–40 °C empty scale
  and measured bounds when populated. State history displays Cool, Fan Only, ON,
  OFF: mode comes from explicitly reported mode; power from independent feedback.
  Unknown/mixed observations stay gaps, never an invented state.
- Telemetry follows the desktop Sensor cabinet/interface/card format. Its final
  layout has two panels, filling the desktop's available height. The Location
  cabinet matches the scheduler reference: building header, nested floor and
  selectable room cards. Include registered rooms even before sensor readings.
  Remove Available AC Sensors, the sensor dropdown and Register AC Sensor button.
  Keep real metric cards and accessible read-only details.
- Rename AC Controller Devices to Register AC Devices. Hide its IR Monitoring
  column in Monitoring and Both modes. Keep Controller functionality and routing otherwise.
- Remove routine local-backend/cloud-backup text from sensor screens. Keep real
  errors visible and connection status available to assistive technology.
- Refresh controls use icons, accessible labels and actual reload actions.
- Keep controller HGB and sensor XGBoost independent. Missing model inputs mean
  unavailable energy/cost; do not invent values or rank consumers without kWh.
- Preserve null/zero, historical snapshots, credentials, local-first reads and
  confirmed-power runtime with timestamp/cadence and gap handling.
- Verify dark/light desktop/mobile layouts, filters, dialogs, focus, refresh,
  offline operation, exports, mode changes and absence of document overflow.

## Final screenshot corrections and device-role registration

- Scheduler has separate Aircon Name and AC Device Name columns, Minutes/Hours
  in all modes (Seconds only Controller), a compact unit menu, no default
  delivery/equal-time notes, and mode-specific empty wording/action.
- Notification/Scheduler/Telemetry cabinets share nested building/floor/room
  styling and selected room cards. Telemetry removes All locations and selects
  an available room. Legacy combined display locations parse into real levels.
- Sensor pages/manual refreshes and scheduler loads use skeletons.
- Controller/Both remove Remote Layout, handset imagery, Desktop Standard
  switcher, previous/next selector arrows and quick power pill.
- Sensor forecast empty logs retain the centered icon/title/description but
  remove Jump to Today and Clear Filters. Tariff/Top Consumers use actual
  controller dialog markup. PDF/Excel follow the controller report design while
  exporting only selected sensor records and honest missing estimates.
- Maintenance says AC Sensor Device in Monitoring, AC Device in Both, and
  AC Controller in Controller; records and selections follow actual device roles.
- Registration Details requires Monitoring Only / Control Only / Both Controlling
  and Monitoring. Monitoring roles request actual pressure sensor metadata;
  Monitoring Only omits IR and never claims the AC control assignment. The
  named mobile Control repository has the same picker/registration behavior.
- Register AC Devices filters rows/totals by saved role. Missing legacy roles are
  Controller. Monitoring includes Monitoring/Both, Controller includes
  Controller/Both, Both includes all. Hide IR Monitoring in Monitoring/Both.
- Registration badges show each step number once; Cancel has a visible outline.
- Shared cloud migration 20261019230000_ac_device_roles.sql is identical in both
  repositories and was applied after explicit user approval. Shared Supabase
  migration history records version 20261019162831 / ac_device_roles. Fields,
  constraints, trigger and RPC authorization were verified; existing node/AC
  identities and assignments were preserved. No firmware/physical success is
  claimed. See REPORT.md for current verification evidence.


## Latest accepted sensor corrections

- Use concise forecast KPI labels; the full-width experimental/field-unverified banner is removed at the user's request. Keep confirmed power/runtime distinct from modeled energy.
- Empty energy/cost/combined charts have centered short text with hidden grid/axes. Remove obsolete input-contract wording and the redundant correlation/banner block.
- Sensor PDF/Excel export shows the controller download modal design. The bar must have visible fill, stage-based progress and functional Cancel/Escape; no download follows cancellation/failure.
- PDF and Excel follow the controller's report formatting with monitoring output. PDF includes sensor summaries, estimates, directory/ranking, energy/cost profiles, first/final readings, aggregation and visual/model analytics. The complete raw telemetry table remains in Excel's 12-column log sheet. Remove the old five-paragraph notes block.
- Telemetry counts sensor device cards once, regardless of their temperature/pressure components. Omit the AC Device eyebrow and hardware model labels from cards; preserve actual roles/configuration in Details. Use two device cards per desktop row, one column on narrow containers, and vertical scrolling inside the card container; do not synthesize readings.
- Active sensor estimation uses the selected experimental NREL-trained XGBoost, independently from the controller/legacy artifacts. The training report defines inputs, units and limitations.

- Telemetry schedule previews follow actual saved scheduler data, including registered shared-device wake/sleep/interval fields. Missing fields stay Not set; requested configuration never proves hardware application.
- Telemetry AC Power displays Not reported without measured ON/OFF feedback and No recent feedback for stale reported states. Confirmed ON/OFF requires fresh actual feedback; do not infer it from a schedule or command.
