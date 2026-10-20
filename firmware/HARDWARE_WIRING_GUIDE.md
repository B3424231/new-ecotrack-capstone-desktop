# EcoTrack ESP32-S3 Aircon Controller — Hardware Wiring Guide

> **Firmware:** [esp32s3_ecotrack_node.ino](file:///c:/Users/reygay/Desktop/EcoTrackDesktopDashboardNew-main-control/firmware/esp32s3_ecotrack_node/esp32s3_ecotrack_node.ino) (`v2.5.0-WiFi`)  
> **Target MCU:** ESP32-S3 DevKit (Dual-Core Xtensa LX7, 2.4GHz Wi-Fi + BLE 5.0)

---

## 1. Bill of Materials (Required Parts)

| # | Part | Specifications | Role |
|:-:|:---|:---|:---|
| 1 | **ESP32-S3 DevKit** | ESP32-S3-WROOM-1 (38-pin / 44-pin) | Main Controller (Wi-Fi, BLE, IR PWM) |
| 2 | **Dual 18650 Battery Shield** | Dual 18650 holder with 5V & 3V/3.3V board | Main power bank & onboard charging |
| 3 | **SPST Power Switch** | 2-pin Toggle / Slide switch | Master ON/OFF power control |
| 4 | **Power Indicator LED** | 3mm/5mm LED (Green, Red, or Blue) | Indicates if ESP32-S3 is ON or OFF |
| 5 | **NPN Transistor** | 2N2222, S8050, or 2N3904 (TO-92) | Drives high-current pulses to IR TX |
| 6 | **IR Transmitter LED** | 940nm High-Power Infrared LED (5mm) | Transmits 38kHz AC remote commands |
| 7 | **IR Receiver Sensor** | VS1838B or TSOP38238 (38kHz) | Receives remote signals for auto-learning |
| 8 | **Resistors** | 1kΩ (1x), 47Ω–100Ω (1x), 220Ω–330Ω (1x), 100kΩ (2x) | Transistor base, IR LED, power LED, battery ADC |

---

## 2. Master Wiring & Pinout Table

| ESP32-S3 Pin | Connected Component | Component Pin | Notes |
|:---|:---|:---|:---|
| **VIN / 5V** | SPST Switch Output | Output Terminal | Powers ESP32-S3 from Battery Shield 5V |
| **GND** | Dual 18650 Shield | GND Terminal | Common System Ground |
| **GPIO 4** | Transistor Base Resistor (1kΩ) | NPN Base (B) | 38kHz IR TX signal drive |
| **GPIO 5** | IR Receiver (VS1838B) | Pin 1: OUT / DATA | Demodulated IR remote input |
| **GPIO 15** | Power LED Resistor (220Ω–330Ω) | Power LED Anode (+) | ON = ESP32-S3 running / OFF = Powered off |
| **GPIO 1** | Voltage Divider Junction | 100kΩ / 100kΩ | Battery ADC sensing (0V – 2.1V) |
| **3V3** | IR Receiver (VS1838B) | Pin 3: VCC | Clean 3.3V sensor supply |

---

## 3. Subsystem Wiring Details

### 3.1 Power Supply & ON/OFF Switch
- **Dual 18650 Board 5V** ➔ **SPST Switch Terminal 1**
- **SPST Switch Terminal 2** ➔ **ESP32-S3 VIN (5V)** & **IR LED Current Resistor**
- **Dual 18650 Board GND** ➔ **ESP32-S3 GND** (Common Ground)

### 3.2 Power Indicator LED (ESP32-S3 Status)
- **ESP32-S3 GPIO 15** ➔ **220Ω–330Ω Resistor** ➔ **LED Anode (+)**
- **LED Cathode (-)** ➔ **GND**  
*(Firmware drives GPIO 15 HIGH on boot; stays solid ON while ESP32-S3 is running and goes dark when switched OFF).*

### 3.3 IR Transmitter (High-Power Blaster)
- **ESP32-S3 GPIO 4** ➔ **1kΩ Resistor** ➔ **NPN Base (B)**
- **NPN Emitter (E)** ➔ **GND**
- **NPN Collector (C)** ➔ **IR LED Cathode (-)**
- **IR LED Anode (+)** ➔ **47Ω–100Ω Resistor** ➔ **5V Rail**

### 3.4 IR Receiver (Learning Demodulator)
- **VS1838B Pin 1 (OUT)** ➔ **ESP32-S3 GPIO 5**
- **VS1838B Pin 2 (GND)** ➔ **GND**
- **VS1838B Pin 3 (VCC)** ➔ **ESP32-S3 3V3**

### 3.5 Battery Sensing (ADC Divider)
- **Battery (+) Rail** ➔ **100kΩ Resistor** ➔ **GPIO 1 (ADC1_CH0)**
- **GPIO 1** ➔ **100kΩ Resistor** ➔ **GND**

---

## 4. Connection Diagram

```
           +-----------------------------------------------------------+
           |       Dual 18650 Battery Shield (5V & 3V Board)           |
           |   [BAT+]                                  [5V]    [GND]   |
           +-----+---------------------------------------+-------+-----+
                 |                                       |       |
                 |                                  [SPST Switch] |
                 |                                       |       |
                 |        +------------------------------+       |
                 |        | (Switched 5V Rail)                   |
                 |        |                                      |
                 |        |          +------------------+        |
                 |        +--------->| VIN              |        |
                 |                   |                  |        |
                 |  +----------------| 3V3          GND |<-------+
                 |  |                |                  |        |
                 |  |   +------------| GPIO 15 (PWR LED)|        |
                 |  |   |            |                  |        |
                 |  |   |   +--------| GPIO 4  (IR TX)  |        |
                 |  |   |   |        |                  |        |
                 |  |   |   |   +----| GPIO 5  (IR RX)  |        |
                 |  |   |   |   |    |                  |        |
                 |  |   |   |   | +--| GPIO 1  (BAT ADC)|        |
                 |  |   |   |   | |  +------------------+        |
                 |  |   |   |   | |         ESP32-S3             |
                 |  |   |   |   | |                              |
                 |  |   |   |   | +----[100k]----+----[100k]-----+
                 +--|---|---|---|----------------+               |
                    |   |   |   |                                |
                    |   |   |   +--------> [VS1838B Pin 1: OUT]  |
                    +---|---|------------> [VS1838B Pin 3: VCC]  |
                    |   |   |              [VS1838B Pin 2: GND]--+
                    |   |   |                                    |
                    |   |   +---> [1kΩ] -> Base (B) 2N2222       |
                    |   |                  Emitter (E) ----------+
                    |   |                  Collector (C)         |
                    |   |                     |                  |
                    |   |                  [ - Cathode ]         |
                    |   |                  940nm IR LED          |
                    |   |                  [ + Anode   ]         |
                    |   |                     |                  |
                    |   +---> [220Ω] -> [LED] +--- [47Ω-100Ω] <--+ (Switched 5V)
                    |                    |
                    +--------------------+ (Common Ground)
```

---

## 5. Quick Verification Steps

1. **Power Check:** Turn the SPST switch ON. The Power LED illuminates instantly and the ESP32-S3 boots up.
2. **Serial Monitor:** Open Serial at **115200 baud**. The startup banner confirms:
   - Node identity (`activeNodeId`)
   - Wi-Fi connection with assigned IP
   - Power & Battery voltage reading (~3.7V–4.2V)
3. **IR Transmit Test:** From the Dashboard or Protocol Studio, trigger an AC command. The Power LED gives a quick confirmation flash as the IR blaster fires.
4. **IR Receive Test:** Point any AC remote at the VS1838B receiver and press a button; Serial Monitor will print captured protocol and timing data.
