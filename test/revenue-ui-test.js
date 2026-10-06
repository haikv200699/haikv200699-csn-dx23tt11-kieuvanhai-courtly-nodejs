const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
assert.match(html, /id="revCalendar" class="rev-calendar" hidden/);
assert.match(html, /id="authIdentifier"[^>]*type="text"/);
assert.match(html, /id="accEditMemberRow"/);
assert.doesNotMatch(html, /class="schedule-live"/);
assert.match(css, /body\.signed-in \.nav-section-links\{width:max-content/);
assert.match(css, /\.rev-calendar\[hidden\]\{display:none\}/);

const begin = app.indexOf('// ---- báo cáo doanh thu theo khoảng ngày ----');
const end = app.indexOf('// ---- quản lý sân:', begin);
assert.ok(begin > 0 && end > begin);
const nodes = new Map(), presets = [7, 30, 90].map(n => ({ dataset: { revPreset: n }, addEventListener(_type, listener) { this.listener = listener; } }));
const node = selector => {
  if (!nodes.has(selector)) nodes.set(selector, { hidden: selector === '#revCalendar', disabled: false, textContent: '', innerHTML: '', style: {},
    listeners: {}, addEventListener(type, cb) { this.listeners[type] = cb; }, setAttribute() {},
    click() { return this.onclick(); } });
  return nodes.get(selector);
};
const addDays = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const requests = [];
const context = vm.createContext({
  can: () => true, state:{user:{role:'admin'}},
  $: node, document: { querySelectorAll: () => presets, addEventListener() {} }, URLSearchParams, Date, Intl,
  todayStr: () => '2026-10-01', addDays, money: n => n + 'đ',
  shiftMonth: (key, delta) => { const d = new Date(key + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + delta); return d.toISOString().slice(0, 7); },
  api: async route => {
    requests.push(route);
    const params = new URLSearchParams(route.split('?')[1]);
    const rows = [];
    for (let day = params.get('from'); day <= params.get('to'); day = addDays(day, 1))
      rows.push({ date: day, label: day, bookings: 1, revenue: 1000 });
    return { rows, total: rows.length * 1000 };
  },
});
vm.runInContext(app.slice(begin, end), context);

(async () => {
  await vm.runInContext('loadRevenue()', context);
  assert.equal(new URLSearchParams(requests[0].split('?')[1]).get('from'), '2026-09-25');
  assert.match(node('#revRangeLabel').textContent, /25\/09\/26 – 01\/10\/26/);
  assert.equal((node('#revChart').innerHTML.match(/class="bar"/g) || []).length, 7);
  node('#revRangeToggle').onclick();
  assert.equal(node('#revCalendar').hidden, false);
  node('#revDays').listeners.click({ target: { disabled: false, dataset: { revDay: '2026-09-30' }, closest() { return this; } } });
  assert.equal(node('#revApply').disabled, true);
  node('#revDays').listeners.click({ target: { disabled: false, dataset: { revDay: '2026-10-01' }, closest() { return this; } } });
  assert.equal(node('#revApply').disabled, false);
  await node('#revApply').onclick();
  assert.equal(node('#revCalendar').hidden, true);
  assert.equal((node('#revChart').innerHTML.match(/class="bar"/g) || []).length, 2);
  await vm.runInContext('loadRevenue("2026-08-03", "2026-10-01")', context);
  assert.match(node('#revChartHint').textContent, /7 ngày/);
  assert.ok((node('#revChart').innerHTML.match(/class="bar"/g) || []).length <= 9);
  await vm.runInContext('loadRevenue("2026-06-01", "2026-10-01")', context);
  assert.match(node('#revChartHint').textContent, /tháng/);
  assert.equal((node('#revChart').innerHTML.match(/class="bar"/g) || []).length, 5);
  console.log('Revenue calendar: date range, apply, responsive markup, daily/weekly/monthly chart grouping OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
