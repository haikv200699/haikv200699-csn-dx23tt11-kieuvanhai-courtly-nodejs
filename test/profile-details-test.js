const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');

async function profileFlow() {
  const elements = new Map();
  const el = key => {
    if (!elements.has(key)) elements.set(key, {
      value: '', textContent: '', hidden: false, focus() { this.focused = true; }, setAttribute() {},
      showModal() { this.open = true; }, close() { this.open = false; },
      addEventListener(_type, handler) { this.submitHandler = handler; },
    });
    return elements.get(key);
  };
  const state = { user: { id: 5, fullName: 'Tên cũ', phone: '0912345678', email: 'an@example.com', role: 'user', avatarKey: 'animal-4' } };
  const calls = [];
  const from = app.indexOf('const avatarUrl =');
  const to = app.indexOf("$('#authForm').addEventListener", from);
  const context = {
    $, state, api: async (url, options) => {
      calls.push({ url, options });
      return { ...state.user, fullName: options.body.fullName, phone: options.body.phone };
    },
    afterAuth() {}, toast() {}, logout() {}, closeProfileNavMenu() {}, isCompactNav: () => false,
  };
  function $(key) { return el(key); }
  vm.runInNewContext(app.slice(from, to), context);
  el('#profileQuickMenu').hidden = true;
  el('#profileBtn').onclick();
  assert.equal(el('#profileQuickMenu').hidden, false);
  el('#profileDesktopAccount').onclick();
  assert.equal(el('#profileTitle').textContent, 'Tên cũ');
  assert.equal(el('#profileOverview').hidden, false);
  assert.equal(el('#profileForm').hidden, true, 'mở hồ sơ chỉ hiển thị thông tin');
  el('#profileEdit').onclick();
  assert.equal(el('#profileForm').hidden, false);
  assert.equal(el('#profileOverview').hidden, true);
  assert.equal(el('#profileName').value, 'Tên cũ');
  el('#profileName').value = 'Tên mới';
  el('#profileCancelEdit').onclick();
  assert.equal(el('#profileForm').hidden, true, 'hủy sửa không lưu thông tin chưa xác nhận');
  assert.equal(calls.length, 0);
  el('#profileEdit').onclick();
  assert.equal(el('#profileName').value, 'Tên cũ', 'mở lại form từ dữ liệu đã lưu');
  el('#profileName').value = 'Tên mới';
  await el('#profileForm').submitHandler({ preventDefault() {} });
  assert.equal(calls[0].url, '/me');
  assert.equal(calls[0].options.method, 'PATCH');
  assert.equal(el('#profileTitle').textContent, 'Tên mới');
  assert.equal(el('#profileForm').hidden, true);
  assert.equal(el('#profileDlg').open, true, 'lưu xong quay về hồ sơ');
}

async function adminCancellation() {
  const elements = new Map(), requests = [];
  const el = key => {
    if (!elements.has(key)) elements.set(key, {
      hidden: false, textContent: '', disabled: false,
      close() { this.closed = true; },
    });
    return elements.get(key);
  };
  const from = app.indexOf("$('#extrasCancel').onclick = async () => {");
  const to = app.indexOf("$('#extrasPreset').onchange", from);
  let refreshed = 0;
  const context = {
    can: key => require('../public/permissions').can(context.state.user,key),
    $: el, state: { user: { role: 'admin' } }, extrasBookingId: '42',
    extrasBill: { booking: { status: 'confirmed' } },
    confirmBookingCancellation: async () => true, api: async (url, options) => { requests.push({ url, options }); },
    toast() {}, refreshBookingViews() { refreshed++; },
  };
  vm.runInNewContext(app.slice(from, to), context);
  await el('#extrasCancel').onclick();
  assert.equal(requests[0].url, '/bookings/42/cancel');
  assert.equal(requests[0].options.method, 'PATCH');
  assert.equal(el('#bookingExtrasDlg').closed, true);
  assert.equal(refreshed, 1);
  context.state.user.role = 'staff';
  await el('#extrasCancel').onclick();
  assert.equal(requests.length, 2, 'ca trưởng có quyền hủy booking chưa thu tiền');
  context.state.user.permissions={cancelUnpaid:false};
  await el('#extrasCancel').onclick();
  assert.equal(requests.length,2,'tắt quyền hủy thì không gửi yêu cầu');
  assert.match(app, /\$\('#extrasCancel'\)\.hidden = !can\('cancelUnpaid'\) \|\| \(state\.user\?\.role==='staff' && anyPaid\)/);
  assert.doesNotMatch(app.slice(app.indexOf('const bookingCard ='), app.indexOf("$('#upcoming').addEventListener")), /data-cancel=/);
  assert.match(app, /data-open-upcoming="\$\{r\.id\}"/);
  assert.doesNotMatch(app, /data-manage="\$\{r\.id\}">Chi tiết<\/button>/);
  assert.match(html, /id="extrasCancel"[^>]+hidden/);
  assert.match(css, /\.extras-cancel\[hidden\]\{display:none\}/);
}

async function fullPaymentButton() {
  const button = { disabled: false }, error = { textContent: '' };
  const bill = { booking: { status: 'confirmed' }, due: 30000 };
  const requests = [];
  let refreshed = 0, reloaded = 0;
  const from = app.indexOf("$('#extrasSettle').onclick = async () => {");
  const to = app.indexOf("$('#extrasCancel').onclick", from);
  assert.ok(from >= 0 && to > from);
  const ctx = {
    canCollect:()=>true,
    $: id => id === '#extrasSettle' ? button : error,
    state: { user: { role: 'admin' } }, extrasBill: bill, extrasBookingId: '42',
    api: async (url, options) => { requests.push([url, options]); bill.due = 0; },
    reloadBookingExtras: async () => { reloaded++; },
    refreshBookingViews: () => { refreshed++; }, toast() {},
  };
  vm.runInNewContext(app.slice(from, to), ctx);
  await button.onclick();
  assert.equal(requests[0][0], '/admin/bookings/42/settle');
  assert.equal(requests[0][1].method, 'POST');
  assert.equal(button.disabled, true, 'đã thu đủ thì không thể bấm lần nữa');
  assert.equal(reloaded, 1);
  assert.equal(refreshed, 1);
  assert.match(html, /id="extrasPrint"[^>]*>Xuất hóa đơn \/ Lưu PDF<\/button><button[^>]*id="extrasSettle"/);
  assert.match(css, /\.extras-cancel\{[^}]*width:auto;/);
}

Promise.all([profileFlow(), adminCancellation(), fullPaymentButton()]).then(() => {
  console.log('Profile, admin cancellation, and full payment button inside booking details OK');
}).catch(error => { console.error(error); process.exitCode = 1; });
