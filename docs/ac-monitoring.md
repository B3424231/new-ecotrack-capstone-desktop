# AC Monitoring

This module measures outlet temperature, airflow differential pressure and optional
independent AC power feedback. It has no IR or climate-command endpoints and
does not fabricate electrical kWh. Sensor Energy Forecast has an independent XGBoost service;
its incomplete legacy input/training contract keeps energy unavailable.
Dedicated ESP32 monitor firmware and
physical sensor validation are intentionally excluded from this implementation.

## Pages and identity

- `public/analytics.html`: sensor summaries, temperature/pressure, reported mode and confirmed power history.
- `public/telemetry.html`: Location cabinet, real metric cards and read-only sensor details.
- `public/scheduler.html`: shared AC Device Scheduler; the old sensor scheduler URL redirects here.
- `public/sensor-logs.html`: controller forecast template, sensor table and exports.
- `public/profile.html#device-mode`: Controller / Monitoring / Both and preparation modal.

The previous custom three-page UI and frontend module were removed at the user's
request. The measurement API/storage remains compatible and preserves recorded data.
Its calibration/credential/deactivation API contracts remain for existing integrations;
the custom management screens were removed.

AC sensors and AC Controller Devices remain separate. A sensor has its
own UUID and display name and references the real AC asset's database ID. One
active monitor is allowed per AC. Reassigning a monitor preserves the aircon ID
and name stored on historical samples; old samples do not become current readings
for the replacement assignment.

Device setup uses the existing authenticated administrator IPC guard. The main
process verifies the AC against the existing registry. The renderer never
receives the local administrator credential. Setup therefore needs the existing
online administrator verification; paired-device ingestion and local reading and
analytics do not depend on internet access.

## Local data path

```text
Physical monitor -> authenticated local LAN upload -> Flask -> SQLite
                                                      |
                                                local read API -> desktop UI
SQLite outbox -> optional background HTTPS backup -> Supabase
```

The Flask startup adds `monitor_nodes`, `monitor_calibrations`, `monitor_samples`,
`monitor_sync_outbox` and `monitor_sync_status`. It does not change existing
control records or restore the old control-telemetry pressure column.
`ECOTRACK_SQLITE_DB_PATH` continues to select the database.

New monitors start with identity corrections in factory engineering units, not a
claim of field calibration. Corrections are:

```text
temperature = raw_temperature_c + temperature_offset_c
pressure = (raw_pressure_pa - pressure_offset_pa) * pressure_scale
```

Field calibration is versioned by observation time. Buffered older measurements
use the applicable historical version, and saved measurements are immutable.
No airflow threshold is assumed until an administrator records one. Below-baseline
readings describe a measurement; they are not a diagnosis of a dirty filter.

## Ingestion contract for future firmware

`POST /api/monitoring/telemetry`, with a JSON content type and the per-device
credential in `Authorization: Bearer <device credential>`. The credential is
shown once during registration/replacement, stored only as a hash locally, and
excluded from cloud backup and read APIs. Credential replacement uses the existing authenticated rotate-token API. Do not embed a Supabase service credential in firmware.

The following is a contract template, not recorded sensor data:

```json
{
  "device_id": "<monitor UUID>",
  "samples": [{
    "boot_id": "<unique boot identity>",
    "sequence": 0,
    "uptime_ms": 0,
    "observed_at": null,
    "clock_quality": "unsynchronized",
    "interval_seconds": 5,
    "outlet_temperature_c": null,
    "differential_pressure_pa": null,
    "temperature_quality": "missing",
    "pressure_quality": "missing",
    "ac_on": null,
    "state_source": null
  }]
}
```

Send the actual recorded cadence as `interval_seconds`; the value above only
illustrates the contract. Up to 500 samples/512 KiB may be uploaded atomically.
`device_id + boot_id + sequence` is an immutable identity. Identical retries are
ignored; conflicting reuse rejects the entire batch. Distinct boot identities
are required across reboots.

When synchronized, use `clock_quality: synchronized` and a timezone-bearing
ISO-8601 `observed_at` at or after the Unix epoch. `received_at` is recorded independently by the server.
Unsynchronized records remain stored with null observation times and are excluded
from date-based analytics/export, rather than being assigned invented times.
The device's latest status can report Time unavailable. Future firmware should
obtain time from a trusted local source and retain timestamps when buffering.

Values must be finite JSON numbers or null. Sensor quality accepts `ok`,
`missing` or `fault`; out-of-range corrected values are retained as raw data with
an `out_of_range` quality and null usable measurement. Real zero remains zero.
MCP9808 values are checked against its operating range; pressure limits are
configured per device. Sensor hardware must be calibrated/validated separately.

`ac_on` accepts true/false only with the configured `power_meter` or
`isolated_contact` source. With feedback source `none`, it must remain null.
Commands, IR transmission, connectivity, temperature and pressure are not power
confirmation. Confirmed unit-hours are calculated from bounded recorded
intervals, stop at intervening unknown/conflicting readings, and exclude gaps.

## Read APIs

Read routes are limited to loopback clients and reject unrelated web origins.
LAN devices can upload with their own credential but cannot administer/read the
desktop. Proxies must not overwrite peer identities; X-Forwarded-For is not used
as authorization.

| Route | Purpose |
| --- | --- |
| `GET /api/monitoring/devices` | Devices, latest readings, freshness and backup status |
| `GET /api/monitoring/devices/{id}/calibrations` | Calibration audit history |
| `GET /api/monitoring/analytics` | Sample statistics, bounded runtime and up to ~301 chart buckets |
| `GET /api/monitoring/telemetry` | History; `page`, `per_page` (maximum 200) |
| `GET /api/monitoring/export.csv` | Stream all matching timestamped records with formula-safe text |

Analytics/history/export accept `aircon_id`, `node_id`, `from` and `to`. Times
must include a timezone; `from` is inclusive and `to` exclusive. The UI displays
UTC+08:00. Chart points represent sample means per plotted bucket; missing
buckets remain gaps. History plots Cool/Fan Only and confirmed ON/OFF separately. Missing or mixed values stay gaps.

Latest-reading freshness uses observation time and a bound of three expected
reporting intervals (minimum 15 seconds). Late uploads cannot make old readings
look current. The desktop never uses cloud online status as physical AC state.
The local backend must be running, and LAN delivery requires local networking
even when internet service is unavailable.

## Optional cloud backup

The CLI-generated `supabase/migrations/20261019104744_ac_monitoring.sql` is supplied
for review and has not been applied automatically. It creates three cloud-copy
tables with RLS, administrator-only authenticated reads, and backend service-role
upserts. There are no anonymous grants or direct device cloud writes.

The additive `20261019160000_monitor_reported_mode.sql` adds the nullable mode
column for optional backup; it is also supplied for review and has not been run.
After reviewing/applying both migrations in the intended project, configure the existing
backend `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, and set
`ECOTRACK_MONITOR_SYNC=1`. Restart Flask. Keep the service credential only in the
backend environment. The default is disabled and no environment file is changed
by the feature. Disabling backup does not prevent local recording.

The durable outbox sends nodes, calibration versions and samples in insertion
order using idempotent IDs. It removes an item only after HTTP success; outages
retain both the local record and its pending backup. Local rendering never
waits for backup. This is an outbound backup, not multi-desktop bidirectional
replication.

## Validation

```powershell
venv\Scripts\python.exe scripts/test_monitoring.py
node scripts/test_monitoring_ipc.js
node scripts/test_sensor_workspace_browser.js
node scripts/test_monitoring_native.js
```

The browser script accepts `ECOTRACK_PLAYWRIGHT` for a preinstalled Playwright
module and `ECOTRACK_QA_BROWSER` for Chrome's executable. All fixtures stay in
temporary databases/profiles. No test should send measurements to production or
claim physical sensor behavior has been verified.

## Reported mode and local clock filters

Device telemetry may include `operating_mode: "cool"`, `"fan_only"`, or null.
Omission is backward compatible and old rows stay null. This is a device report,
not independent electrical evidence. Do not infer a mode from outlet temperature,
differential pressure, connectivity, IR transmission, desired state, or `ac_on`.
A bucket only reports a mode when every sample in it reports the same mode.
The optional mode column does not supply the legacy XGBoost `status_mode` feature.

Read/analytics/export filters accept optional `start_time` / `end_time` in HH:MM,
UTC+08:00. The end minute is inclusive, matching controller filters. An overnight
range uses the evening and morning portions of each local day. One-sided ranges
are supported. Calendar `from` remains inclusive and `to` exclusive. Runtime is
clipped to the time windows and each recorded interval; gaps are not filled.
The calendar selector offers recent calendar periods plus a custom date; it does
not claim that each offered period contains measurements.

Telemetry no longer contains Available AC Sensors, a sensor dropdown, or a
registration action. Register AC Devices is shared navigation. The existing
sensor registry/provisioning API remains distinct from the controller registry;
renaming/moving navigation does not invent sensor hardware or merge UUIDs.
