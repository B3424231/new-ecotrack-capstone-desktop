const fs = require('fs');

const staffJs = fs.readFileSync('public/js/staff.js', 'utf8');
new Function(staffJs);
console.log('staff.js syntax: OK');

const staffHtml = fs.readFileSync('public/staff.html', 'utf8');
console.log('tabArchivedBtn in HTML:', staffHtml.includes('id="tabArchivedBtn"'));
console.log('tabArchivedContent in HTML:', staffHtml.includes('id="tabArchivedContent"'));
console.log('archivedStaffTableBody in HTML:', staffHtml.includes('id="archivedStaffTableBody"'));
console.log('archiveStaffModal in HTML:', staffHtml.includes('id="archiveStaffModal"'));
console.log('archiveStaffReason in HTML:', staffHtml.includes('id="archiveStaffReason"'));
console.log('archiveStaffNotes in HTML:', staffHtml.includes('id="archiveStaffNotes"'));
console.log('archivedRecordDetailModal in HTML:', staffHtml.includes('id="archivedRecordDetailModal"'));
console.log('archivedDetailReason in HTML:', staffHtml.includes('id="archivedDetailReason"'));
console.log('archivedDetailRestoreBtn in HTML:', staffHtml.includes('id="archivedDetailRestoreBtn"'));
console.log('Old deleteStaffModal removed:', !staffHtml.includes('id="deleteStaffModal"'));
console.log('Old confirmDeleteBtn removed:', !staffHtml.includes('id="confirmDeleteBtn"'));

const logsJs = fs.readFileSync('public/js/logs.js', 'utf8');
new Function(logsJs);
console.log('logs.js syntax: OK');

const logsHtml = fs.readFileSync('public/logs.html', 'utf8');
console.log('startTimeFilter in HTML:', logsHtml.includes('id="startTimeFilter"'));
console.log('endTimeFilter in HTML:', logsHtml.includes('id="endTimeFilter"'));
console.log('clearTimeFilterBtn in HTML:', logsHtml.includes('id="clearTimeFilterBtn"'));

const profileJs = fs.readFileSync('public/js/profile.js', 'utf8');
new Function(profileJs);
console.log('profile.js syntax: OK');

console.log('staff.html password toggle buttons count:', (staffHtml.match(/password-toggle-btn/g) || []).length);
console.log('profile.html password toggle buttons count:', (fs.readFileSync('public/profile.html', 'utf8').match(/password-toggle-btn/g) || []).length);



