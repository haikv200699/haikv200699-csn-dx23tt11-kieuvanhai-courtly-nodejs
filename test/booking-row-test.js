// Booking hôm nay: giới hạn sáu hàng nhìn thấy, vai trò và thanh toán độc lập.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const begin = source.indexOf('const paidTag =');
const end = source.indexOf('// Toàn bộ booking phân trang:', begin);
assert.ok(begin >= 0 && end > begin);
const elements = new Map(), opens = [];
const $ = id => {
  if (!elements.has(id)) {
    const values = new Set();
    elements.set(id, {
      innerHTML: '', textContent: '', hidden: false, open: false, scrollTop: 0,
      classList: { toggle(name, on) { on ? values.add(name) : values.delete(name); }, contains(name) { return values.has(name); } },
      addEventListener(type, cb) { this[type] = cb; },
    });
  }
  return elements.get(id);
};
const future = new Date(Date.now() + 86400000);
const booking = { id: 42, user_id: 5, status: 'confirmed', court_name: 'Court 01',
  player_name: 'An', player_phone: '0912345678', total_price: 80000,
  payment_method: 'transfer', paid: false, confirmed_at: new Date().toISOString(),
  starts_at: future.toISOString(), ends_at: new Date(+future + 3600000).toISOString() };
let bookings = [booking];
const state = { token: 'token', user: { id: 5, role: 'admin' } };
const context = vm.createContext({
  bookingTimeText:()=> '09:00', can:key=>require('../public/permissions').can(state.user,key),
  $, state, Date, Number, String, TZ: 'Asia/Ho_Chi_Minh',
  todayStr: () => new Date(booking.starts_at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }),
  fmtD: () => 'Hôm nay', fmtT: () => '08:00', money: n => `${n}đ`, durationText: () => '1 giờ', esc: String,
  api: async route => route === '/bookings/mine' ? bookings : { ok: true },
  openBookingExtras: id => opens.push(['extras', id]),
  openHistoryBill: id => opens.push(['invoice', id]),
  openTransferPayment: id => opens.push(['payment', id]),
  toast() {}, setInterval() {}, historyPage: 1,
});
vm.runInContext(source.slice(begin, end), context);
const eventFor = (selector, id) => ({ target: { closest: value => value === selector ? { dataset: id } : null } });
(async () => {
  await vm.runInContext('loadMine()', context);
  assert.equal($('#todayDate').textContent, 'Hôm nay');
  assert.equal($('#todayCount').textContent, '1 booking');
  assert.match($('#todayHead').innerHTML, /STT.*Sân.*Thời gian.*Người chơi.*Giá trị/);
  assert.match($('#upcoming').innerHTML, /class="today-row booking-row"/);
  assert.match($('#upcoming').innerHTML, /class="today-order">#42<\/span>/);
  assert.match($('#upcoming').innerHTML, /class="today-person"><b>An<\/b><small>0912345678<\/small>/);
  assert.match($('#upcoming').innerHTML, /class="today-time"><b>08:00 – 08:00<\/b><small>1 giờ<\/small>/);
  assert.match($('#upcoming').innerHTML, /data-open-upcoming="42"/);
  assert.match($('#upcoming').innerHTML, /<strong>80000đ<\/strong><span class="today-status"><span class="awaiting-tag">Chờ xác nhận<\/span>/,
    'nhãn chờ xác nhận nằm ngay dưới số tiền kể cả với admin');
  assert.doesNotMatch($('#upcoming').innerHTML, /booking-created-at|data-cancel=/);
  assert.match(html, /id="upcoming" class="today-rail"[^>]+><\/div>/);
  assert.match(html, /id="historyMore">Toàn bộ booking<\/button>/);
  assert.match(css, /\.today-rail\.has-more\{max-height:min\(calc\(6 \* var\(--today-row-height\)/);
  assert.match(css, /\.today-rail\{[^}]*touch-action:pan-y/);

  bookings = Array.from({ length: 8 }, (_, i) => ({ ...booking, id: 42 + i }));
  await vm.runInContext('loadMine()', context);
  assert.equal(($('#upcoming').innerHTML.match(/class="today-row booking-row"/g) || []).length, 8);
  assert.equal($('#upcoming').classList.contains('has-more'), true);
  assert.equal($('#todayHint').hidden, false);
  bookings = [booking, { ...booking, id: 100, starts_at: new Date(+future + 86400000).toISOString() }];
  await vm.runInContext('loadMine()', context);
  assert.equal($('#todayCount').textContent, '1 booking', 'ngày khác không có trong danh sách hôm nay');
  assert.equal($('#upcoming').classList.contains('has-more'), false);
  bookings = [booking];
  await $('#upcoming').click(eventFor('[data-open-upcoming]', { openUpcoming: '42' }));
  assert.deepEqual(opens.pop(), ['extras', '42']);

  state.user.role = 'user';
  await vm.runInContext('loadMine()', context);
  assert.match($('#upcoming').innerHTML, /class="today-row booking-row today-row-user"/);
  assert.doesNotMatch($('#upcoming').innerHTML, /class="today-order"|class="today-person"|0912345678/);
  assert.match($('#upcoming').innerHTML, /data-payment="42">Thanh toán ngay<\/button>/);
  assert.match($('#upcoming').innerHTML, /class="awaiting-tag">Chờ xác nhận<\/span>/);
  assert.equal($('#upcoming').classList.contains('today-rail-user'), true);
  booking.paid = true;
  await vm.runInContext('loadMine()', context);
  assert.match($('#upcoming').innerHTML, /Đã thanh toán/);
  assert.doesNotMatch($('#upcoming').innerHTML, /data-payment=/);
  booking.paid_amount = 40000; booking.invoice_total = 80000;
  await vm.runInContext('loadMine()', context);
  assert.match($('#upcoming').innerHTML, /Chưa thanh toán/, 'dịch vụ chưa thu vẫn hiện trạng thái chưa thanh toán');
  assert.doesNotMatch($('#upcoming').innerHTML, /Thanh toán ngay/, 'tiền sân đã thu thì không mở lại QR thanh toán tiền sân');
  delete booking.paid_amount; delete booking.invoice_total;
  booking.paid = false; booking.payment_method = 'onsite';
  await vm.runInContext('loadMine()', context);
  assert.match($('#upcoming').innerHTML, /Chưa thanh toán/);
  assert.doesNotMatch($('#upcoming').innerHTML, /data-payment=/);
  booking.payment_method = 'transfer';
  await vm.runInContext('loadMine()', context);
  await $('#upcoming').click(eventFor('[data-open-upcoming]', { openUpcoming: '42' }));
  assert.deepEqual(opens.pop(), ['invoice', '42']);
  await $('#upcoming').click(eventFor('[data-payment]', { payment: '42' }));
  assert.deepEqual(opens.pop(), ['payment', '42']);
  booking.status = 'cancelled';
  await vm.runInContext('loadMine()', context);
  assert.match($('#upcoming').innerHTML, /Đã hủy/);
  assert.doesNotMatch($('#upcoming').innerHTML, /data-payment=/, 'booking đã hủy không hiện nút thanh toán');
  assert.match(css, /\.today-status \.paid-tag,\.today-status \.unpaid-tag,\.today-status \.awaiting-tag,\.today-status \.booking-row-payment\{[^}]*line-height:1\.2/);
  assert.match(css, /\.today-status \.awaiting-tag\{border-color:#ef9b45/);
  console.log('Today bookings: six-row rail, role-specific fields, date scope and payment actions OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
