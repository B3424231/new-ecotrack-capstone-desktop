# EcoTrack project instructions

These instructions apply throughout this repository. Follow more specific
instructions in a nested `AGENTS.md` when present, and respect the user's current
request. Keep changes scoped to the requested outcome.

## Architecture and important paths

- **Electron desktop frontend:** `src/main.js` is the main process;
  `src/preload.js` exposes the renderer's IPC bridge. Pages, styling, and browser
  JavaScript live in `public/`, `public/styles.css`, and `public/js/`.
  Preserve renderer isolation and existing IPC contracts.
- **Flask backend:** `backend/app.py` provides local APIs, schedule forwarding,
  telemetry persistence, and cloud telemetry synchronization. It defaults to
  port 5000; `PORT` overrides the port. Python dependencies are in
  `requirements.txt`.
- **Supabase:** stores cloud entities such as nodes, aircons, assignments,
  schedules, and hardware telemetry. Use existing clients and authentication
  boundaries. Cloud climate commands use `aircons.desired_state`.
- **SQLite:** `backend/telemetry.db` stores local telemetry used by Daily Logs.
  `ECOTRACK_SQLITE_DB_PATH` overrides its location. The Flask backend imports
  cloud telemetry with a durable cursor and duplicate protection. In
  `public/js/supabase-client.js`, `telemetryClient` and its legacy `window.pb`
  alias route telemetry requests to the local API; cloud metadata uses the
  Supabase client.
- **ESP32-S3:** firmware is in
  `firmware/esp32s3_ecotrack_node/esp32s3_ecotrack_node.ino`. It handles measured
  telemetry, connectivity, schedules, and IR control/capture. Read the adjacent
  `README.md` before changing or building firmware.

Trace affected behavior across Control Schedules, dashboard commands, firmware,
Supabase, Flask, SQLite, and Daily Logs when a change crosses those boundaries.
Keep the controller's name distinct from its Supabase database ID.

## Setup, startup, and packaging

Run commands from the project root using PowerShell. Use the repository's
existing virtual environment. If dependencies are missing, setup commands are:

```powershell
npm install
python -m venv venv
venv\Scripts\python.exe -m pip install -r requirements.txt
```

Configure local environment values using `.env.example` as a reference. Do not
overwrite an existing `.env` or virtual environment merely to start the app.

```powershell
npm run dev                              # Electron and Flask together
npm start                                # Electron only
npm run python-dev                       # Flask only
venv\Scripts\python.exe backend/app.py    # Direct Flask startup
npm run pack                             # Unpacked desktop build
npm run dist                             # Distributable desktop build
```

Use `package.json` and the lockfile as the dependency source of truth. Avoid
unrequested upgrades or downgrades; the root README contains older runtime
guidance that must be checked against the current dependencies.

## Validation commands

Choose checks relevant to the changed behavior. These existing commands cover
telemetry, schedules, controls, logs, and database behavior:

```powershell
npm test
npm run test:database
node scripts/test_telemetry_cadence.js
node scripts/test_runtime_engine.js
node scripts/test_logs_stability.js
node scripts/test_hardware_control.js
node scripts/test_aircon_system.js
node scripts/test_dashboard_workflows.js
node scripts/test_report_deletion.js
venv\Scripts\python.exe scripts/test_schedule_pipeline.py
venv\Scripts\python.exe scripts/test_cloud_telemetry_sync.py
```

`npm test` runs the no-mock-data verification script, not the entire regression
suite. `npm run test:all` starts the development app alongside that check; it is
not an exhaustive test runner. Inspect unfamiliar test or transfer scripts
before running them, especially scripts that access a live database or hardware.

For firmware, install the toolchain/libraries described in its README, then use:

```powershell
arduino-cli compile --fqbn esp32:esp32:esp32s3:PartitionScheme=huge_app firmware/esp32s3_ecotrack_node
```

Compilation does not prove physical behavior. Verify IR reception, AC response,
sensor calibration, sleep/wake behavior, and network recovery on actual hardware
when available. Report checks as PASS, FAIL, BLOCKED, or NOT RUN based on what
actually happened; never invent results or claim compilation means flashing.

## Preservation, security, and data integrity

- Inspect repository status before editing. Preserve existing user changes,
  working features, routes, data formats, layouts, and IDs outside the request.
  Prefer a focused fix over a broad rewrite. Do not reset, discard, or overwrite
  unrelated work, and do not commit or push unless requested.
- Protect credentials. Never copy secrets into source, documentation, tests,
  logs, screenshots, or responses. Use existing configuration mechanisms and
  placeholders in examples. Keep service-role credentials out of renderer code
  and firmware. Do not weaken authentication, grants, or RLS as a workaround.
- Preserve real records. Do not clear or replace live SQLite/Supabase data to
  make a test pass. Use temporary databases and mocked network calls for
  automated tests; synthetic fixtures must stay isolated from production data.
- Never fabricate sensor readings, telemetry rows, online status, captured IR
  frames, or successful command acknowledgments. Missing measurements remain
  null/unknown and should display as unavailable rather than an invented zero
  or plausible value. Schedule events are not measured AC operation.
- **Runtime requires confirmed AC-on evidence.** Use explicit historical power
  feedback such as `ac_on` from a trustworthy measurement or confirmed feedback.
  Online connectivity, ambient temperature, a setpoint, `desired_state`, a
  queued command, and successful IR transmission do not prove the AC is on.
  Preserve unknown power as unknown; do not backfill old records from commands.
- Calculate runtime from actual timestamps and recorded cadence, respect
  operating schedules and overnight windows, and preserve gap handling. Do not
  assume continuous operation across missing samples or derive runtime from
  a fixed duration per row. Keep facility elapsed time distinct from AC unit-hours.
- Distinguish a command being queued, transmitted, acknowledged, and physically
  confirmed. Preserve exact supported IR protocol variants; unsupported models
  must produce a clear error rather than a fabricated fallback frame.
- Keep schema changes explicit and compatible with existing records. Review
  migrations before executing them against a live service, and follow the
  user's authorization for external writes and destructive actions.

## Existing custom skills

Use relevant instructions in `.agents/skills/` rather than creating duplicate
skills for an already covered workflow. Apply `prompt-enhancer` before repository
implementation and proceed within the user's existing authorization without
redundant permission requests. Use `web-app-builder` for implementation,
`debug-and-rebuild` for reproduced failures, `api-database-tester` for API/data
checks, and `browser-qa-tester` plus `ui-spec-enforcer` for UI work.

Use `full-webapp-lifecycle` when the user requests a complete build/test/review
workflow. Follow its reporting requirements, including `REPORT.md`, for that
scope. Scale validation to the change: documentation-only edits need content,
path, and diff checks rather than starting the app or accessing live services.
