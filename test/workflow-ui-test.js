// Luồng từng bước, lịch sử riêng của người chơi và định dạng thời gian.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
assert.match(html, /id="bkCourtStage" hidden/);
assert.match(html, /id="bkTimeStage" hidden/);
assert.match(html, /id="asCourtStage" hidden/);
assert.match(html, /id="asTimeStage" hidden/);
assert.match(html, /id="paymentSettingsSection" class="profile-payment" hidden/);
assert.doesNotMatch(html, /id="historyBillBack"|id="maint"|id="revFrom"|id="revTo"/);
assert.match(html, /name="underMaintenance"/);
assert.match(html, /id="revRangeToggle"/);
assert.match(css, /\.history-bill-actions #historyBillPrint\{grid-column:1\/-1/);
assert.match(server, /generate_series\(\$1::date, \$2::date/);

const formatSource = app.slice(app.indexOf('const fmtT ='), app.indexOf('const todayStr ='));
const formats = vm.runInNewContext(`const TZ = 'Asia/Ho_Chi_Minh'; ${formatSource} ({fmtD, playTimeText, bookingTimeText})`, { Date, Intl });
const b = { starts_at: '2026-09-30T01:00:00Z', ends_at: '2026-09-30T02:30:00Z', confirmed_at: '2026-09-29T18:04:08Z' };
assert.match(formats.fmtD(b.starts_at), /^30\/09\/26 · Thứ Tư$/i);
assert.equal(formats.playTimeText(b), '30/09/26 • 08:00 - 09:30 (1 giờ 30 phút)');
assert.equal(formats.bookingTimeText(b), '01:04');

const nodes = new Map();
const $ = s => { if (!nodes.has(s)) nodes.set(s, { hidden: false, innerHTML: '', textContent: '', disabled: false,
  setAttribute() {}, removeAttribute() {}, scrollTo() {} }); return nodes.get(s); };
const state = { bk: { dateChosen: false, courtId: null, selected: [] }, user: { id: 5, role: 'user' }, token: 'test' };
const stageSource = app.slice(app.indexOf('function renderBookingStages()'), app.indexOf('function renderBkCourts()')) +
  app.slice(app.indexOf('function renderAssignStages()'), app.indexOf('function renderAsCourts()'));
const stage = vm.createContext({ $, state, asState: { dateChosen: false, courtId: null, selected: [] }, renderSelectionBar() {} });
vm.runInContext(stageSource, stage);
vm.runInContext('renderBookingStages(); renderAssignStages()', stage);
assert.equal($('#bkCourtStage').hidden, true);
assert.equal($('#asCourtStage').hidden, true);
stage.state.bk.courtId = 1;
vm.runInContext('renderBookingStages()', stage);
assert.equal($('#bkCourtStage').hidden, true);
assert.equal($('#bkTimeStage').hidden, true);
assert.equal($('#summary').hidden, true);
stage.state.bk.selected = [480];
vm.runInContext('renderBookingStages()', stage);
assert.equal($('#summary').hidden, false);
stage.state.user.role = 'admin';
vm.runInContext('asState.dateChosen=true; asState.courtId=2; asState.selected=[900]; renderAssignStages(); renderBookingStages()', stage);
assert.equal($('#asSummary').hidden, false);
assert.equal($('#summary').hidden, true);
stage.state.user.role = 'user';

const begin = app.indexOf('async function loadHistory(page = 1) {');
const end = app.indexOf("$('#historyMore').onclick", begin);
let requested = '';
const history = vm.createContext({ $, state, TZ: 'Asia/Ho_Chi_Minh', historyRequest: 0, historyPage: 1, historySearchTimer: null,
  URLSearchParams, Date, Intl, reduce: true, FormData: class { constructor() { throw new Error('user history must not read filters'); } },
  api: async q => { requested = q; return { limit: 20, summary: { total: 3, upcoming: 1, completed: 1, cancelled: 1, revenue: 80000 }, rows: [
    { id: 1, user_id: 5, player_name: 'Lan', player_phone: '0912345678', starts_at: b.starts_at, ends_at: b.ends_at,
      court_name: 'Court 01', status: 'confirmed', payment_method: 'transfer', paid: false, total_price: 80000, invoice_total: 80000 },
    { id: 2, user_id: 5, player_name: 'Lan', player_phone: '0912345678', starts_at: b.starts_at, ends_at: b.ends_at,
      court_name: 'Court 02', status: 'cancelled', confirmed_at: b.confirmed_at, paid: true, total_price: 80000, invoice_total: 80000 },
    { id: 3, user_id: 5, player_name: 'Lan', player_phone: '0912345678', starts_at: new Date(Date.now() + 86400000).toISOString(), ends_at: new Date(Date.now() + 90000000).toISOString(),
      court_name: 'Court 03', status: 'confirmed', paid: false, total_price: 80000, invoice_total: 80000 },
  ] }; },
  money: n => `${n}đ`, esc: String,
  paidTag: r => r.paid ? '<span class="paid-tag">Đã thanh toán</span>' : '',
  paymentTag: r => r.paid ? '<span class="paid-tag">Đã thanh toán</span>' : r.payment_method === 'transfer' && r.status === 'confirmed'
    ? '<span class="awaiting-tag">Chờ xác nhận</span>' : '<span class="unpaid-tag">Chưa thanh toán</span>',
  bookingDateLabel: () => '<b>30/09/26 · Thứ Tư</b>', playTimeText: formats.playTimeText,
  fmtT: () => '08:00', fmtD: () => '30/09/26 · Thứ Tư', durationText: () => '1 giờ',
});
$('#historyDlg').open = true;
vm.runInContext(app.slice(begin, end), history);
(async () => {
  await vm.runInContext('loadHistory(1)', history);
  assert.equal(requested, '/bookings/history?page=1&limit=20');
  assert.match($('#historyResults').innerHTML, /Chưa thanh toán/);
  assert.match($('#historyResults').innerHTML, /<div class="booking-row-price"><strong>80000đ<\/strong><span class="awaiting-tag">Chờ xác nhận<\/span><\/div>/,
    'toàn bộ booking cũng đặt trạng thái chuyển khoản bên dưới số tiền');
  assert.match($('#historyResults').innerHTML, /Đã thanh toán/);
  assert.match($('#historyResults').innerHTML, /Đã hủy/);
  assert.match($('#historyResults').innerHTML, /Court 03/, 'toàn bộ booking gồm cả lịch tương lai');
  assert.doesNotMatch($('#historyResults').innerHTML, /class="history-order"|class="history-person"/, 'người chơi không thấy mã và tên trong danh sách');
  assert.doesNotMatch($('#historyResults').innerHTML, /booking-created-at|>Hoàn thành</);
  console.log('Workflow UI: progressive steps, scoped history, payment tags, time display and profile settings OK');
})().catch(err => { console.error(err); process.exitCode = 1; });
