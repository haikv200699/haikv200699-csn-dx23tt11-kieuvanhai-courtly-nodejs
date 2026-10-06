// Kiểm tra chọn ảnh, lưu tài khoản lần đầu, thay QR và xem lại ảnh trên UI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const begin = source.indexOf('async function loadPaymentSettings() {');
const end = source.indexOf('// ---- báo cáo doanh thu', begin);
const elements = new Map(), calls = [], revoked = [];
const file = () => ({ name: 'qr.png', type: 'image/png', size: 1000 });
const $ = id => {
  if (!elements.has(id)) elements.set(id, {
    hidden: false, disabled: false, textContent: '', value: '', files: [],
    removeAttribute(attr) { if (attr === 'src') this.src = ''; },
    addEventListener(type, callback) { this[type] = callback; },
    querySelector() { return { disabled: false }; }, reportValidity() { return true; },
    elements: { bankBin: { value: '' }, bankName: { value: '' }, accountNo: { value: '' }, accountName: { value: '' } },
  });
  return elements.get(id);
};
let settings = null, currentQr = null, counter = 0;
const context = vm.createContext({
  $, paymentEditToken: 'edit-proof', state: { token: 'token', user: { role: 'admin' } }, URL: { revokeObjectURL: id => revoked.push(id) },
  FormData: class { constructor() { return [['bankBin', '970415'], ['bankName', 'Test'], ['accountNo', '123456789'], ['accountName', 'CHU SAN']]; } },
  async api(route, options) {
    calls.push([route, options]);
    if (route === '/admin/payment-settings' && !options) return settings;
    if (route === '/admin/payment-settings' && options.method === 'PUT') {
      settings = { bank_bin: '970415', bank_name: 'Test', account_no: '123456789', account_name: 'CHU SAN', has_qr: !!currentQr };
      return settings;
    }
    if (route === '/admin/payment-settings/qr' && options.method === 'DELETE') {
      currentQr = null; settings.has_qr = false; return { ok: true };
    }
    throw new Error('unexpected request');
  },
  async fetch(route, options) {
    calls.push([route, options]);
    assert.equal(options.method, 'PUT');
    assert.equal(options.headers.Authorization, 'Bearer token');
    assert.equal(options.headers['X-Payment-Edit-Token'], 'edit-proof');
    currentQr = options.body; settings.has_qr = true;
    return { ok: true };
  },
  async authenticatedImage() { return `blob:qr-${++counter}`; },
  confirm: () => true, toast() {},
});
vm.runInContext(source.slice(begin, end), context);
(async () => {
  await vm.runInContext('loadPaymentSettings()', context);
  assert.equal($('#paymentQrUpload').disabled, true);
  $('#paymentQrFile').files = [file()];
  $('#paymentQrFile').onchange();
  assert.equal($('#paymentQrUpload').disabled, false, 'chọn file có thể tải ngay cả khi chưa lưu tài khoản');
  await $('#paymentQrUpload').onclick();
  assert.equal(calls[1][0], '/admin/payment-settings');
  assert.equal(calls[1][1].headers['X-Payment-Edit-Token'], 'edit-proof');
  assert.equal(calls[2][0], '/api/admin/payment-settings/qr');
  assert.equal($('#paymentQrRemove').hidden, false);
  assert.equal($('#paymentQrPreview').src, 'blob:qr-1');
  assert.equal($('#paymentQrUpload').textContent, 'Thay ảnh QR');
  $('#paymentQrFile').files = [file()];
  $('#paymentQrFile').onchange();
  await $('#paymentQrUpload').onclick();
  assert.equal($('#paymentQrPreview').src, 'blob:qr-2', 'ảnh đang dùng được thay bởi ảnh mới');
  assert.ok(revoked.includes('blob:qr-1'), 'blob ảnh cũ được giải phóng');
  assert.equal($('#paymentQrStatus').hidden, false);
  console.log('QR upload UI: first account setup, image upload and replacement OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
