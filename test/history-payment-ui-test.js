// Kiểm tra nút thu tiền và trạng thái trong cửa sổ chi tiết lịch sử mà không cần DOM/browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const start = source.indexOf('async function openHistoryBill(id) {');
const end = source.indexOf('// ---------- admin ----------', start);
const elements = new Map();
const $ = id => {
  if (!elements.has(id)) elements.set(id, {
    hidden: false, disabled: false, open: false, textContent: '', innerHTML: '',
    showModal() { this.open = true; }, close() { this.open = false; }, addEventListener() {},
  });
  return elements.get(id);
};
const booking = { id: 9, user_id: 5, court_name: 'Court 01', status: 'confirmed', confirmed_at: '2026-01-01T00:00:00Z',
  starts_at: '2026-01-02T00:00:00Z', ends_at: '2026-01-02T01:00:00Z', created_at: '2026-01-01T00:00:00Z',
  paid: false, total_price: 80000, payment_method: 'onsite', player_name: 'An', player_phone: '0900000000' };
let settled = false, refreshed = 0, revenueRefresh = 0, cancellations = 0, approve = true;
const context = vm.createContext({
  can: key => require('../public/permissions').can(context.state.user,key),
  canCollect: () => require('../public/permissions').can(context.state.user,'cashCollect'),
  tariffLines: () => '',
  $, state: { token: 'token', user: { id: 1, role: 'admin' } },
  historyBillRequest: 0, historyBill: null, Date, Intl,
  money: n => n + 'đ', esc: x => String(x),
  paymentTag: b => b.paid ? '<span class="paid-tag">Đã thanh toán</span>' : '<span class="unpaid-tag">Chưa thanh toán</span>',
  historyDateTime: x => x || '—',
  playTimeText: x => x.starts_at + ' - ' + x.ends_at,
  bookingTimeText: x => x.confirmed_at || x.created_at || '—',
  api: async (route, options) => {
    if (route.endsWith('/invoice')) return { booking: { ...booking, paid: settled }, addons: [], base: 80000,
      total: 80000, paidAmount: settled ? 80000 : 0, due: settled ? 0 : 80000 };
    if (route.endsWith('/settle') && options?.method === 'POST') { settled = true; return { ok: true }; }
    if (route.endsWith('/cancel') && options?.method === 'PATCH') { booking.status = 'cancelled'; cancellations++; return { ok: true }; }
    throw new Error('unexpected route ' + route);
  },
  loadMine: async () => { refreshed++; }, loadRevenue: async () => { revenueRefresh++; },
  confirmBookingCancellation: async () => approve, toast() {},
});
vm.runInContext(source.slice(start, end), context);
(async () => {
  await vm.runInContext('openHistoryBill(9)', context);
  assert.equal($('#historyBillSettle').hidden, false);
  assert.equal($('#historyBillSettle').disabled, false);
  assert.equal($('#historyBillPrint').hidden, false, 'admin có nút xuất hóa đơn');
  booking.status = 'cancelled';
  await vm.runInContext('openHistoryBill(9)', context);
  assert.equal($('#historyBillSettle').hidden, false, 'booking đã xác nhận rồi hủy vẫn thu được trong lịch sử');
  await $('#historyBillSettle').onclick();
  assert.equal(settled, true);
  assert.equal($('#historyBillSettle').disabled, true);
  assert.match($('#historyBillContent').innerHTML, /Đã thanh toán/);
  assert.equal(refreshed, 1, 'làm mới tag ở danh sách sau khi xác nhận');
  settled = false;
  booking.confirmed_at = null;
  await vm.runInContext('openHistoryBill(9)', context);
  assert.equal($('#historyBillSettle').hidden, true, 'không xác nhận thu tiền cho booking chưa từng xác nhận');
  booking.confirmed_at = '2026-01-01T00:00:00Z';
  booking.status = 'confirmed';
  await vm.runInContext('openHistoryBill(9)', context);
  assert.equal($('#historyBillCancel').hidden, false, 'admin hủy được booking đã hoàn thành');
  await $('#historyBillCancel').onclick();
  assert.equal(cancellations, 1);
  assert.equal($('#historyBillCancel').hidden, true, 'booking đã hủy không hiện nút hủy lần hai');
  assert.equal(revenueRefresh, 1);
  assert.equal(refreshed, 2);
  context.state.user.role = 'user';
  context.state.user.id = 5;
  await vm.runInContext('openHistoryBill(9)', context);
  assert.equal($('#historyBillSettle').hidden, true, 'khách hàng không có nút xác nhận');
  assert.equal($('#historyBillPrint').hidden, true, 'khách hàng không có nút xuất hóa đơn');
  assert.equal($('#historyBillCancel').hidden, true, 'booking đã hủy không thể hủy lần nữa');
  booking.status = 'confirmed';
  await vm.runInContext('openHistoryBill(9)', context);
  assert.equal($('#historyBillCancel').hidden, true, 'người chơi không hủy được booking đã qua');
  booking.starts_at = new Date(Date.now() + 86400000).toISOString();
  booking.ends_at = new Date(Date.now() + 90000000).toISOString();
  await vm.runInContext('openHistoryBill(9)', context);
  assert.equal($('#historyBillCancel').hidden, false, 'người chơi chỉ thấy nút hủy trong chi tiết booking sắp tới');
  approve = false;
  await $('#historyBillCancel').onclick();
  assert.equal(cancellations, 1, 'đóng popup xác nhận không hủy booking');
  approve = true;
  await $('#historyBillCancel').onclick();
  assert.equal(cancellations, 2);
  console.log('History invoice: admin settlement, cancelled confirmed booking, refreshed tag, user rights OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
