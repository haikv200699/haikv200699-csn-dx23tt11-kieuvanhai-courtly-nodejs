// Cùng một lưới chọn ca cho người chơi và admin; chọn thêm ca liền nhau không qua popup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
const day = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
const courts = [{ id: 1, name: 'Sân 1', price_per_hour: 80000, open_time: '06:00', close_time: '23:00' }];
const state = { user: { role: 'user' }, courts, bk: { date: day, dateChosen: true, courtId: null, selected: [], booked: [] } };
const asState = { date: day, dateChosen: true, courtId: null, selected: [], booked: [] };
const nodes = new Map(), calls = { holds: 0, adminLoads: 0, sheets: 0 };
const $ = key => {
  if (!nodes.has(key)) nodes.set(key, { hidden: true, textContent: '', addEventListener(type, fn) { this[type] = fn; } });
  return nodes.get(key);
};
const range = selected => selected.length ? { start: Math.min(...selected), end: Math.max(...selected) + 30, dur: selected.length * 30 } : null;
const ctx = vm.createContext({
  can: key => require('../public/permissions').can(state.user,key),
  $, state, asState, Date, Math,
  admScheduleData: { date: day, courts, bookings: [] },
  selectedRange: () => range(state.bk.selected), asSelectedRange: () => range(asState.selected),
  durationText: value => `${value} phút`, fmtMin: value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${value % 60 ? '30' : '00'}`,
  scheduleBookingAt: (bookings, s, e) => bookings.find(b => s < +new Date(b.ends_at) && e > +new Date(b.starts_at)),
  toDate: (date, min) => new Date(`${date}T${String(Math.floor(min / 60)).padStart(2, '0')}:${min % 60 ? '30' : '00'}:00+07:00`),
  loadAsBooked: async () => { asState.booked = []; calls.adminLoads++; },
  selectCourt: async id => { state.bk.courtId = id; state.bk.selected = []; state.bk.booked = []; },
  renderAssignStages() { vm.runInContext('renderSelectionBar()', ctx); }, renderAsSummary() {}, renderSlots() {},
  renderBookingStages() { vm.runInContext('renderSelectionBar()', ctx); }, renderSummary() {},
  renderCourtSchedule() {}, scheduleHold: () => { calls.holds++; }, loadAdminSchedule: async () => {},
  scheduleSheet: { open() { calls.sheets++; } },
  toast() {}, openAuth() {}, goto() {},
});
vm.runInContext(app.slice(app.indexOf('function renderSelectionBar()'), app.indexOf('function renderCourtSchedule(')), ctx);
vm.runInContext(app.slice(app.indexOf('async function openScheduleCell('), app.indexOf('// Trên màn hình chạm, giữ cuộn gốc', app.indexOf('async function openScheduleCell('))), ctx);

(async () => {
  await vm.runInContext('openScheduleCell(1, 480)', ctx);
  assert.deepEqual(Array.from(state.bk.selected), [480]);
  assert.equal(calls.holds, 1);
  assert.equal($('#selectionBar').hidden, false);
  await vm.runInContext('openScheduleCell(1, 510)', ctx);
  assert.deepEqual(Array.from(state.bk.selected), [480, 510]);
  await vm.runInContext('openScheduleCell(1, 480)', ctx);
  assert.deepEqual(Array.from(state.bk.selected), [510]);
  assert.equal(calls.sheets, 0, 'ca trống chọn trực tiếp, không mở popup');

  state.user.role = 'admin';
  await vm.runInContext('openScheduleCell(1, 540)', ctx);
  await vm.runInContext('openScheduleCell(1, 570)', ctx);
  assert.deepEqual(Array.from(asState.selected), [540, 570]);
  assert.equal(calls.adminLoads, 1);
  assert.equal(calls.holds, 3, 'admin không tạo lượt giữ chỗ của khách');
  assert.match($('#selectionText').textContent, /Sân 1/);

  assert.match(html, /id="calendarToggle"[^>]*aria-expanded="false"/);
  assert.match(html, /id="calendarPanel" inert aria-hidden="true"/);
  assert.ok(html.indexOf('id="scheduleViewport"') < html.indexOf('id="selectionBar"'), 'chọn ca không đẩy lưới xuống; nút tiếp tục nằm sau lịch');
  assert.match(css, /\.schedule-section \.selection-bar\{position:sticky;bottom:12px/);
  assert.match(css, /\.calendar-disclosure\.is-open\{grid-template-rows:1fr/);
  assert.match(css, /\.court-slot\.selected\{background:var\(--lime\)/);
  assert.match(app, /\$\('#assign'\)\.hidden = \$\('#nav-assign'\)\.hidden = true/);
  console.log('Unified schedule: direct multi-slot selection, role-specific confirmation and calendar motion OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
