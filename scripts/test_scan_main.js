const { execFile } = require('child_process');
const path = require('path');

const wifiNetworkMemoryCache = new Map();

function runScan() {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, 'wlan_scan.ps1');
    execFile('powershell', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath], { timeout: 3000 }, (errPs) => {
      console.log('wlan_scan.ps1 err:', errPs);
      setTimeout(() => {
        execFile('netsh', ['wlan', 'show', 'networks', 'mode=bssid'], { timeout: 10000 }, (err1, bssidStdout) => {
          console.log('netsh bssid err:', err1);
          execFile('netsh', ['wlan', 'show', 'networks'], { timeout: 10000 }, (err2, plainStdout) => {
            console.log('netsh plain err:', err2);
            try {
              if (bssidStdout) {
                const blocks = bssidStdout.split(/^\s*SSID \d+\s*:/m);
                blocks.shift();

                for (const block of blocks) {
                  const lines = block.split('\n').map(l => l.trim());
                  const ssid = lines[0] ? lines[0].trim() : '';
                  if (!ssid) continue;

                  const authLine = lines.find(l => l.toLowerCase().startsWith('authentication') || l.toLowerCase().startsWith('autenticaci'));
                  const authStr = authLine ? authLine.split(':').slice(1).join(':').trim() : 'WPA2-Personal';

                  const bssidBlocks = block.split(/^\s*BSSID \d+\s*:/m);
                  bssidBlocks.shift();

                  let bestQuality = -1;
                  let bestChannel = 6;
                  if (bssidBlocks.length > 0) {
                    for (const bBlock of bssidBlocks) {
                      const bLines = bBlock.split('\n').map(l => l.trim());
                      const getBVal = (lbl) => {
                        const l = bLines.find(x => x.toLowerCase().startsWith(lbl.toLowerCase()));
                        return l ? l.split(':').slice(1).join(':').trim() : '';
                      };
                      const sig = parseInt((getBVal('Signal') || getBVal('Señal') || '0%').replace('%', ''), 10) || 0;
                      const ch = parseInt(getBVal('Channel') || getBVal('Canal') || '0', 10) || 0;
                      if (ch <= 14 && sig > bestQuality) {
                        bestQuality = sig;
                        bestChannel = ch || 6;
                      }
                    }
                  } else {
                    const sig = parseInt((lines.find(l => l.toLowerCase().startsWith('signal'))?.split(':')?.[1] || '0').replace('%', ''), 10) || 0;
                    const ch = parseInt((lines.find(l => l.toLowerCase().startsWith('channel'))?.split(':')?.[1] || '0').trim(), 10) || 0;
                    if (ch <= 14) {
                      bestQuality = sig;
                      bestChannel = ch || 6;
                    }
                  }

                  if (bestQuality >= 0) {
                    wifiNetworkMemoryCache.set(ssid, {
                      ssid,
                      rssi: Math.round(-100 + bestQuality * 0.65),
                      quality: bestQuality,
                      channel: bestChannel,
                      security: authStr || 'WPA2-Personal',
                      is24Ghz: true,
                      lastSeen: Date.now()
                    });
                  }
                }
              }

              if (plainStdout) {
                const blocks = plainStdout.split(/^\s*SSID \d+\s*:/m);
                blocks.shift();

                for (const block of blocks) {
                  const lines = block.split('\n').map(l => l.trim());
                  const ssid = lines[0] ? lines[0].trim() : '';
                  if (!ssid) continue;

                  const authLine = lines.find(l => l.toLowerCase().startsWith('authentication') || l.toLowerCase().startsWith('autenticaci'));
                  const authStr = authLine ? authLine.split(':').slice(1).join(':').trim() : 'WPA2-Personal';

                  if (!wifiNetworkMemoryCache.has(ssid)) {
                    wifiNetworkMemoryCache.set(ssid, {
                      ssid,
                      rssi: -74,
                      quality: 40,
                      channel: 6,
                      security: authStr || 'WPA2-Personal',
                      is24Ghz: true,
                      lastSeen: Date.now()
                    });
                  }
                }
              }

              execFile('netsh', ['wlan', 'show', 'interfaces'], { timeout: 4000 }, (err3, ifaceStdout) => {
                if (ifaceStdout) {
                  const lines = ifaceStdout.split('\n').map(l => l.trim());
                  const ssidLine = lines.find(l => l.startsWith('SSID') && !l.startsWith('BSSID'));
                  const sigLine = lines.find(l => l.startsWith('Signal'));
                  const chLine = lines.find(l => l.startsWith('Channel'));
                  if (ssidLine) {
                    const ssid = ssidLine.split(':').slice(1).join(':').trim();
                    const sig = parseInt((sigLine?.split(':')?.[1] || '100').replace('%', ''), 10) || 100;
                    const ch = parseInt((chLine?.split(':')?.[1] || '6').trim(), 10) || 6;
                    if (ssid) {
                      wifiNetworkMemoryCache.set(ssid, {
                        ssid,
                        rssi: Math.round(-100 + sig * 0.65),
                        quality: sig,
                        channel: ch,
                        security: 'WPA2-Personal',
                        is24Ghz: true,
                        lastSeen: Date.now()
                      });
                    }
                  }
                }
                finish();
              });

              function finish() {
                const networks = Array.from(wifiNetworkMemoryCache.values());
                networks.sort((a, b) => b.quality - a.quality);
                if (networks.length > 0) networks[0].isRecommended = true;

                resolve({ success: true, networks });
              }
            } catch (parseErr) {
              resolve({ success: false, networks: [], error: parseErr.message });
            }
          });
        });
      }, 500);
    });
  });
}

runScan().then(res => {
  console.log('Scan result count:', res.networks.length);
  console.log('Networks:', res.networks.map(n => ({ ssid: n.ssid, quality: n.quality, channel: n.channel, is24: n.is24Ghz })));
});
