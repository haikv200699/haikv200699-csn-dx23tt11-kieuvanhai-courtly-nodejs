const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const routes = new Map(), queries = [];
const app = {
  use() {}, get(url, ...handlers) { routes.set(`GET ${url}`, handlers.at(-1)); },
  post(url, ...handlers) { routes.set(`POST ${url}`, handlers.at(-1)); },
  patch(url, ...handlers) { routes.set(`PATCH ${url}`, handlers.at(-1)); },
  put(url, ...handlers) { routes.set(`PUT ${url}`, handlers.at(-1)); },
  delete(url, ...handlers) { routes.set(`DELETE ${url}`, handlers.at(-1)); },
};
const express = () => app;
express.raw = express.json = express.static = () => () => {};
const due = new Date(Date.now() - 60_000);
let settings = null, booking = {
  id: 31, user_id: 5, court_id: 2, status: 'confirmed', payment_method: 'transfer',
  total_price: 80000, paid: false, confirmed_at: due.toISOString(),
};
class Pool {
  async connect(){return {query:this.query.bind(this),release(){}};}
  async query(sql, params = []) {
    queries.push({ sql, params });
    if(sql.includes('SELECT * FROM users WHERE id=$1 FOR SHARE')) return {rows:[{id:params[0],role:'admin'}]};
    if (sql.includes('SELECT bank_bin, bank_name')) return { rows: settings ? [settings] : [] };
    if (sql.includes('SELECT role, password_hash FROM users')) return { rows: [{ role: 'admin', password_hash: 'hashed' }] };
    if (sql.includes('SELECT qr_image, qr_mime')) return { rows: settings?.qr_image ? [settings] : [] };
    if (sql.includes('UPDATE payment_settings SET qr_image=$1')) {
      if (!settings) return { rowCount: 0 };
      settings.qr_image = params[0]; settings.qr_mime = params[1]; settings.has_qr = true;
      return { rowCount: 1 };
    }
    if (sql.includes('UPDATE payment_settings SET qr_image=NULL')) {
      if (settings) { settings.qr_image = null; settings.qr_mime = null; settings.has_qr = false; }
      return { rowCount: settings ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO payment_settings')) {
      settings = { ...settings, bank_bin: params[0], bank_name: params[1], account_no: params[2], account_name: params[3] };
      return { rows: [settings] };
    }
    if (sql.includes("UPDATE bookings SET status = 'cancelled'") && sql.includes("payment_method = 'transfer'")) {
      if (booking.status === 'confirmed' && booking.payment_method === 'transfer' && !booking.paid &&
          Date.now() >= +new Date(booking.confirmed_at) + 600_000) {
        booking.status = 'cancelled';
        return { rows: [{ id: booking.id, court_id: booking.court_id }] };
      }
      return { rows: [] };
    }
    if (sql.includes('FROM booking_invoice_totals')) return {rows:[{due:booking.paid ? 0 : booking.total_price}]};
    if (sql.includes('FROM bookings WHERE id=$1')) return { rows: booking ? [booking] : [] };
    if (sql.includes('UPDATE bookings SET paid=$2')) {
      if (booking.status !== 'confirmed' || (booking.payment_method === 'transfer' && !booking.paid &&
          Date.now() >= +new Date(booking.confirmed_at) + 600_000)) return { rows: [] };
      booking.paid = params[1]; return { rows: [{ id: params[0], paid: booking.paid }] };
    }
    if (sql.includes("UPDATE bookings SET status = 'confirmed'")) return { rows: [booking] };
    if (sql.includes('SELECT name FROM courts')) return { rows: [{ name: 'Court 01' }] };
    if (sql.includes('FROM courts c JOIN court_live_status')) return { rows: [] };
    return { rows: [] };
  }
}
const source = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8').replace(/setup\(\)\s*\.then\([\s\S]*$/, '');
const frontend = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
vm.runInNewContext(source, {
  require(name) {
    if (name === 'express') return express;
    if (name === 'http') return { createServer: () => ({ on() {} }) };
    if (name === 'pg') return { Pool };
    if (name === 'socket.io') return { Server: class { on() {} emit() {} } };
    if (name === 'jsonwebtoken') return { sign: payload => JSON.stringify(payload), verify: token => {
      if (token === 'expired') throw new Error('expired');
      return JSON.parse(token);
    } };
    if (name === 'bcryptjs') return { compare: async (password, hash) => password === 'admin123' && hash === 'hashed' };
    return require(name);
  }, __dirname: path.join(__dirname, '../server'), process, console,
  setInterval() {}, setTimeout, Date, Intl, Buffer,
});
async function call(method, url, user = { id: 5, role: 'user' }, body = {}, headers = {}) {
  const res = { code: 200, headers: {}, status(n) { this.code = n; return this; },
    json(data) { this.data = data; return this; },
    set(k, v) { this.headers[k] = v; return this; }, type(mime) { this.mime = mime; return this; },
    send(data) { this.data = data; return this; } };
  const handler = routes.get(`${method} ${url}`);
  assert.ok(handler, url);
  await handler({ params: { id: '31' }, body, user, headers }, res, error => {res.status(error.status||500).json({error:error.message});});
  return res;
}
(async () => {
  const owner = { id: 1, role: 'admin' };
  let result = await call('POST', '/api/bookings/:id/confirm', undefined, {
    playerName: 'An', playerPhone: '0912345678', paymentMethod: 'transfer',
  });
  assert.equal(result.code, 409, 'chưa có tài khoản nhận tiền thì không xác nhận chuyển khoản');
  assert.ok(!queries.some(q => q.sql.includes("UPDATE bookings SET status = 'confirmed'")));

  const paymentData = { bankBin: '970415', bankName: 'Ngân hàng thử', accountNo: '123456789', accountName: 'CHU SAN' };
  assert.equal((await call('PUT', '/api/admin/payment-settings', owner, paymentData)).code, 403, 'chưa nhập mật khẩu không thể sửa');
  assert.equal((await call('POST', '/api/admin/payment-settings/unlock', owner, { password: 'wrong' })).code, 403);
  const unlocked = await call('POST', '/api/admin/payment-settings/unlock', owner, { password: 'admin123' });
  assert.equal(unlocked.code, 200);
  const edit = { 'x-payment-edit-token': unlocked.data.editToken };
  assert.equal((await call('PUT', '/api/admin/payment-settings', owner, paymentData,
    { 'x-payment-edit-token': 'expired' })).code, 403, 'quyền sửa hết hạn bị từ chối');
  assert.equal((await call('PUT', '/api/admin/payment-settings', { id: 2, role: 'admin' }, paymentData, edit)).code, 403,
    'quyền sửa không dùng được cho admin khác');
  result = await call('PUT', '/api/admin/payment-settings', owner, {
    bankBin: '970415', bankName: 'Ngân hàng thử', accountNo: '123456789', accountName: 'CHU SAN',
  }, edit);
  assert.equal(result.data.bank_bin, '970415');
  result = await call('PUT', '/api/admin/payment-settings', { id: 5, role: 'staff' }, {
    bankBin: '970415', bankName: 'Khác', accountNo: '987654321', accountName: 'KHAC',
  });
  assert.equal(result.code, 403);

  booking.confirmed_at = new Date(Date.now() - 5 * 60_000).toISOString();
  result = await call('GET', '/api/bookings/:id/payment');
  assert.equal(result.code, 200);
  assert.equal(result.data.amount, 80000);
  assert.equal(result.data.code, 'COURTLY 31');
  assert.ok(Math.abs(+new Date(result.data.dueAt) - (+new Date(booking.confirmed_at) + 600_000)) < 1000);
  assert.match(result.data.qrUrl, /^https:\/\/img\.vietqr\.io\/image\/970415-123456789-qr_only\.png\?amount=80000&addInfo=COURTLY%2031&accountName=CHU%20SAN$/);
  assert.equal((await call('GET', '/api/bookings/:id/payment', { id: 8, role: 'user' })).code, 404);

  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  result = await call('PUT', '/api/admin/payment-settings/qr', { id: 5, role: 'staff' }, png, { 'content-type': 'image/png' });
  assert.equal(result.code, 403, 'nhân viên không được thay QR ngân hàng');
  result = await call('PUT', '/api/admin/payment-settings/qr', owner, Buffer.from('invalid'), { 'content-type': 'image/png', ...edit });
  assert.equal(result.code, 400, 'từ chối nội dung không phải ảnh PNG');
  result = await call('PUT', '/api/admin/payment-settings/qr', owner, png, { 'content-type': 'image/png', ...edit });
  assert.equal(result.code, 200);
  assert.equal((await call('GET', '/api/admin/payment-settings', owner)).data.has_qr, true);
  result = await call('GET', '/api/bookings/:id/payment');
  assert.equal(result.data.qrUrl, '/api/bookings/31/payment/qr');
  result = await call('GET', '/api/bookings/:id/payment/qr');
  assert.deepEqual(result.data, png);
  assert.equal(result.mime, 'image/png');
  assert.equal(result.headers['Cache-Control'], 'private, no-store');
  assert.equal((await call('GET', '/api/bookings/:id/payment/qr', { id: 8, role: 'user' })).code, 404);
  assert.equal((await call('GET', '/api/admin/payment-settings/qr', { id: 5, role: 'staff' })).code, 403);
  const newerPng = Buffer.from('89504e470d0a1a0a1234567890', 'hex');
  assert.equal((await call('PUT', '/api/admin/payment-settings/qr', owner, newerPng, { 'content-type': 'image/png', ...edit })).code, 200);
  assert.deepEqual((await call('GET', '/api/admin/payment-settings/qr', owner)).data, newerPng,
    'ảnh QR mới ghi đè ảnh cũ trên cùng một tài khoản');
  assert.equal((await call('PUT', '/api/admin/payment-settings', owner, {
    bankBin: '970415', bankName: 'Ngân hàng thử', accountNo: '123456789', accountName: 'CHU SAN',
  }, edit)).code, 200);
  assert.deepEqual((await call('GET', '/api/admin/payment-settings/qr', owner)).data, newerPng,
    'lưu lại tài khoản không làm mất ảnh QR đã tải');
  assert.equal((await call('DELETE', '/api/admin/payment-settings/qr', owner)).code, 403);
  result = await call('DELETE', '/api/admin/payment-settings/qr', owner, {}, edit);
  assert.equal(result.code, 200);
  assert.match((await call('GET', '/api/bookings/:id/payment')).data.qrUrl, /^https:\/\/img\.vietqr\.io/);

  booking.confirmed_at = new Date(Date.now() - 11 * 60_000).toISOString();
  result = await call('GET', '/api/bookings/:id/payment');
  assert.equal(result.data.qrUrl, null, 'hết hạn thì không còn QR để quét');
  assert.equal(result.data.status, 'cancelled', 'quá hạn hủy booking trước khi trả thông tin thanh toán');
  assert.equal((await call('GET', '/api/bookings/:id/payment/qr')).code, 404);
  assert.equal((await call('PATCH', '/api/admin/bookings/:id/paid', owner, { paid: true })).code, 409,
    'admin không thể xác nhận booking chuyển khoản đã tự hủy');
  booking.status = 'confirmed';
  booking.confirmed_at = new Date(Date.now() - 60_000).toISOString();
  await call('PATCH', '/api/admin/bookings/:id/paid', owner, { paid: true });
  assert.equal(booking.paid, true, 'admin ghi nhận đã thu chuyển khoản');
  result = await call('GET', '/api/bookings/:id/payment');
  assert.equal(result.data.paid, true);
  assert.equal(result.data.qrUrl, null);
  assert.equal(result.data.status, 'confirmed');

  const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
  assert.doesNotMatch(schema, /CONSTRAINT transfer_must_be_paid/);
  assert.match(schema, /p_payment_method,\s*false,\s*now\(\) \+ interval '5 minutes'/);
  assert.match(source, /ALTER TABLE bookings DROP CONSTRAINT IF EXISTS transfer_must_be_paid/);
  assert.doesNotMatch(source, /UPDATE bookings SET paid = true\s+WHERE payment_method = 'transfer'/);

  const ui = new Map();
  const el = id => { if (!ui.has(id)) ui.set(id, { textContent: '', hidden: false }); return ui.get(id); };
  const from = frontend.indexOf('function renderTransferPayment() {');
  const to = frontend.indexOf('async function fetchTransferPayment', from);
  const view = vm.createContext({ $: el, Date, Math, String });
  const deadline = new Date(Date.now() + 5 * 60_000).toISOString();
  vm.runInContext(`let transferData = { dueAt: '${deadline}', paid: false, qrUrl: 'test' };\n${frontend.slice(from, to)}\nrenderTransferPayment();`, view);
  assert.match(el('#transferStatus').textContent, /chuyển khoản trong 05:00/);
  assert.equal(el('#transferQrWrap').hidden, false);
  vm.runInContext('transferData.paid = true; renderTransferPayment();', view);
  assert.equal(el('#transferQrWrap').hidden, true, 'đã thu tiền thì ẩn mã QR');
  assert.match(el('#transferStatus').textContent, /Đã thu tiền/);
  vm.runInContext("transferData.paid = false; transferData.dueAt = '2000-01-01T00:00:00Z'; renderTransferPayment();", view);
  assert.equal(el('#transferQrWrap').hidden, true, 'hết 10 phút thì ẩn mã QR');
  assert.match(el('#transferStatus').textContent, /hết 10 phút/);
  vm.runInContext("transferData.status = 'cancelled'; renderTransferPayment();", view);
  assert.match(el('#transferStatus').textContent, /đã hủy/);
  assert.equal(el('#transferHelp').hidden, true, 'booking đã hủy không tiếp tục hướng dẫn chuyển khoản');
  console.log('Transfer payment: bank setup, QR and deadline, account access, manual paid status, migration OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
