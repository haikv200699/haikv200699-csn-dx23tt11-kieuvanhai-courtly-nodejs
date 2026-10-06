// Hạn chuyển khoản tính từ thời điểm xác nhận booking; worker và admin xử lý cùng trên DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const routes = new Map(), timers = new Map(), events = [], queries = [];
const app = { use() {}, get(url, ...handlers) { routes.set(`GET ${url}`, handlers.at(-1)); },
  post(url, ...handlers) { routes.set(`POST ${url}`, handlers.at(-1)); },
  patch(url, ...handlers) { routes.set(`PATCH ${url}`, handlers.at(-1)); },
  put() {}, delete() {} };
const express = () => app;
express.raw = express.json = express.static = () => () => {};
const earlier = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
const bookings = new Map([
  [31, { id: 31, user_id: 5, court_id: 2, status: 'confirmed', payment_method: 'transfer', paid: false, total_price: 80000, confirmed_at: earlier(11) }],
  [32, { id: 32, user_id: 5, court_id: 2, status: 'confirmed', payment_method: 'transfer', paid: false, total_price: 80000, confirmed_at: earlier(9) }],
  [33, { id: 33, user_id: 5, court_id: 3, status: 'confirmed', payment_method: 'transfer', paid: true, total_price: 80000, confirmed_at: earlier(11) }],
  [34, { id: 34, user_id: 5, court_id: 4, status: 'confirmed', payment_method: 'onsite', paid: false, total_price: 80000, confirmed_at: earlier(11) }],
  [35, { id: 35, user_id: 5, court_id: 5, status: 'confirmed', payment_method: 'transfer', paid: false, total_price: 80000, confirmed_at: earlier(9) }],
]);
const expired = b => Date.now() >= +new Date(b.confirmed_at) + 600_000;
const client = {
  async query(sql, params = []) {
    queries.push(sql);
    if(sql.includes('SELECT * FROM users WHERE id=$1 FOR SHARE')) return {rows:[{id:1,role:'admin'}]};
    if(sql.includes('SELECT * FROM bookings WHERE id=$1 FOR UPDATE')) return {rows:[bookings.get(+params[0])].filter(Boolean)};
    if(sql.includes('UPDATE bookings SET paid=$2')) {bookings.get(+params[0]).paid=params[1];return {rows:[]};}
    if (sql.includes('FOR UPDATE') && sql.includes('within_payment_window')) {
      const b = bookings.get(+params[0]);
      return { rows: b ? [{ ...b, within_payment_window: !expired(b) }] : [] };
    }
    if (sql.includes('UPDATE bookings SET paid=true')) {
      bookings.get(+params[0]).paid = true;
      return { rows: [] };
    }
    return { rows: [] };
  },
  release() {},
};
class Pool {
  async query(sql, params = []) {
    queries.push(sql);
    if (sql.includes("UPDATE bookings SET status = 'cancelled'") && sql.includes("payment_method = 'transfer'")) {
      const rows = [...bookings.values()].filter(b => b.status === 'confirmed' && b.payment_method === 'transfer' && !b.paid && expired(b));
      rows.forEach(b => { b.status = 'cancelled'; b.cancelled_at = new Date().toISOString(); });
      return { rows };
    }
    if (sql.includes('UPDATE bookings SET paid = $2')) {
      const b = bookings.get(+params[0]);
      if (!b || b.status !== 'confirmed' || (b.payment_method === 'transfer' &&
          (expired(b) && !b.paid || expired(b) && params[1] === false))) return { rows: [] };
      b.paid = params[1]; return { rows: [{ id: b.id, paid: b.paid }] };
    }
    if (sql.includes('FROM booking_invoice_totals')) { const b=bookings.get(+params[0]); return {rows:[{due:b.paid?0:b.total_price}]}; }
    if (sql.includes('FROM bookings WHERE id=$1')) return { rows: [bookings.get(+params[0])].filter(Boolean) };
    if (sql.includes('SELECT bank_bin, bank_name')) return { rows: [{ bank_bin: '970415', bank_name: 'Test', account_no: '123', account_name: 'COURTLY', has_qr: false }] };
    if (sql.includes('FROM courts c JOIN court_live_status')) return { rows: [] };
    return { rows: [] };
  }
  async connect() { return client; }
}
const fullSource = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
const source = fullSource.replace(/setup\(\)\s*\.then\([\s\S]*$/, '');
vm.runInNewContext(source, {
  require(name) {
    if (name === 'express') return express;
    if (name === 'http') return { createServer: () => ({ on() {} }) };
    if (name === 'pg') return { Pool };
    if (name === 'socket.io') return { Server: class { on() {} emit(name, payload) { events.push({ name, payload }); } } };
    if (name === 'jsonwebtoken') return { sign() {}, verify() {} };
    if (name === 'bcryptjs') return {};
    return require(name);
  },
  __dirname: path.join(__dirname, '../server'), process, console,
  setInterval(callback, ms) { timers.set(ms, callback); }, setTimeout, Date, Intl, Buffer,
});
async function call(method, url, id, body = {}, user = { id: 1, role: 'admin' }) {
  const handler = routes.get(`${method} ${url}`);
  assert.ok(handler, `Missing ${method} ${url}`);
  const response = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
  await handler({ params: { id: String(id) }, body, user }, response, error => {response.status(error.status||500).json({error:error.message});});
  return response;
}
(async () => {
  assert.ok(timers.has(5_000), 'server kiểm tra hạn thanh toán tự động');
  assert.equal((await call('PATCH', '/api/admin/bookings/:id/paid', 31, { paid: true })).code, 409,
    'sau hạn admin không được xác nhận thu tiền trước khi worker chạy');
  assert.equal((await call('POST', '/api/admin/bookings/:id/settle', 31)).code, 409,
    'hóa đơn cũng không thể lách thời hạn');
  assert.equal((await call('PATCH', '/api/admin/bookings/:id/paid', 32, { paid: true })).code, 200,
    'admin kịp xác nhận booking còn hạn');
  assert.equal((await call('POST', '/api/admin/bookings/:id/settle', 35)).code, 200,
    'ghi nhận cả hóa đơn trước hạn');

  bookings.get(32).confirmed_at = earlier(11);
  bookings.get(35).confirmed_at = earlier(11);
  await timers.get(5_000)();
  assert.equal(bookings.get(31).status, 'cancelled', 'booking quá hạn được hủy để nhả sân');
  for (const id of [32, 33, 34, 35])
    assert.equal(bookings.get(id).status, 'confirmed', `booking #${id} đã thanh toán hoặc tại sân vẫn giữ chỗ`);
  assert.equal(events.filter(e => e.name === 'booking:cancelled').length, 1, 'phát sự kiện cập nhật lịch sân');
  await timers.get(5_000)();
  assert.equal(events.filter(e => e.name === 'booking:cancelled').length, 1, 'worker chạy lại không hủy lặp');

  const payment = await call('GET', '/api/bookings/:id/payment', 31, {}, { id: 5, role: 'user' });
  assert.equal(payment.data.status, 'cancelled');
  assert.equal(payment.data.qrUrl, null);
  assert.equal((await call('POST', '/api/admin/bookings/:id/settle', 31)).code, 409,
    'booking đã hủy vì quá hạn không thể được xác nhận sau đó');
  assert.match(queries.find(q => q.includes("UPDATE bookings SET status = 'cancelled'")),
    /status = 'confirmed' AND payment_method = 'transfer' AND paid = false[\s\S]*confirmed_at <= now\(\) - interval '10 minutes'/);
  assert.match(queries.find(q => q.includes('FROM bookings WHERE id=$1 FOR UPDATE')), /FOR UPDATE/,
    'hóa đơn khóa hàng khi xác nhận để tránh race với worker');
  assert.match(fullSource, /await expireUnconfirmedTransfers\(\);\s*server\.listen/,
    'khởi động lại cũng dọn booking quá hạn');
  assert.match(fullSource, /UPDATE bookings SET confirmed_at = created_at\s+WHERE status = 'confirmed' AND confirmed_at IS NULL/,
    'booking legacy có mốc xác nhận để kiểm tra hạn');
  assert.match(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'),
    /bookings_transfer_deadline_idx[\s\S]*?ON bookings \(confirmed_at\)/,
    'danh sách lớn vẫn tra cứu booking sắp hết hạn hiệu quả');
  console.log('Transfer timeout: deadline, atomic cancellation, admin race, restart cleanup and QR status OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
