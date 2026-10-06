// Lịch 30 ngày: không rò thông tin khách trong API công khai, đổi tháng vẫn chọn đúng ngày.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');

const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const addDays = (day, count) => {
  const value = new Date(`${day}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
};
const routes = new Map(), queries = [];
const scheduleServer = vm.createContext({
  app: { get(url, ...handlers) { routes.set(url, handlers.at(-1)); } },
  auth() {}, admin() {}, ah: handler => handler, Date,
  vnDay: () => today,
  pool: { async query(sql, params = []) {
    queries.push({ sql, params });
    return { rows: /FROM courts/.test(sql) ? [{ id: 1, name: 'Sân 1', open_time: '06:00', close_time: '23:00' }]
      : [{ court_id: 1, starts_at: '2026-10-01T01:00:00Z', ends_at: '2026-10-01T02:00:00Z', status: 'confirmed', is_fixed: true }] };
  } },
});
const start = server.indexOf('const bookingWindow =');
const end = server.indexOf('const toMin =', start);
vm.runInContext(server.slice(start, end), scheduleServer);
const scheduleStart = server.indexOf('// Lịch công khai chỉ có');
const scheduleEnd = server.indexOf('// Nguồn dữ liệu là chính booking', scheduleStart);
vm.runInContext(server.slice(scheduleStart, scheduleEnd), scheduleServer);
const response = () => ({ code: 200, status(value) { this.code = value; return this; }, json(value) { this.data = value; return this; } });

const nodes = new Map();
const $ = selector => {
  if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', textContent: '', hidden: false, disabled: false,
    classList: { open: false, toggle(_name, value) { this.open = value; }, contains() { return this.open; } },
    attrs: {}, setAttribute(name, value) { this.attrs[name] = value; },
    focus() {},
    addEventListener(event, fn) { this[event] = fn; } });
  return nodes.get(selector);
};
const ui = vm.createContext({
  $, Date, Intl, todayStr: () => today, addDays, document: { addEventListener() {} },
  fmtD: day => day.slice(8, 10) + '/' + day.slice(5, 7) + '/' + day.slice(2, 4),
  state: { bk: { date: today, dateChosen: true, selected: [], courtId: null }, user: { role: 'user' } },
  asState: { date: today, dateChosen: true, selected: [], courtId: null },
  releaseHold() {}, renderBkCourts() {}, renderBookingStages() {}, renderDurationTotal() {}, renderSummary() {},
  renderAsDates() {}, renderAsCourts() {}, renderAssignStages() {}, renderAsSummary() {},
  loadAdminSchedule: async () => {}, toast() {},
});
vm.runInContext(appJs.slice(appJs.indexOf('let calendarMonth ='), appJs.indexOf('function renderBookingStages()')), ui);

(async () => {
  const handler = routes.get('/api/schedule');
  assert.ok(handler, 'có lịch sân công khai');
  let res = response();
  await handler({ query: { date: addDays(today, 29) } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.data.bookings[0].is_fixed, true);
  assert.equal(Object.hasOwn(res.data.bookings[0], 'player_name'), false);
  const publicQuery = queries.find(({ sql }) => /FROM bookings WHERE status IN/.test(sql)).sql;
  assert.doesNotMatch(publicQuery, /player_name|player_phone|user_id|user_email|SELECT id\b/i);
  assert.match(publicQuery, /Asia\/Ho_Chi_Minh/);
  res = response();
  await handler({ query: { date: addDays(today, 30) } }, res);
  assert.equal(res.code, 400);
  assert.match(server, /ORDER BY COALESCE\(b.confirmed_at, b.created_at\) DESC, b.id DESC LIMIT/);

  vm.runInContext('renderDates()', ui);
  assert.match($('#dates').innerHTML, /class="calendar-day/);
  assert.match($('#selectedDateText').textContent, /\d\d\/\d\d\/\d\d/);
  $('#calendarToggle').click();
  assert.equal($('#calendarToggle').attrs['aria-expanded'], 'true');
  assert.equal($('#calendarPanel').inert, false);
  const endMonth = addDays(today, 29).slice(0, 7);
  while (vm.runInContext('calendarMonth', ui) !== endMonth) $('#calNext').click();
  assert.match($('#dates').innerHTML, new RegExp(`data-d="${addDays(today, 29)}"`));
  const dayButton = { dataset: { d: addDays(today, 29) }, disabled: false };
  $('#dates').click({ target: { closest: () => dayButton } });
  assert.equal($('#calendarToggle').attrs['aria-expanded'], 'false');
  assert.equal($('#calendarPanel').inert, true);
  assert.equal(ui.state.bk.date, dayButton.dataset.d);
  assert.equal(ui.asState.date, dayButton.dataset.d);
  assert.equal(ui.asState.dateChosen, true);
  assert.match(html, /id="scheduleViewport"[^>]*role="region"/);
  assert.match(css, /#courtList\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css, /\.court-slot\.fixed\{background:/);
  console.log('Month schedule: 30-day boundary, public privacy, fixed tag and shared date selection OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
