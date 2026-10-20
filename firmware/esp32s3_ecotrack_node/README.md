# ESP32-S3 hardware pipeline

Install ArduinoJson 7.x and IRremoteESP8266 2.9.0 or later. Select **ESP32S3 Dev Module** and **Huge APP (3MB No OTA/1MB SPIFFS)** on a board with at least 4MB flash. The complete IR encoder/receiver exceeds the default 1.25MB application partition.

The checked build uses Arduino ESP32 3.3.11:

```powershell
arduino-cli compile --fqbn esp32:esp32:esp32s3:PartitionScheme=huge_app firmware/esp32s3_ecotrack_node
```

Before uploading, set the node name and location constants in the sketch. Provision Wi-Fi through the existing BLE workflow; those saved NVS settings take priority. If fallback networks are needed, copy `wifi-secrets.example.h` to `wifi-secrets.h` and enter their credentials there. This private header is ignored by Git; keep passwords out of the sketch and commits. Without the private header, fallback credentials are empty. Register the exact node name in Supabase `nodes.name`; assign one aircon to its database `nodes.id`. Apply `supabase_hardware_pipeline_migration.sql` in the project database.

The dashboard writes full climate commands to `aircons.desired_state` and attempts immediate LAN delivery. Firmware polls that same state every 15 seconds, backing off to five minutes after network failures. Select the real protocol supported by the AC model. Captured variants such as `DAIKIN2` are preserved. An unsupported protocol returns an error instead of sending a fabricated default frame. A successful IR transmission does not confirm the AC received it or turned on.

`GET /ir/latest-learned` exposes the most recent actual capture since boot; `/sniff-protocol` waits up to six seconds for a new capture. IR Studio displays the captured timings. `/ir/test` accepts real `raw_data` timings for replay.

The controller publishes its LAN IP at startup and every minute. Telemetry includes measured battery voltage, RSSI and the active data interval. This pin configuration has no ambient temperature sensor, so temperature is null until a real sensor supplies it. Physical AC power remains unconfirmed unless measured independently; no command state is written into `ac_on`.

Wake/sleep clocks and data intervals survive reboot in NVS. The sketch uses UTC+8 (Asia/Singapore); change `NODE_TIMEZONE_OFFSET_SECONDS` if the installation uses another timezone. It requires a synchronized clock before entering deep sleep. Overnight schedules are supported, and equal wake/sleep clocks mean continuous operation. Outside the operating window it sleeps until the next wake boundary or a 15-minute schedule recheck, whichever comes first. LAN/BLE commands cannot reach a sleeping node; a cloud schedule change is picked up at its next recheck. The operating window stays responsive with Wi-Fi modem power saving.

Start the Flask backend normally (`venv\Scripts\python.exe backend/app.py`). It imports cloud telemetry into SQLite automatically every 15 seconds, with a durable cursor and duplicate protection. `/api/telemetry/sync` reports sync status. Unknown sensor readings and AC state remain null. Battery measurement uses calibrated millivolts; verify the divider ratio and battery-board topology against the actual hardware. Board regulators and LEDs also affect standby consumption.
