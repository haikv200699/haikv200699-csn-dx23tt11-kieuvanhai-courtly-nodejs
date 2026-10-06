// Thời điểm đặt là lúc xác nhận thành công, theo giờ Việt Nam và chỉ hiển thị giờ/phút.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
const begin = app.indexOf('const bookingTimeText =');
const end = app.indexOf('const todayStr =', begin);
const format = vm.runInNewContext(`const fmtT = iso => new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Ho_Chi_Minh' }); ${app.slice(begin, end)} bookingTimeText`, { Date });
const times = { created_at: '2026-09-28T06:00:00Z', confirmed_at: '2026-09-28T06:04:08Z' };
assert.equal(format(times), '13:04');
assert.notEqual(format(times), '13:00', 'không lấy thời gian giữ chỗ làm lúc đặt thành công');
assert.equal(format({ created_at: times.created_at }), '13:00', 'booking cũ có dữ liệu dự phòng');
assert.equal(format({}), '—');
assert.match(server, /SELECT b\.id, b\.user_id, b\.court_id, b\.starts_at, b\.ends_at, b\.status, b\.created_at, b\.confirmed_at/);
assert.match(server, /io\.emit\('admin:newBooking', \{ id: b\.id, courtId: b\.court_id \}\)/, 'public notifications must not include player information');
assert.match(app, /socket\.on\('booking:created', refreshAfterChange\)/);
console.log('Booking timestamp: confirmation, timezone, seconds, legacy fallback and live refresh OK');
