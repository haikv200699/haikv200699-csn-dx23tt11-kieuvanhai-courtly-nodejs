const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
assert.match(html, /id="paymentEditor" hidden/);
assert.match(html, /id="courtForm" hidden/);
assert.match(html, /id="courtAddToggle"[^>]*aria-expanded="false"/);
assert.doesNotMatch(html, /<h4>Lịch sân theo ngày<\/h4>/);
assert.match(app, /\$\('#booking'\)\.hidden = \$\('#nav-booking'\)\.hidden = false/);
assert.match(html, /id="scheduleViewport"[^>]*role="region"/);
assert.match(app, /manager \? '\/admin\/schedule' : '\/schedule'/);
assert.ok(html.indexOf('id="paymentSettingsSection"') > html.indexOf('id="profileDlg"'), 'tài khoản nhận tiền thuộc hồ sơ');
assert.match(css, /#courtList\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);

const events = new Map(), elements = new Map(), calls = [];
const $ = id => {
  if (!elements.has(id)) elements.set(id, {
    hidden: id === '#paymentEditor', disabled: false, value: '', files: [], textContent: '', open: false,
    elements: { bankBin: { value: '' }, bankName: { value: '' }, accountNo: { value: '' }, accountName: { value: '' } },
    addEventListener(type, cb) { events.set(`${id}:${type}`, cb); },
    setAttribute(name, value) { this[name] = value; },
    showModal() { this.open = true; }, close() { this.open = false; }, focus() {},
    removeAttribute() {}, querySelector() { return { disabled: false }; },
  });
  return elements.get(id);
};
const context = vm.createContext({
  $, state: { token: 'session', user: { id: 1, role: 'admin', email: 'admin@courtly.vn' } },
  paymentEditToken: '', URL: { revokeObjectURL() {} },
  FormData: class { constructor() { return [['bankBin', '970415'], ['bankName', 'Test'], ['accountNo', '123456789'], ['accountName', 'CHU SAN']]; } },
  api: async (route, opt) => {
    calls.push([route, opt]);
    if (route.endsWith('/unlock')) {
      if (opt.body.password !== 'correct') throw new Error('Mật khẩu quản trị không đúng');
      return { editToken: 'proof' };
    }
    if (route === '/admin/payment-settings' && !opt) return null;
    if (route === '/admin/payment-settings' && opt.method === 'PUT') {
      assert.equal(opt.headers['X-Payment-Edit-Token'], 'proof'); return {};
    }
    throw new Error(route);
  },
  toast() {},
});
vm.runInContext(app.slice(app.indexOf('async function loadPaymentSettings() {'), app.indexOf('// ---- báo cáo doanh thu')), context);
vm.runInContext(app.slice(app.indexOf('function setCourtAddOpen(open) {'), app.indexOf("$('#courtForm').addEventListener('submit'")), context);

(async () => {
  $('#courtForm').hidden = true;
  $('#courtAddToggle').onclick();
  assert.equal($('#courtForm').hidden, false);
  assert.equal($('#courtAddToggle')['aria-expanded'], 'true');
  $('#courtAddClose').onclick();
  assert.equal($('#courtForm').hidden, true);
  $('#paymentEditBtn').onclick();
  assert.equal($('#paymentUnlockDlg').open, true);
  assert.equal($('#paymentEditor').hidden, true);
  $('#paymentUnlockPassword').value = 'wrong';
  await events.get('#paymentUnlockForm:submit')({ preventDefault() {} });
  assert.equal($('#paymentEditor').hidden, true, 'mật khẩu sai không mở form');
  assert.match($('#paymentUnlockErr').textContent, /không đúng/);
  $('#paymentUnlockPassword').value = 'correct';
  await events.get('#paymentUnlockForm:submit')({ preventDefault() {} });
  assert.equal($('#paymentUnlockDlg').open, false);
  assert.equal($('#paymentEditor').hidden, false);
  await events.get('#paymentSettingsForm:submit')({ preventDefault() {}, target: { querySelector: () => ({ disabled: false }) } });
  assert.equal(calls.at(-2)[0], '/admin/payment-settings');
  $('#paymentEditorClose').onclick();
  assert.equal($('#paymentEditor').hidden, true);
  assert.equal(vm.runInContext('paymentEditToken', context), '');
  console.log('Admin account editor: password gate, short-lived proof, collapsed layout and court grid OK');
})().catch(err => { console.error(err); process.exitCode = 1; });
