const { execFile } = require('child_process');
execFile('netsh', ['wlan', 'show', 'networks', 'mode=bssid'], (err, stdout) => {
  const blocks = stdout.split(/^\s*SSID \d+\s*:/m);
  console.log('Total raw blocks:', blocks.length);
  for (let i = 0; i < blocks.length; i++) {
    console.log('--- Block ' + i + ' ---');
    console.log(JSON.stringify(blocks[i].slice(0, 100)));
  }
});
