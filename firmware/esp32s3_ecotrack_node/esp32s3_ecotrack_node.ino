/*
 * ==============================================================================
 * ECOTRACK SMART AIRCON IOT TELEMETRY & IR CONTROLLER NODE
 * Platform: ESP32-S3 (Dual Core Xtensa LX7, 2.4GHz Wi-Fi + BLE 5.0)
 * 
 * Hardware Configuration:
 * - Dual 18650 Battery Holder with Integrated 5V & 3V/3.3V Power Board
 * - SPST Main ON/OFF Power Switch
 * - Power Indicator LED with Resistor (Indicates ESP32-S3 ON/OFF status)
 * - NPN Transistor (2N2222 / S8050) High-Power 38kHz IR Transmitter (GPIO 4)
 * - 38kHz Infrared Demodulator & Remote Signal Receiver (GPIO 5)
 * - Battery Sensing via 100kΩ/100kΩ Voltage Divider (ADC1_CH0, GPIO 1)
 * - Local BLE 5.0 GATT Server for wireless commissioning and diagnostics
 * - Dual-SSID Wi-Fi auto-reconnect with fallback
 * - Supabase Cloud Database REST integration (telemetry, nodes, aircons)
 * - Built-in High-Speed HTTP/ICMP Ping Responder for Desktop Dashboard
 * 
 * Reusability:
 * To flash another node, simply change NODE_ID and location strings in Section 2,
 * or leave NODE_ID as "AUTO" to auto-derive the ID from the hardware MAC address!
 * ==============================================================================
 */

// ==============================================================================
// SECTION 1: SYSTEM LIBRARIES & CORE INCLUDES
// ==============================================================================
#include <Arduino.h>
#include <ArduinoJson.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <math.h>
#include <limits.h>
#include <stdlib.h>
#include <ctype.h>
#include <Preferences.h>
#include <esp_sleep.h>
#include <time.h>

// Required: Arduino must discover the real encoder/receiver library before compiling.
#define USE_IRREMOTE_LIB 1
#include <IRremoteESP8266.h>
#include <IRsend.h>
#include <IRrecv.h>
#include <IRutils.h>
#include <IRac.h>

// ==============================================================================
// SECTION 2: HARDWARE & NETWORK CONFIGURATION
// ==============================================================================

// -----------------------------------------------------------------------------
// 1. NODE IDENTITY (Change for each device, or set to "AUTO")
// -----------------------------------------------------------------------------
#define NODE_ID              "node-6"                  // e.g. "node-1", "node-6", "node-225", or "AUTO"
#define DEVICE_NAME          "node-6 (room 1)"         // Friendly display name
#define HARDWARE_MODEL       "WiFi + IR Blaster"       // Hardware capabilities descriptor
#define FIRMWARE_VERSION     "v2.6.0-WiFi"

// Physical Location Metadata (Fallback defaults used until dynamically synced from Supabase or NVS Preferences)
#define DEFAULT_BUILDING_NAME    "Main Campus Building"
#define DEFAULT_FLOOR_NAME       "2nd Floor - IT Wing"
#define DEFAULT_ROOM_NAME        "Server Room A"
#define DEFAULT_AIRCON_TYPE      "Split Type (Inverter)"

// Backward-compatible macro aliases
#define BUILDING_NAME            DEFAULT_BUILDING_NAME
#define FLOOR_NAME               DEFAULT_FLOOR_NAME
#define ROOM_NAME                DEFAULT_ROOM_NAME
#define AIRCON_TYPE              DEFAULT_AIRCON_TYPE

// -----------------------------------------------------------------------------
// 2. WI-FI CREDENTIALS (Supports Dual-SSID Automatic Failover)
// -----------------------------------------------------------------------------
// Saved provisioning takes priority. Optional fallback credentials stay private.
#if __has_include("wifi-secrets.h")
#include "wifi-secrets.h"
#endif
#ifndef WIFI_SSID_PRIMARY
#define WIFI_SSID_PRIMARY ""
#endif
#ifndef WIFI_PASS_PRIMARY
#define WIFI_PASS_PRIMARY ""
#endif

#ifndef WIFI_SSID_BACKUP
#define WIFI_SSID_BACKUP ""
#endif
#ifndef WIFI_PASS_BACKUP
#define WIFI_PASS_BACKUP ""
#endif

#define WIFI_TIMEOUT_MS      15000                     // 15 seconds connection timeout

// -----------------------------------------------------------------------------
// 3. SUPABASE CLOUD DATABASE CONFIGURATION
// -----------------------------------------------------------------------------
// Points directly to the EcoTrack Supabase instance
#define SUPABASE_URL         "https://ynopdmfhngooknybyahq.supabase.co"
#define SUPABASE_ANON_KEY    "sb_publishable_HNxLHBeGMPsdoEvVtUusWw_CJ-qlHQ-"

// Supabase REST Endpoints
#define SUPABASE_TABLE_TELEMETRY  "/rest/v1/telemetry"
#define SUPABASE_TABLE_NODES      "/rest/v1/nodes"
#define SUPABASE_TABLE_AIRCONS    "/rest/v1/aircons"

// -----------------------------------------------------------------------------
// 4. HARDWARE PIN DEFINITIONS (ESP32-S3 Safe Non-Strapping GPIOs)
// -----------------------------------------------------------------------------
#define PIN_IR_TX            4                         // IR Blaster (NPN Transistor Base via 1kΩ)
#define PIN_IR_RX            5                         // 38kHz IR Demodulator (VS1838B / TSOP38238 Data Out)
#define PIN_BATT_ADC         1                         // Battery Sense Voltage Divider (ADC1_CH0, 100kΩ/100kΩ)
#define PIN_PWR_LED          15                        // System Power & Status LED (via 220Ω/330Ω resistor)

// -----------------------------------------------------------------------------
// 5. BATTERY SENSING & POWER MANAGEMENT CONSTANTS
// -----------------------------------------------------------------------------
// Resistor Divider: 100kΩ / 100kΩ (Voltage ratio = 2.0)
#define BATT_DIVIDER_RATIO   2.0f
#define BATT_V_MAX           4.20f                     // 100% full charge voltage (Li-ion)
#define BATT_V_MIN           3.20f                     // 0% safe cut-off voltage
#define BATT_LOW_WARN_PCT    15                        // Alert when battery drops below 15%

// -----------------------------------------------------------------------------
// 6. TIMING & SCHEDULING (Milliseconds)
// -----------------------------------------------------------------------------
unsigned long _telemetryIntervalMs = 15UL * 60UL * 1000UL;
#define COMMAND_POLL_INTERVAL_MS 15000UL               // LAN commands are immediate; cloud fallback every 15s
#define COMMAND_POLL_MAX_MS      300000UL
#define NODE_TIMEZONE_OFFSET_SECONDS (8 * 3600)        // Match dashboard timezone (Asia/Singapore)
#define SLEEP_CONFIG_RECHECK_SECONDS 900UL             // Recheck cloud schedule at most every 15 minutes asleep
#define BATT_CHECK_INTERVAL_MS   5000                  // Update battery % and power status every 5s
#define PING_HTTP_PORT           80                    // Local HTTP ping responder port

// -----------------------------------------------------------------------------
// 7. BLUETOOTH LOW ENERGY (BLE 5.0) PROVISIONING UUIDS
// -----------------------------------------------------------------------------
#define BLE_SERVICE_UUID           "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define BLE_CHAR_DEVICE_INFO_UUID  "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define BLE_CHAR_WIFI_CONFIG_UUID  "1c95d5e3-d8f7-413a-bf3d-7a2e5d7be87e"
#define BLE_CHAR_IR_TRIGGER_UUID   "d7c2b4e1-2294-4d89-980b-8d085df7c7e9"

// ==============================================================================
// SECTION 3: DATA STRUCTURES & ENUMS
// ==============================================================================

enum PowerState {
  STATE_NORMAL = 0,        // Operating from Dual 18650 Battery Shield
  STATE_BATTERY_LOW = 1,   // Battery below warning threshold (<= 15%)
  STATE_EXTERNAL_PWR = 2   // Powered / charging via Dual 18650 USB port (Voltage >= 4.15V)
};

struct IRCommandPayload {
  String commandType;   // 'POWER_ON', 'POWER_OFF', 'TEMP_UP', 'TEMP_DOWN', 'MODE_COOL', etc.
  String protocol;      // 'KOPPEL_RAW', 'MIDEA', 'GREE', 'DAIKIN', 'PANASONIC', 'RAW'
  String rawData;       // Comma-separated microsecond timings: "3200,1600,450,1200,..."
  String hexCode;       // Optional hex code: "0x12A45C"
  int setpoint;         // Target temperature (e.g. 24)
};

// ==============================================================================
// SECTION 4: POWER & BATTERY SUBSYSTEM (DUAL 18650 SHIELD + POWER LED)
// ==============================================================================

class PowerManager {
public:
  static void init() {
    // Configure ADC pin for battery sensing
    pinMode(PIN_BATT_ADC, INPUT);
    analogReadResolution(12); // 12-bit (0 - 4095)
    analogSetPinAttenuation(PIN_BATT_ADC, ADC_11db);
    
    // Configure Power Indicator LED (Solid ON indicates ESP32-S3 is ON and running)
    pinMode(PIN_PWR_LED, OUTPUT);
    digitalWrite(PIN_PWR_LED, HIGH);

    // Initial reading
    update();
    Serial.printf("[POWER] Dual 18650 Power Subsystem initialized. Battery: %.2fV (%d%%) | State: %s\n", 
      getVoltage(), getPercentage(), getStateString().c_str());
  }

  static void update() {
    _batteryVoltage = readFilteredVoltage();
    _batteryPercentage = calculatePercentage(_batteryVoltage);
    _powerState = evaluatePowerState();
    updateLedIndicator();
  }

  static float getVoltage() {
    return _batteryVoltage;
  }

  static int getPercentage() {
    return _batteryPercentage;
  }

  static PowerState getPowerState() {
    return _powerState;
  }

  static String getStateString() {
    switch (_powerState) {
      case STATE_EXTERNAL_PWR: return "CHARGING_EXTERNAL";
      case STATE_BATTERY_LOW:  return "BATTERY_LOW";
      default:                 return "BATTERY_NORMAL";
    }
  }

  // Quick blink for IR transmission / network activity confirmation
  static void flashActivity(uint16_t durationMs = 60) {
    digitalWrite(PIN_PWR_LED, LOW);
    delay(durationMs);
    digitalWrite(PIN_PWR_LED, HIGH);
  }

  // Backward compatible alias
  static void flashGreenActivity(uint16_t durationMs = 60) {
    flashActivity(durationMs);
  }

private:
  static inline float _batteryVoltage = 4.00f;
  static inline int _batteryPercentage = 85;
  static inline PowerState _powerState = STATE_NORMAL;
  static inline unsigned long _lastLowBlinkMs = 0;
  static inline bool _lowBlinkState = false;

  // Reads ADC with 16-sample oversampling to eliminate Wi-Fi noise spikes
  static float readFilteredVoltage() {
    uint32_t millivoltSum = 0;
    const int SAMPLES = 16;
    for (int i = 0; i < SAMPLES; i++) {
      millivoltSum += analogReadMilliVolts(PIN_BATT_ADC);
      delayMicroseconds(200);
    }
    float vDivider = (float)millivoltSum / SAMPLES / 1000.0f;

    // Multiply by 2.0 (100kΩ / 100kΩ voltage divider ratio)
    float vBattery = vDivider * BATT_DIVIDER_RATIO;

    return constrain(vBattery, 2.50f, 4.35f);
  }

  // Realistic Li-ion discharge lookup curve
  static int calculatePercentage(float v) {
    if (v >= BATT_V_MAX) return 100;
    if (v <= BATT_V_MIN) return 0;

    // Approximated Li-ion cell discharge curve points:
    // 4.20V -> 100%
    // 4.00V -> 84%
    // 3.85V -> 65%
    // 3.75V -> 45%
    // 3.65V -> 25%
    // 3.50V -> 10%
    // 3.20V -> 0%
    if (v >= 4.00f) return (int)(84.0f + (v - 4.00f) * (16.0f / 0.20f));
    if (v >= 3.85f) return (int)(65.0f + (v - 3.85f) * (19.0f / 0.15f));
    if (v >= 3.75f) return (int)(45.0f + (v - 3.75f) * (20.0f / 0.10f));
    if (v >= 3.65f) return (int)(25.0f + (v - 3.65f) * (20.0f / 0.10f));
    if (v >= 3.50f) return (int)(10.0f + (v - 3.50f) * (15.0f / 0.15f));
    return (int)((v - BATT_V_MIN) * (10.0f / (3.50f - BATT_V_MIN)));
  }

  static PowerState evaluatePowerState() {
    if (_batteryVoltage >= 4.18f) {
      return STATE_EXTERNAL_PWR;
    } else if (_batteryPercentage <= BATT_LOW_WARN_PCT) {
      return STATE_BATTERY_LOW;
    }
    return STATE_NORMAL;
  }

  // Power LED indicates ESP32-S3 is ON.
  // Blinks every 1 second when battery is critically low (<= 15%), solid ON otherwise.
  static void updateLedIndicator() {
    if (_powerState == STATE_BATTERY_LOW) {
      unsigned long now = millis();
      if (now - _lastLowBlinkMs >= 1000) {
        _lastLowBlinkMs = now;
        _lowBlinkState = !_lowBlinkState;
        digitalWrite(PIN_PWR_LED, _lowBlinkState ? HIGH : LOW);
      }
    } else {
      digitalWrite(PIN_PWR_LED, HIGH);
    }
  }
};

// ==============================================================================
// SECTION 5: INFRARED CONTROLLER & LEARNER (38kHz BLASTER & RX)
// ==============================================================================

class IRController {
public:
  static void init() {
    pinMode(PIN_IR_TX, OUTPUT);
    digitalWrite(PIN_IR_TX, LOW);
#if USE_IRREMOTE_LIB
    _irSend = new IRsend(PIN_IR_TX);
    _irSend->begin();
    _irRecv = new IRrecv(PIN_IR_RX, 1024, 50, true);
    _irRecv->enableIRIn();
    _ac = new IRac(PIN_IR_TX);
    Serial.println("[IR] Real protocol encoder and remote receiver initialized.");
#else
    Serial.println("[IR] Install IRremoteESP8266: structured commands and learning are unavailable.");
#endif
  }

  static bool sendCommand(const IRCommandPayload& cmd) {
    if (cmd.rawData.length()) return sendRawTimings(cmd.rawData);
#if USE_IRREMOTE_LIB
    decode_type_t type = strToDecodeType(cmd.protocol.c_str());
    if (_irSend && cmd.hexCode.length() && type != UNKNOWN && !hasACState(type)) {
      return _irSend->send(type, strtoull(cmd.hexCode.c_str(), nullptr, 16), IRsend::defaultBits(type));
    }
#endif
    Serial.println("[IR] Command rejected: supply a real captured frame or structured climate state.");
    return false;
  }

  static bool checkForReceivedSignal(String& protocol, String& raw, String& hex) {
#if USE_IRREMOTE_LIB
    decode_results results;
    if (_irRecv && _irRecv->decode(&results)) {
      bool valid = !results.overflow && results.rawlen > 3;
      if (valid) {
        protocol = typeToString(results.decode_type);
        hex = resultToHexidecimal(&results);
        uint16_t count = getCorrectedRawLength(&results);
        uint16_t* timings = resultToRawArray(&results);
        raw = "";
        for (uint16_t i = 0; i < count; i++) {
          if (i) raw += ',';
          raw += String(timings[i]);
        }
        delete[] timings;
      }
      _irRecv->resume();
      return valid;
    }
#endif
    return false;
  }

  static bool sendRawTimings(const String& csv) {
    uint16_t timings[2048];
    size_t count = 0;
    const char* cursor = csv.c_str();
    while (*cursor) {
      while (isspace(*cursor)) cursor++;
      if (!isdigit(*cursor) || count >= 2048) return false;
      char* end;
      unsigned long duration = strtoul(cursor, &end, 10);
      if (end == cursor || duration > 65535) return false;
      timings[count++] = (uint16_t)duration;
      cursor = end;
      while (isspace(*cursor)) cursor++;
      if (*cursor == ',') { cursor++; if (!*cursor) return false; }
      else if (*cursor) return false;
    }
    if (count < 3) return false;
#if USE_IRREMOTE_LIB
    if (!_irSend) return false;
    if (_irRecv) _irRecv->disableIRIn();
    _irSend->sendRaw(timings, count, 38);
    if (_irRecv) _irRecv->enableIRIn();
#else
    for (size_t i = 0; i < count; i++) {
      if (i % 2 == 0) {
        unsigned long start = micros();
        while (micros() - start < timings[i]) {
          digitalWrite(PIN_IR_TX, HIGH); delayMicroseconds(12);
          digitalWrite(PIN_IR_TX, LOW); delayMicroseconds(12);
        }
      } else delayMicroseconds(timings[i]);
    }
    digitalWrite(PIN_IR_TX, LOW);
#endif
    return true;
  }

  static bool sendStructuredIntent(const String& protocol, bool power, const String& mode,
      int temp, const String& fan, bool swing = true, bool turbo = false, bool eco = false) {
#if USE_IRREMOTE_LIB
    String normalized = protocol;
    normalized.toLowerCase();
    decode_type_t type = strToDecodeType(protocol.c_str());
    if (normalized == "midea_ir" || normalized == "midea") type = MIDEA;
    else if (normalized == "daikin") type = DAIKIN;
    else if (normalized == "gree") type = GREE;
    else if (normalized == "carrier") type = CARRIER_AC64;
    else if (normalized == "panasonic") type = PANASONIC_AC;
    else if (normalized == "mitsubishi") type = MITSUBISHI_AC;
    else if (normalized == "samsung") type = SAMSUNG_AC;
    if (!_ac || type == UNKNOWN || !IRac::isProtocolSupported(type)) return false;
    IRac::initState(&_ac->next);
    _ac->next.protocol = type;
    _ac->next.power = power;
    _ac->next.mode = IRac::strToOpmode(mode.c_str(), stdAc::opmode_t::kCool);
    _ac->next.degrees = constrain(temp, 16, 32);
    _ac->next.celsius = true;
    _ac->next.fanspeed = IRac::strToFanspeed(fan.c_str());
    _ac->next.swingv = swing ? stdAc::swingv_t::kAuto : stdAc::swingv_t::kOff;
    _ac->next.turbo = turbo;
    _ac->next.econo = eco;
    if (_irRecv) _irRecv->disableIRIn();
    bool success = _ac->sendAc();
    if (_irRecv) _irRecv->enableIRIn();
    return success;
#else
    return false;
#endif
  }

private:
#if USE_IRREMOTE_LIB
  static inline IRsend* _irSend = nullptr;
  static inline IRrecv* _irRecv = nullptr;
  static inline IRac* _ac = nullptr;
#endif
};

// ==============================================================================
// SECTION 6: BLUETOOTH LOW ENERGY (BLE 5.0) GATT SERVICE
// ==============================================================================

// Wi-Fi writes are queued so the BLE callback never blocks or invokes IR.
class WifiProvisioning {
public:
  static void init() { _requests = xQueueCreate(1, sizeof(Credentials)); }

  static void receive(const String& payload) {
    Credentials request = {};
    StaticJsonDocument<768> doc;
    DeserializationError error = deserializeJson(doc, payload);
    const char* ssid = doc["ssid"] | "";
    const char* password = doc["pass"] | "";
    const char* requestId = doc["request_id"] | "";
    strlcpy(request.ssid, ssid, sizeof(request.ssid));
    strlcpy(request.password, password, sizeof(request.password));
    strlcpy(request.requestId, requestId, sizeof(request.requestId));
    bool validPassword = strlen(password) == 0 || (strlen(password) >= 8 && strlen(password) <= 63);
    if (strlen(password) == 64) {
      validPassword = true;
      for (size_t i = 0; i < 64; ++i) if (!isxdigit(password[i])) validPassword = false;
    }
    request.valid = !error && doc["ssid"].is<const char*>() && doc["pass"].is<const char*>() &&
      strlen(ssid) > 0 && strlen(ssid) <= 32 && strlen(requestId) <= 64 && validPassword;
    if (_requests) xQueueOverwrite(_requests, &request);
  }

  static bool hasPending() { return _requests && uxQueueMessagesWaiting(_requests) > 0; }
  static bool busy() { return _status == "received" || _status == "connecting"; }

  static bool poll() {
    Credentials request;
    if (_requests && xQueueReceive(_requests, &request, 0) == pdTRUE) {
      _active = request;
      _status = request.valid ? "received" : "error";
      _error = request.valid ? "" : "Invalid Wi-Fi configuration";
      return true;
    }
    if (_status == "received") {
      WiFi.disconnect();
      WiFi.mode(WIFI_STA);
      WiFi.setSleep(false);
      WiFi.begin(_active.ssid, _active.password);
      _startedAt = millis();
      _status = "connecting";
      return true;
    }
    if (_status != "connecting") return false;
    if (WiFi.status() == WL_CONNECTED && WiFi.SSID() == String(_active.ssid) &&
        WiFi.localIP().toString() != "0.0.0.0") {
      _status = "connected";
      Preferences prefs;
      if (prefs.begin("ecotrack-wifi", false)) {
        prefs.putString("ssid", _active.ssid);
        prefs.putString("pass", _active.password);
        prefs.end();
      }
      memset(_active.password, 0, sizeof(_active.password));
      return true;
    }
    if (millis() - _startedAt >= 30000) {
      _status = "error";
      _error = "Wi-Fi connection failed; check password, 2.4 GHz network and signal";
      memset(_active.password, 0, sizeof(_active.password));
      return true;
    }
    return false;
  }

  static void addStatus(JsonDocument& doc) {
    doc["wifi_status"] = _status;
    doc["wifi_ssid"] = _active.ssid;
    doc["request_id"] = _active.requestId;
    doc["wifi_error"] = _error;
    doc["backend_status"] = "unverified";
  }

  static bool connectSaved() {
    Preferences prefs;
    if (!prefs.begin("ecotrack-wifi", true)) return false;
    String ssid = prefs.getString("ssid", "");
    String password = prefs.getString("pass", "");
    prefs.end();
    if (ssid.length() == 0) return false;
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    WiFi.begin(ssid.c_str(), password.c_str());
    unsigned long started = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - started < WIFI_TIMEOUT_MS) {
      if (hasPending()) return false;
      delay(100);
    }
    return WiFi.status() == WL_CONNECTED;
  }

private:
  struct Credentials { char ssid[33]; char password[65]; char requestId[65]; bool valid; };
  static inline QueueHandle_t _requests = nullptr;
  static inline Credentials _active = {};
  static inline String _status = "idle";
  static inline String _error = "";
  static inline unsigned long _startedAt = 0;
};

class BLEWifiConfigCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pChar) override {
    WifiProvisioning::receive(String(pChar->getValue().c_str()));
  }
};


class BLECommandCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pChar) override {
    String rxValue = pChar->getValue().c_str();
    if (rxValue.length() > 0) {
      Serial.printf("[BLE-RX] Received payload (%d bytes): %s\n", rxValue.length(), rxValue.c_str());

      // If payload is an IR command dispatch trigger
      if (rxValue.startsWith("CMD:") || rxValue.startsWith("{")) {
        IRCommandPayload cmd;
        cmd.commandType = rxValue.startsWith("CMD:") ? rxValue.substring(4) : "POWER_TOGGLE";
        cmd.protocol = "KOPPEL_RAW";
        cmd.rawData = "";
        IRController::sendCommand(cmd);
        PowerManager::flashGreenActivity(100);
      }
    }
  }
};

class BLEServerCallbacksHandler : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) override {
    Serial.println("[BLE] Client smartphone/technician connected!");
  }

  void onDisconnect(BLEServer* pServer) override {
    Serial.println("[BLE] Client disconnected. Resuming general advertising...");
    pServer->startAdvertising();
  }
};

class BLEManager {
public:
  static void init(const String& nodeIdentity) {
    _nodeId = nodeIdentity;
    String bleName = "EcoTrack-" + _nodeId;
    
    Serial.printf("[BLE] Starting BLE GATT Server as '%s'...\n", bleName.c_str());
    BLEDevice::init(bleName.c_str());
    BLEDevice::setMTU(512); // Carry complete Wi-Fi credential JSON and confirmation.
    
    _pServer = BLEDevice::createServer();
    _pServer->setCallbacks(new BLEServerCallbacksHandler());

    _pService = _pServer->createService(BLE_SERVICE_UUID);

    // 1. Device Info Characteristic (Read, Notify)
    _pCharDeviceInfo = _pService->createCharacteristic(
      BLE_CHAR_DEVICE_INFO_UUID,
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
    );
    _pCharDeviceInfo->addDescriptor(new BLE2902());

    // 2. Wi-Fi Config Characteristic (Write)
    _pCharWifiConfig = _pService->createCharacteristic(
      BLE_CHAR_WIFI_CONFIG_UUID,
      BLECharacteristic::PROPERTY_WRITE
    );
    _pCharWifiConfig->setCallbacks(new BLEWifiConfigCallbacks());

    // 3. IR Command Trigger Characteristic (Write)
    _pCharIrTrigger = _pService->createCharacteristic(
      BLE_CHAR_IR_TRIGGER_UUID,
      BLECharacteristic::PROPERTY_WRITE
    );
    _pCharIrTrigger->setCallbacks(new BLECommandCallbacks());

    _pService->start();

    // Start advertising
    BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
    pAdvertising->addServiceUUID(BLE_SERVICE_UUID);
    pAdvertising->setScanResponse(true);
    pAdvertising->setMinPreferred(0x06); // iPhone connection optimization
    pAdvertising->setMinPreferred(0x12);
    BLEDevice::startAdvertising();

    Serial.println("[BLE] Advertising active. Ready for phone/tablet pairing.");
  }

  static void updateTelemetryStatus(const String& ip, int rssi) {
    if (!_pCharDeviceInfo) return;

    StaticJsonDocument<1024> status;
    status["node"] = _nodeId;
    status["ip"] = ip;
    status["rssi"] = rssi;
    status["batt"] = PowerManager::getPercentage();
    status["v"] = PowerManager::getVoltage();
    status["state"] = PowerManager::getStateString();
    WifiProvisioning::addStatus(status);
    String encoded;
    serializeJson(status, encoded);
    _pCharDeviceInfo->setValue(encoded.c_str());
    _pCharDeviceInfo->notify();
  }

private:
  static inline String _nodeId = "node-6";
  static inline BLEServer* _pServer = nullptr;
  static inline BLEService* _pService = nullptr;
  static inline BLECharacteristic* _pCharDeviceInfo = nullptr;
  static inline BLECharacteristic* _pCharWifiConfig = nullptr;
  static inline BLECharacteristic* _pCharIrTrigger = nullptr;
};

// ==============================================================================
// SECTION 7: SUPABASE CLOUD CLIENT & LOCAL PING RESPONDER
// ==============================================================================

class SupabaseManager {
public:
  static void init(const String& nodeIdentity) {
    _nodeId = nodeIdentity;
    _preferences.begin("eco-schedule", false);
    _lastIntentSignature = _preferences.getString("intent_sig", "");
    _lastIntentReceipt = _preferences.getString("intent_receipt", "");
    unsigned long stored = _preferences.getULong("interval", _telemetryIntervalMs);
    if (stored >= 1000) _telemetryIntervalMs = stored;
    applyOperatingSchedule(_preferences.getString("wake", ""), _preferences.getString("sleep", ""), false);

    // Load persisted dynamic location & AC type (or fall back to defaults)
    _roomName = _preferences.getString("room", DEFAULT_ROOM_NAME);
    _floorName = _preferences.getString("floor", DEFAULT_FLOOR_NAME);
    _buildingName = _preferences.getString("bld", DEFAULT_BUILDING_NAME);
    _airconType = _preferences.getString("aircon", DEFAULT_AIRCON_TYPE);

    configTime(NODE_TIMEZONE_OFFSET_SECONDS, 0, "pool.ntp.org", "time.google.com");
    _localServer = new WebServer(PING_HTTP_PORT);
    _localServer->on("/", HTTP_GET, handlePingEndpoint);
    _localServer->on("/ping", HTTP_GET, handlePingEndpoint);
    _localServer->on("/health", HTTP_GET, handlePingEndpoint);
    _localServer->on("/ir/test", HTTP_POST, handleLocalIrTrigger);
    _localServer->on("/ir/test", HTTP_OPTIONS, handleOptions);
    _localServer->on("/sniff-protocol", HTTP_POST, handleSniffProtocol);
    _localServer->on("/sniff-protocol", HTTP_GET, handleSniffProtocol);
    _localServer->on("/sniff-protocol", HTTP_OPTIONS, handleOptions);
    _localServer->on("/ir/latest-learned", HTTP_GET, handleLatestLearned);
    _localServer->on("/ir/latest-learned", HTTP_OPTIONS, handleOptions);
    _localServer->on("/ir/intent", HTTP_POST, handleIntentEndpoint);
    _localServer->on("/ir/delivery", HTTP_GET, handleDeliveryReceipt);
    _localServer->on("/ir/intent", HTTP_OPTIONS, handleOptions);
    _localServer->on("/set-interval", HTTP_POST, handleSetIntervalEndpoint);
    _localServer->on("/set-interval", HTTP_OPTIONS, handleOptions);
    _localServer->on("/set-location", HTTP_POST, handleSetLocationEndpoint);
    _localServer->on("/set-location", HTTP_OPTIONS, handleOptions);
    _localServer->begin();
  }

  static void handleClientRequests() { if (_localServer) _localServer->handleClient(); }
  static unsigned long commandPollInterval() { return _commandPollMs; }

  // Getters for dynamic metadata
  static String getRoomName() { return _roomName; }
  static String getFloorName() { return _floorName; }
  static String getBuildingName() { return _buildingName; }
  static String getAirconType() { return _airconType; }
  static void syncNodeConfig() { syncNodeMetadataAndInterval(); }

  // Dynamic location and AC type setter (supports manual LAN/BLE override)
  static void setLocation(const String& room, const String& floor, const String& building, const String& aircon, bool persist = true) {
    if (room.length() > 0) _roomName = room;
    if (floor.length() > 0) _floorName = floor;
    if (building.length() > 0) _buildingName = building;
    if (aircon.length() > 0) _airconType = aircon;

    if (persist) {
      if (room.length() > 0) _preferences.putString("room", _roomName);
      if (floor.length() > 0) _preferences.putString("floor", _floorName);
      if (building.length() > 0) _preferences.putString("bld", _buildingName);
      if (aircon.length() > 0) _preferences.putString("aircon", _airconType);
    }
  }

  static bool sendTelemetry(float temperature, int batteryPct, int rssi) {
    if (WiFi.status() != WL_CONNECTED) return false;
    WiFiClientSecure client;
    HTTPClient https;
    if (!beginCloudRequest(https, client, String(SUPABASE_URL) + SUPABASE_TABLE_TELEMETRY)) return false;
    JsonDocument document;
    document["node_id"] = _nodeId;
    document["sensor_name"] = _nodeId;
    document["room_name"] = _roomName;
    document["floor_name"] = _floorName;
    document["building_name"] = _buildingName;
    document["aircon_type"] = _airconType;
    if (isfinite(temperature)) document["temperature"] = temperature;
    else document["temperature"] = nullptr;
    document["battery"] = PowerManager::getVoltage();
    document["rssi"] = rssi;
    document["status"] = "online";
    document["interval_seconds"] = _telemetryIntervalMs / 1000.0;
    // IR transmission confirms a command was sent, not physical AC power. ac_on stays unknown.
    String payload;
    serializeJson(document, payload);
    https.addHeader("Prefer", "return=minimal");
    int code = https.POST(payload);
    bool success = code >= 200 && code < 300;
    if (!success) Serial.printf("[TELEMETRY] Cloud upload failed: %d %s\n", code, https.getString().c_str());
    https.end();
    // Publish connectivity and LAN IP even if the telemetry upload failed.
    updateNodeRecord(temperature, batteryPct, rssi);
    return success;
  }

  static bool updateNodeRecord(float temperature, int batteryPct, int rssi, const char* status = "online") {
    if (WiFi.status() != WL_CONNECTED) return false;
    WiFiClientSecure client;
    HTTPClient https;
    String url = String(SUPABASE_URL) + SUPABASE_TABLE_NODES + "?name=eq." + _nodeId;
    if (!beginCloudRequest(https, client, url)) return false;
    JsonDocument document;
    document["status"] = status;
    if (isfinite(temperature)) document["temp"] = temperature;
    document["battery"] = batteryPct;
    document["rssi"] = rssi;
    document["ip_address"] = WiFi.localIP().toString();
    String payload;
    serializeJson(document, payload);
    https.addHeader("Prefer", "return=representation");
    int code = https.PATCH(payload);
    JsonDocument result;
    bool success = code >= 200 && code < 300 && !deserializeJson(result, https.getString()) && result.size() > 0;
    if (!success) Serial.printf("[NODE] Registry update failed or node name not registered: %d\n", code);
    https.end();
    return success;
  }

  static void serviceScheduleAndConnectivity(float temperature) {
    if (WiFi.status() == WL_CONNECTED &&
        (!_intervalSyncAttempted || millis() - _lastIntervalSyncMs >= 60000UL)) {
      _intervalSyncAttempted = true;
      _lastIntervalSyncMs = millis();
      syncNodeMetadataAndInterval();
      updateNodeRecord(temperature, PowerManager::getPercentage(), (int)WiFi.RSSI());
    }
    // Stay awake if the schedule or wall clock is unknown. Equal clocks mean 24-hour operation.
    if (!_hasSchedule || _wakeMinute == _sleepMinute || millis() < 15000UL) return;
    time_t epoch = time(nullptr);
    if (epoch < 1700000000) return;
    struct tm local;
    localtime_r(&epoch, &local);
    int seconds = local.tm_hour * 3600 + local.tm_min * 60 + local.tm_sec;
    int wake = _wakeMinute * 60, sleep = _sleepMinute * 60;
    bool awake = wake < sleep ? seconds >= wake && seconds < sleep : seconds >= wake || seconds < sleep;
    if (awake) return;
    unsigned long remaining = (wake - seconds + 86400) % 86400;
    unsigned long duration = min(remaining, SLEEP_CONFIG_RECHECK_SECONDS);
    if (!duration) return;
    updateNodeRecord(temperature, PowerManager::getPercentage(), (int)WiFi.RSSI(), "offline");
    Serial.printf("[SLEEP] Outside operating window; timed deep sleep for %lu seconds.\n", duration);
    Serial.flush();
    digitalWrite(PIN_PWR_LED, LOW);
    BLEDevice::deinit(false);
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);
    esp_sleep_enable_timer_wakeup((uint64_t)duration * 1000000ULL);
    esp_deep_sleep_start();
  }

  static void pollAirconCommands() {
    if (WiFi.status() != WL_CONNECTED) { increasePollBackoff(); return; }
    if (!_registryNodeId.length()) { increasePollBackoff(); return; }
    WiFiClientSecure client;
    HTTPClient https;
    String url = String(SUPABASE_URL) + SUPABASE_TABLE_AIRCONS + "?node_id=eq." + _registryNodeId + "&select=*";
    if (!beginCloudRequest(https, client, url)) { increasePollBackoff(); return; }
    int code = https.GET();
    JsonDocument document;
    bool received = code == 200 && !deserializeJson(document, https.getString()) && document.is<JsonArray>();
    https.end();
    if (!received) { increasePollBackoff(); return; }
    _commandPollMs = COMMAND_POLL_INTERVAL_MS;
    if (document.size() == 0) return;
    if (document.size() != 1) { Serial.println("[COMMAND] Multiple ACs assigned to one IR node; resolve assignment first."); return; }
    JsonObject aircon = document[0].as<JsonObject>();
    JsonObject state = aircon["desired_state"].as<JsonObject>();
    if (state.isNull() || state["power"].isNull()) return;
    String protocol = aircon["protocol_name"] | aircon["protocol"] | "";
    String commandId = aircon["command_id"] | "", airconId = aircon["id"] | "";
    if (commandId.length() && String(aircon["command_status"] | "") != "queued") return;
    String signature = commandId.length() ? commandId : intentSignature(protocol, state);
    if (signature == _lastIntentSignature) return;
    if (dispatchIntent(protocol, state)) {
      recordIntentDelivery(commandId, airconId, signature);
      Serial.println("[COMMAND] Updated full AC state transmitted over IR.");
    }
  }

  static void recordLearnedSignal(const String& protocol, const String& raw, const String& hex) {
    JsonDocument document;
    document["success"] = true;
    document["node_id"] = _nodeId;
    document["sequence"] = ++_learnSequence;
    document["captured_at_ms"] = millis();
    document["protocol"] = protocol;
    document["raw_type"] = protocol;
    document["raw_data"] = raw;
    document["hex"] = hex;
    document["frequency_khz"] = 38;
    _latestLearned = "";
    serializeJson(document, _latestLearned);
  }

private:
  static inline String _nodeId, _registryNodeId, _lastIntentSignature, _lastIntentReceipt, _latestLearned;
  static inline String _roomName = DEFAULT_ROOM_NAME;
  static inline String _floorName = DEFAULT_FLOOR_NAME;
  static inline String _buildingName = DEFAULT_BUILDING_NAME;
  static inline String _airconType = DEFAULT_AIRCON_TYPE;
  static inline WebServer* _localServer = nullptr;
  static inline Preferences _preferences;
  static inline unsigned long _commandPollMs = COMMAND_POLL_INTERVAL_MS;
  static inline unsigned long _lastIntervalSyncMs = 0;
  static inline bool _intervalSyncAttempted = false, _hasSchedule = false;
  static inline int _wakeMinute = 0, _sleepMinute = 0;
  static inline uint32_t _learnSequence = 0;

  static bool beginCloudRequest(HTTPClient& https, WiFiClientSecure& client, const String& url) {
    client.setInsecure();
    if (!https.begin(client, url)) return false;
    https.setConnectTimeout(1500);
    https.setTimeout(1500);
    https.addHeader("Content-Type", "application/json");
    https.addHeader("apikey", SUPABASE_ANON_KEY);
    https.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
    return true;
  }
  static void increasePollBackoff() { _commandPollMs = min(_commandPollMs * 2UL, COMMAND_POLL_MAX_MS); }
  static bool parseIntervalMs(double amount, double multiplier, unsigned long& value) {
    double ms = amount * multiplier;
    if (!isfinite(ms) || ms < 1000.0 || ms > ULONG_MAX) return false;
    value = (unsigned long)ms;
    return true;
  }
  static void applyTelemetryInterval(unsigned long value) {
    if (_telemetryIntervalMs == value) return;
    _telemetryIntervalMs = value;
    _preferences.putULong("interval", value);
  }
  static int clockMinute(const String& clock) {
    if (clock.length() < 5 || clock[2] != ':' || !isdigit(clock[0]) || !isdigit(clock[1]) ||
        !isdigit(clock[3]) || !isdigit(clock[4])) return -1;
    int hour = clock.substring(0, 2).toInt(), minute = clock.substring(3, 5).toInt();
    return hour < 24 && minute < 60 ? hour * 60 + minute : -1;
  }
  static void applyOperatingSchedule(const String& wake, const String& sleep, bool persist = true) {
    int wakeMinute = clockMinute(wake), sleepMinute = clockMinute(sleep);
    _hasSchedule = wakeMinute >= 0 && sleepMinute >= 0;
    if (_hasSchedule) { _wakeMinute = wakeMinute; _sleepMinute = sleepMinute; }
    if (persist && (_preferences.getString("wake", "") != wake || _preferences.getString("sleep", "") != sleep)) {
      _preferences.putString("wake", wake);
      _preferences.putString("sleep", sleep);
    }
  }
  static void cors() { _localServer->sendHeader("Access-Control-Allow-Origin", "*"); }
  static void handleOptions() {
    cors();
    _localServer->sendHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    _localServer->sendHeader("Access-Control-Allow-Headers", "Content-Type");
    _localServer->send(204);
  }
  static void handleSetIntervalEndpoint() {
    cors();
    JsonDocument document;
    unsigned long interval;
    DeserializationError error = deserializeJson(document, _localServer->arg("plain"));
    bool hasSchedule = !document["wake_time"].isNull() || !document["sleep_time"].isNull();
    String wake = document["wake_time"] | "", sleep = document["sleep_time"] | "";
    if (error || !document["interval_seconds"].is<double>() ||
        !parseIntervalMs(document["interval_seconds"].as<double>(), 1000, interval) ||
        (hasSchedule && (clockMinute(wake) < 0 || clockMinute(sleep) < 0))) {
      _localServer->send(400, "application/json", "{\"success\":false,\"error\":\"Invalid interval or wake/sleep clock\"}"); return;
    }
    applyTelemetryInterval(interval);
    if (hasSchedule) applyOperatingSchedule(wake, sleep);
    JsonDocument result;
    result["success"] = true;
    result["interval_ms"] = _telemetryIntervalMs;
    String payload;
    serializeJson(result, payload);
    _localServer->send(200, "application/json", payload);
  }
  static void syncTelemetryInterval() { syncNodeMetadataAndInterval(); }
  static void syncNodeMetadataAndInterval() {
    if (WiFi.status() != WL_CONNECTED) return;
    WiFiClientSecure client;
    HTTPClient https;
    String url = String(SUPABASE_URL) + SUPABASE_TABLE_NODES + "?name=eq." + _nodeId + "&select=*,rooms(name,floors(name,buildings(name)))";
    if (!beginCloudRequest(https, client, url)) return;
    if (https.GET() == 200) {
      JsonDocument document;
      if (!deserializeJson(document, https.getString()) && document.size() == 1) {
        JsonObject node = document[0].as<JsonObject>();
        _registryNodeId = node["id"].as<String>();

        // 1. Telemetry Interval & Operating Schedule
        String unit = node["interval_unit"] | "Minutes";
        unit.toLowerCase();
        double multiplier = unit.startsWith("sec") ? 1000 : unit.startsWith("min") ? 60000 :
          (unit.startsWith("hour") || unit.startsWith("hr")) ? 3600000 : 0;
        unsigned long interval;
        if (multiplier && parseIntervalMs(node["interval_val"].as<double>(), multiplier, interval)) applyTelemetryInterval(interval);
        applyOperatingSchedule(node["wake_time"] | "", node["sleep_time"] | "");

        // 2. Dynamic Aircon Type
        if (!node["aircon_type"].isNull()) {
          String acType = node["aircon_type"].as<String>();
          if (acType.length() > 0 && acType != _airconType) {
            _airconType = acType;
            _preferences.putString("aircon", _airconType);
            Serial.printf("[CONFIG] Dynamic AC Type updated: %s\n", _airconType.c_str());
          }
        }

        // 3. Dynamic Location Hierarchy (Room -> Floor -> Building)
        if (node["rooms"].is<JsonObject>()) {
          JsonObject roomsObj = node["rooms"].as<JsonObject>();
          String rName = roomsObj["name"] | "";
          String fName = "";
          String bName = "";

          if (roomsObj["floors"].is<JsonObject>()) {
            JsonObject floorsObj = roomsObj["floors"].as<JsonObject>();
            fName = floorsObj["name"] | "";
            if (floorsObj["buildings"].is<JsonObject>()) {
              JsonObject bldObj = floorsObj["buildings"].as<JsonObject>();
              bName = bldObj["name"] | "";
            }
          }

          bool locationChanged = false;
          if (rName.length() > 0 && rName != _roomName) {
            _roomName = rName;
            _preferences.putString("room", _roomName);
            locationChanged = true;
          }
          if (fName.length() > 0 && fName != _floorName) {
            _floorName = fName;
            _preferences.putString("floor", _floorName);
            locationChanged = true;
          }
          if (bName.length() > 0 && bName != _buildingName) {
            _buildingName = bName;
            _preferences.putString("bld", _buildingName);
            locationChanged = true;
          }

          if (locationChanged) {
            Serial.printf("[CONFIG] Dynamic Location updated: Room='%s' | Floor='%s' | Building='%s'\n",
              _roomName.c_str(), _floorName.c_str(), _buildingName.c_str());
          }
        }
      }
    }
    https.end();
  }
  static bool boolState(JsonVariantConst value, bool fallback = false) {
    if (value.isNull()) return fallback;
    if (value.is<bool>()) return value.as<bool>();
    String text = value.as<String>(); text.toLowerCase();
    return text == "on" || text == "true" || text == "1";
  }
  static String intentSignature(const String& protocol, JsonObjectConst state) {
    // Normalize field order and defaults so LAN and JSONB cloud representations compare equally.
    return protocol + ":" + (boolState(state["power"]) ? "1" : "0") + ":" +
      String(state["temp"] | 24) + ":" + String(state["mode"] | "cool") + ":" +
      String(state["fan"] | "auto") + ":" + String(boolState(state["swing"], true)) + ":" +
      String(boolState(state["turbo"])) + ":" + String(boolState(state["eco"]));
  }
  static bool dispatchIntent(const String& protocol, JsonObjectConst state) {
    return IRController::sendStructuredIntent(protocol, boolState(state["power"]), state["mode"] | "cool",
      state["temp"] | 24, state["fan"] | "auto", boolState(state["swing"], true),
      boolState(state["turbo"]), boolState(state["eco"]));
  }
  static void recordIntentDelivery(const String& commandId, const String& airconId, const String& signature) {
    _lastIntentSignature = signature;
    _preferences.putString("intent_sig", signature);
    if (!commandId.length() || !airconId.length()) return;
    JsonDocument receipt;
    receipt["success"] = true; receipt["result"] = "SUCCESS";
    receipt["command_id"] = commandId; receipt["aircon_id"] = airconId; receipt["node_id"] = _nodeId;
    _lastIntentReceipt = "";
    serializeJson(receipt, _lastIntentReceipt);
    _preferences.putString("intent_receipt", _lastIntentReceipt);
  }
  static void handleDeliveryReceipt() {
    cors();
    _localServer->send(_lastIntentReceipt.length() ? 200 : 404, "application/json", _lastIntentReceipt.length() ?
      _lastIntentReceipt : "{\"success\":false,\"error\":\"No command delivery receipt\"}");
  }
  static void handleIntentEndpoint() {
    cors();
    JsonDocument document;
    if (deserializeJson(document, _localServer->arg("plain"))) {
      _localServer->send(400, "application/json", "{\"success\":false,\"error\":\"Invalid JSON\"}"); return;
    }
    String protocol = document["protocol"] | "";
    JsonObject state = document["state"].is<JsonObject>() ? document["state"].as<JsonObject>() : document.as<JsonObject>();
    if (!protocol.length() || state["power"].isNull() || !state["temp"].is<int>() ||
        state["temp"].as<int>() < 16 || state["temp"].as<int>() > 32) {
      _localServer->send(400, "application/json", "{\"success\":false,\"error\":\"Supply protocol, power and a 16-32C setpoint\"}"); return;
    }
    bool success = dispatchIntent(protocol, state);
    if (success) {
      String commandId = document["command_id"] | "", airconId = document["aircon_id"] | "";
      recordIntentDelivery(commandId, airconId, commandId.length() ? commandId : intentSignature(protocol, state));
    }
    _localServer->send(success ? 200 : 422, "application/json", success ?
      "{\"success\":true,\"result\":\"SUCCESS\",\"message\":\"IR command transmitted\"}" :
      "{\"success\":false,\"result\":\"FAILED\",\"error\":\"Unsupported protocol or IR library unavailable\"}");
  }
  static void handlePingEndpoint() {
    cors();
    JsonDocument result;
    result["status"] = "online"; result["node_id"] = _nodeId;
    result["ip"] = WiFi.localIP().toString(); result["rssi"] = WiFi.RSSI();
    result["battery"] = PowerManager::getPercentage(); result["voltage"] = PowerManager::getVoltage();
    result["state"] = PowerManager::getStateString(); result["uptime_s"] = millis() / 1000;
    result["room_name"] = _roomName; result["floor_name"] = _floorName;
    result["building_name"] = _buildingName; result["aircon_type"] = _airconType;
    String payload; serializeJson(result, payload);
    _localServer->send(200, "application/json", payload);
  }
  static void handleSetLocationEndpoint() {
    cors();
    JsonDocument document;
    if (deserializeJson(document, _localServer->arg("plain"))) {
      _localServer->send(400, "application/json", "{\"success\":false,\"error\":\"Invalid JSON\"}"); return;
    }
    String room = document["room_name"] | document["room"] | "";
    String floor = document["floor_name"] | document["floor"] | "";
    String building = document["building_name"] | document["building"] | "";
    String aircon = document["aircon_type"] | document["aircon"] | "";

    setLocation(room, floor, building, aircon, true);

    JsonDocument result;
    result["success"] = true;
    result["room_name"] = _roomName;
    result["floor_name"] = _floorName;
    result["building_name"] = _buildingName;
    result["aircon_type"] = _airconType;
    String payload;
    serializeJson(result, payload);
    _localServer->send(200, "application/json", payload);
  }
  static void handleLatestLearned() {
    cors();
    _localServer->send(_latestLearned.length() ? 200 : 404, "application/json", _latestLearned.length() ?
      _latestLearned : "{\"success\":false,\"error\":\"No remote frame captured since boot\"}");
  }
  static void handleLocalIrTrigger() {
    cors();
    JsonDocument document;
    bool parsed = !deserializeJson(document, _localServer->arg("plain"));
    String raw = parsed ? document["raw_data"].as<String>() : String();
    bool success = raw.length() && IRController::sendRawTimings(raw);
    _localServer->send(success ? 200 : 400, "application/json", success ?
      "{\"success\":true,\"result\":\"SUCCESS\"}" : "{\"success\":false,\"error\":\"Supply real raw_data timings\"}");
  }
  static void handleSniffProtocol() {
    cors();
    String protocol, raw, hex;
    unsigned long start = millis();
    while (millis() - start < 6000UL) {
      if (IRController::checkForReceivedSignal(protocol, raw, hex)) {
        recordLearnedSignal(protocol, raw, hex);
        _localServer->send(200, "application/json", _latestLearned); return;
      }
      delay(5);
    }
    _localServer->send(408, "application/json", "{\"success\":false,\"error\":\"No remote signal received\"}");
  }
};

// ==============================================================================
// SECTION 8: MAIN SKETCH STATE & RUNTIME LOGIC
// ==============================================================================

// Active Runtime Node Identity
String activeNodeId = NODE_ID;

// Loop Timers
unsigned long lastTelemetryMs = 0;
unsigned long lastCommandPollMs = 0;
unsigned long lastBattCheckMs = 0;
unsigned long lastWifiCheckMs = 0;

// No ambient sensor is wired in this configuration. Publish unknown until a real sensor supplies a reading.
float currentTemperature = NAN;

// Forward Declarations
void printStartupBanner();
String resolveNodeIdentity();
void connectWiFi();

void setup() {
  // Initialize Serial Monitor
  Serial.begin(115200);
  delay(1000);

  // 1. Resolve Node Identity (Explicit or Auto-MAC)
  activeNodeId = resolveNodeIdentity();

  // Load persistent configurations (stored schedule, location, AC type)
  SupabaseManager::init(activeNodeId);

  printStartupBanner();

  // 2. Initialize Battery & Power Subsystem (ADC + TP4056 + Dual LEDs)
  PowerManager::init();

  // 3. Initialize Infrared Controller (TX on GPIO 4, RX on GPIO 5)
  IRController::init();

  // 4. Initialize Bluetooth Low Energy (BLE 5.0 GATT Server)
  WifiProvisioning::init();
  BLEManager::init(activeNodeId);

  // 5. Connect to Wi-Fi (Primary or Backup SSID)
  connectWiFi();

  // 6. Sync initial cloud configuration (location, aircon type, interval, schedule) before first telemetry
  if (WiFi.status() == WL_CONNECTED) {
    SupabaseManager::syncNodeConfig();
    SupabaseManager::sendTelemetry(
      currentTemperature, 
      PowerManager::getPercentage(), 
      (int)WiFi.RSSI()
    );
    BLEManager::updateTelemetryStatus(WiFi.localIP().toString(), (int)WiFi.RSSI());
  }

  lastTelemetryMs = millis();
  lastCommandPollMs = millis();
  lastBattCheckMs = millis();
  lastWifiCheckMs = millis();

  Serial.println("[SYSTEM] Setup complete. EcoTrack Node fully operational.\n");
}

void loop() {
  unsigned long now = millis();
  if (WifiProvisioning::poll()) {
    BLEManager::updateTelemetryStatus(
      WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : "0.0.0.0",
      WiFi.status() == WL_CONNECTED ? (int)WiFi.RSSI() : -95);
  }

  // TASK 1: High-Speed HTTP Ping Server (Runs every cycle for < 1ms response to Dashboard)
  SupabaseManager::handleClientRequests();

  SupabaseManager::serviceScheduleAndConnectivity(currentTemperature);

  // TASK 2: Infrared Receiver Listener (Captures physical remote button presses)
  String rxProtocol, rxRaw, rxHex;
  if (IRController::checkForReceivedSignal(rxProtocol, rxRaw, rxHex)) {
    SupabaseManager::recordLearnedSignal(rxProtocol, rxRaw, rxHex);
    Serial.printf("[LEARN] Protocol: %s | Hex: 0x%s\n", rxProtocol.c_str(), rxHex.c_str());
    Serial.printf("[LEARN] RAW CSV: %s\n", rxRaw.c_str());
    PowerManager::flashGreenActivity(120);
  }

  // TASK 3: Battery Monitoring & LED Indicator Refresh (Every 5 seconds)
  if (now - lastBattCheckMs >= BATT_CHECK_INTERVAL_MS) {
    lastBattCheckMs = now;
    PowerManager::update();
  }

  // TASK 4: Cloud command fallback with exponential backoff; LAN dispatch is immediate
  if (now - lastCommandPollMs >= SupabaseManager::commandPollInterval()) {
    lastCommandPollMs = now;
    SupabaseManager::pollAirconCommands();
  }

  // TASK 5: Periodic Telemetry Push to Supabase (Configurable interval e.g. 15 mins)
  if (now - lastTelemetryMs >= _telemetryIntervalMs) {
    lastTelemetryMs = now;

    int rssi = (WiFi.status() == WL_CONNECTED) ? (int)WiFi.RSSI() : -95;
    
    Serial.printf("[TELEMETRY] Scheduled Push -> Temp: %.1fC | Batt: %d%% (%.2fV) | RSSI: %d dBm\n",
      currentTemperature, PowerManager::getPercentage(), PowerManager::getVoltage(), rssi);

    SupabaseManager::sendTelemetry(
      currentTemperature, 
      PowerManager::getPercentage(), 
      rssi
    );

    BLEManager::updateTelemetryStatus(
      (WiFi.status() == WL_CONNECTED) ? WiFi.localIP().toString() : "0.0.0.0", 
      rssi
    );
  }

  // TASK 6: Wi-Fi Reconnection Watchdog (Every 10 seconds)
  if (now - lastWifiCheckMs >= 10000) {
    lastWifiCheckMs = now;
    if (WiFi.status() != WL_CONNECTED && !WifiProvisioning::busy() && !WifiProvisioning::hasPending()) {
      Serial.println("[WIFI] Connection dropped. Attempting quick reconnect...");
      WiFi.reconnect();
    }
  }

  // Yield to prevent ESP32 watchdog triggers
  yield();
}

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS
// -----------------------------------------------------------------------------

// Resolves whether to use the hardcoded NODE_ID or auto-generate from hardware MAC
String resolveNodeIdentity() {
  String configured = String(NODE_ID);
  if (configured.equalsIgnoreCase("AUTO") || configured.length() == 0) {
    uint8_t mac[6];
    WiFi.macAddress(mac);
    char autoId[24];
    snprintf(autoId, sizeof(autoId), "node-%02x%02x", mac[4], mac[5]);
    Serial.printf("[CONFIG] Auto-detected Hardware Node Identity: %s\n", autoId);
    return String(autoId);
  }
  return configured;
}

// Connects to Wi-Fi with primary and fallback credentials
void connectWiFi() {
  if (WifiProvisioning::connectSaved() || WifiProvisioning::hasPending()) return;
  Serial.printf("[WIFI] Connecting to Primary SSID '%s'...\n", WIFI_SSID_PRIMARY);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(true); // Modem power saving during the operating window
  WiFi.begin(WIFI_SSID_PRIMARY, WIFI_PASS_PRIMARY);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_TIMEOUT_MS) {
    if (WifiProvisioning::hasPending()) return;
    delay(400);
    Serial.print(".");
    digitalWrite(PIN_PWR_LED, !digitalRead(PIN_PWR_LED)); // Toggle LED while connecting
  }
  digitalWrite(PIN_PWR_LED, HIGH); // Solid ON when running

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WIFI] Connected successfully! IP Address: %s | RSSI: %d dBm\n", 
      WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
    return;
  }

  // If Primary fails, attempt Backup SSID
  Serial.printf("\n[WIFI] Primary failed. Attempting Backup SSID '%s'...\n", WIFI_SSID_BACKUP);
  WiFi.begin(WIFI_SSID_BACKUP, WIFI_PASS_BACKUP);
  start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_TIMEOUT_MS) {
    if (WifiProvisioning::hasPending()) return;
    delay(400);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WIFI] Connected to Backup SSID! IP Address: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[WIFI] Warning: Wi-Fi offline. Continuing in local BLE-only mode.");
  }
}

void printStartupBanner() {
  Serial.println("\n=========================================================");
  Serial.println("   ECOTRACK AIRCON IOT CONTROLLER & TELEMETRY NODE       ");
  Serial.printf ("   Node Identity   : %s (%s)\n", activeNodeId.c_str(), DEVICE_NAME);
  Serial.printf ("   Location        : %s • %s • %s\n", 
    SupabaseManager::getRoomName().c_str(), 
    SupabaseManager::getFloorName().c_str(), 
    SupabaseManager::getBuildingName().c_str());
  Serial.printf ("   Aircon Type     : %s\n", SupabaseManager::getAirconType().c_str());
  Serial.printf ("   Firmware Build  : %s\n", FIRMWARE_VERSION);
  Serial.printf ("   Hardware Model  : %s\n", HARDWARE_MODEL);
  Serial.printf ("   Power Module    : Dual 18650 Battery Shield (5V & 3.3V Board)\n");
  Serial.printf ("   Switch & Power  : SPST ON/OFF Switch | Power LED -> GPIO %d\n", PIN_PWR_LED);
  Serial.printf ("   IR Hardware     : TX Blaster (NPN Base) -> GPIO %d | RX -> GPIO %d\n", PIN_IR_TX, PIN_IR_RX);
  Serial.printf ("   Battery Sense   : ADC -> GPIO %d (100k/100k Divider)\n", PIN_BATT_ADC);
  Serial.println("=========================================================\n");
}

