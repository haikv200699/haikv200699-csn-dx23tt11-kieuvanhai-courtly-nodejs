const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const begin = source.indexOf('// ---- trang quản lý tài khoản người chơi');
const end = source.indexOf('// ---------- realtime ----------', begin);
assert.ok(begin > 0 && end > begin);
const nodes = new Map(), calls = [], messages = [];
const node = id => {
  if (!nodes.has(id)) nodes.set(id, { hidden: false, open: false, value: '', innerHTML: '', textContent: '',
    listeners: {}, elements: { id: { value: '' }, fullName: { value: '', focus() {} }, email: { value: '' }, phone: { value: '' }, memberType: { value: '', addEventListener(type, cb) { this[type] = cb; } } },
    addEventListener(type, cb) { this.listeners[type] = cb; },
    setAttribute() {}, removeAttribute() {}, reset() {}, focus() {}, scrollIntoView() {},
    showModal() { this.open = true; }, close() { this.open = false; },
    querySelector: () => ({ disabled: false }),
  });
  return nodes.get(id);
};
const members = [{ id: 7, role: 'user', full_name: 'Nguyễn Lan', email: 'lan@example.com', phone: '0912345678',
  avatar_key: 'animal-2', member_type: 'casual', completed_count: 12, recent_count: 5, recent_30_count: 4,
  active_months_last_3: 3, booking_rank: 1 }];
const schedules = [];
const tabs = ['fixed','casual','staff'].map(view => ({ dataset: { accView: view }, listeners: {},
  classList: { toggle() {} }, setAttribute() {}, addEventListener(type, cb) { this.listeners[type] = cb; }, click() { this.listeners.click(); } }));
const context = vm.createContext({
  $: node, state: { user: { role: 'admin' }, token: 'token', courts: [{ id: 2, name: 'Court 02', price_per_hour: 80000 }] },
  document: {
    querySelectorAll: () => tabs,
    querySelector: selector => tabs.find(tab => selector.includes(tab.dataset.accView)),
  }, URLSearchParams, FormData, clearTimeout, setTimeout,
  avatarUrl: u => '/avatars/' + u.avatarKey + '.svg', esc: String, money: n => `${n}đ`, durationText: () => '1 giờ', reduce: true,
  loadMine() {}, loadAdminSchedule() {}, confirm: () => true,
  toast: msg => messages.push(msg),
  api: async (route, options) => {
    calls.push([route, options]);
    if (route.startsWith('/admin/accounts?')) {
      const view = new URLSearchParams(route.split('?')[1]).get('view');
      const rows = members.filter(u => u.member_type === view);
      return { rows, total: rows.length, limit: 20, page: 1,
        summary: { fixed: members.filter(u => u.member_type === 'fixed').length,
          casual: members.filter(u => u.member_type === 'casual').length, staff: 0 } };
    }
    if (route === '/admin/accounts/7') {
      Object.assign(members[0], { full_name: options.body.fullName, email: options.body.email,
        phone: options.body.phone, member_type: options.body.memberType }); return { ...members[0] };
    }
    if (route === '/admin/accounts/7/schedule' && !options) return schedules;
    if (route === '/admin/accounts/7/schedule' && options.method === 'POST') {
      schedules.push({ id: 10, user_id: 7, court_id: 2, court_name: 'Court 02', weekday: options.body.weekday,
        start_min: 480, end_min: 540 }); return { created: 4 };
    }
    if (route === '/admin/accounts/7/schedule/10' && options.method === 'PATCH') {
      schedules[0] = { ...schedules[0], weekday: options.body.weekday, start_min: 540, end_min: 600 };
      return { created: 0 };
    }
    throw new Error('unexpected ' + route);
  },
});
vm.runInContext(source.slice(begin, end), context);

(async () => {
  node('#accountsDlg').open = true;
  vm.runInContext('setAccCreateOpen(false)', context);
  assert.equal(node('#accCreatePanel').hidden, true);
  node('#accCreateToggle').onclick();
  assert.equal(node('#accCreatePanel').hidden, false);
  node('#accCreateClose').onclick();
  assert.equal(node('#accCreatePanel').hidden, true);
  await vm.runInContext('loadAccounts(1)', context);
  assert.match(node('#accList').innerHTML, /Nguyễn Lan/);
  assert.match(node('#accList').innerHTML, /4 booking\/30 ngày/);
  assert.match(node('#accList').innerHTML, /data-account-id="7"/);
  assert.doesNotMatch(node('#accList').innerHTML, /Chỉnh sửa/);
  assert.doesNotMatch(source, /accLeaderboard|accStats/, 'không render các phần thống kê đã bỏ');
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'), /accLeaderboard|accStats|leadersTitle/);
  assert.equal(node('#accCasualCount').textContent, 1);
  node('#accList').listeners.click({ target: { closest: selector => selector === '[data-account-id]' ? { dataset: { accountId: '7' } } : null } });
  assert.equal(node('#accEditDlg').open, true);
  assert.equal(node('#accEditForm').elements.memberType.value, 'casual');
  node('#accEditForm').elements.memberType.value = 'fixed';
  node('#accEditForm').elements.memberType.change();
  assert.equal(node('#accSchedulePending').hidden, false);
  node('#accEditForm').elements.fullName.value = 'Nguyễn Lan mới';
  await node('#accEditForm').listeners.submit({ preventDefault() {}, target: node('#accEditForm') });
  await vm.runInContext('loadAccounts(1)', context);
  assert.equal(members[0].member_type, 'fixed');
  assert.equal(members[0].full_name, 'Nguyễn Lan mới');
  assert.equal(node('#accEditDlg').open, true, 'lịch được chỉnh sửa ngay trong hộp thông tin');
  assert.equal(node('#fixedSchedulePanel').hidden, false);
  assert.equal(node('#accSchedulePending').hidden, true);
  assert.equal(node('#accCasualCount').textContent, 0);
  assert.match(messages[0], /cập nhật/);
  assert.match(node('#accList').innerHTML, /Cố định · giá ưu đãi/);
  node('#fixedScheduleCourt').value = '2'; node('#fixedScheduleWeekday').value = '1';
  node('#fixedScheduleStart').value = '08:00'; node('#fixedScheduleEnd').value = '09:00';
  await node('#fixedScheduleForm').listeners.submit({ preventDefault() {}, target: node('#fixedScheduleForm') });
  await vm.runInContext('loadFixedSchedule()', context);
  assert.match(node('#fixedScheduleRules').innerHTML, /data-schedule-edit="10"/);
  node('#fixedScheduleRules').listeners.click({ target: { closest: selector => selector === '[data-schedule-edit]' ? { dataset: { scheduleEdit: '10' } } : null } });
  assert.equal(node('#fixedScheduleSubmit').textContent, 'Lưu lịch');
  node('#fixedScheduleStart').value = '09:00'; node('#fixedScheduleEnd').value = '10:00';
  await node('#fixedScheduleForm').listeners.submit({ preventDefault() {}, target: node('#fixedScheduleForm') });
  assert.ok(calls.some(([route, options]) => route === '/admin/accounts/7/schedule/10' && options.method === 'PATCH'));
  assert.equal(node('#accEditDlg').open, true);
  assert.ok(calls.some(([route, options]) => route === '/admin/accounts/7' && options.method === 'PATCH'));
  console.log('Account page: clickable row, in-dialog account and fixed-schedule editing, 30-day activity OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
