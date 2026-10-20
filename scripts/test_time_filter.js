// Test time filtering logic
function filterByTime(logs, start, end) {
  return logs.filter(log => {
    const logMinutes = log.timestamp.getHours() * 60 + log.timestamp.getMinutes();

    if (start && end) {
      const [sH, sM] = start.split(':').map(Number);
      const [eH, eM] = end.split(':').map(Number);
      const startMinutes = sH * 60 + sM;
      const endMinutes = eH * 60 + eM;

      if (startMinutes <= endMinutes) {
        return logMinutes >= startMinutes && logMinutes <= endMinutes;
      } else {
        return logMinutes >= startMinutes || logMinutes <= endMinutes;
      }
    }

    if (start) {
      const [sH, sM] = start.split(':').map(Number);
      return logMinutes >= sH * 60 + sM;
    }

    if (end) {
      const [eH, eM] = end.split(':').map(Number);
      return logMinutes <= eH * 60 + eM;
    }

    return true;
  });
}

const mockLogs = [
  { id: 1, timestamp: new Date('2026-08-30T07:30:00') },
  { id: 2, timestamp: new Date('2026-08-30T09:15:00') },
  { id: 3, timestamp: new Date('2026-08-30T14:45:00') },
  { id: 4, timestamp: new Date('2026-08-30T18:00:00') },
  { id: 5, timestamp: new Date('2026-08-30T23:30:00') }
];

console.log('Total mock logs:', mockLogs.length);

const workHours = filterByTime(mockLogs, '08:00', '17:00');
console.log('Work hours (08:00-17:00) count (expect 2: 09:15, 14:45):', workHours.length, workHours.map(l => l.id));

const after12 = filterByTime(mockLogs, '12:00', '');
console.log('After 12:00 count (expect 3: 14:45, 18:00, 23:30):', after12.length, after12.map(l => l.id));

const before10 = filterByTime(mockLogs, '', '10:00');
console.log('Before 10:00 count (expect 2: 07:30, 09:15):', before10.length, before10.map(l => l.id));

const overnight = filterByTime(mockLogs, '20:00', '08:00');
console.log('Overnight (20:00-08:00) count (expect 2: 07:30, 23:30):', overnight.length, overnight.map(l => l.id));

if (workHours.length === 2 && after12.length === 3 && before10.length === 2 && overnight.length === 2) {
  console.log('✅ ALL TIME FILTER LOGIC TESTS PASSED!');
} else {
  console.error('❌ Time filter test failure');
  process.exit(1);
}
