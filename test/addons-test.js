// Chạy bằng `node test/addons-test.js`; kiểm tra route và rollback không cần PostgreSQL.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const routes = new Map();
const app = { use() {}, get(p, ...f) { routes.set(`GET ${p}`, f.at(-1)); },
  post(p, ...f) { routes.set(`POST ${p}`, f.at(-1)); },
  patch(p, ...f) { routes.set(`PATCH ${p}`, f.at(-1)); },
  delete(p, ...f) { routes.set(`DELETE ${p}`, f.at(-1)); }, put(p, ...f) { routes.set(`PUT ${p}`, f.at(-1)); } };
const express = () => app;
express.raw = express.json = express.static = () => (_req, _res, next) => next?.();
const queries = [];
let booking, addons = [], overlap = false;
const client = {
  async query(sql, params = []) {
    queries.push([sql, params]);
    if(sql.includes('SELECT * FROM users WHERE id=$1 FOR SHARE')) return {rows:[{id:5,role:'admin'}]};
    if(sql.includes('SELECT * FROM bookings WHERE id=$1 FOR UPDATE')) return {rows:booking?[booking]:[]};
    if(sql.includes('SELECT * FROM booking_addons')) return {rows:addons};
    if(sql.includes('SELECT * FROM courts')) return {rows:booking?[booking]:[]};
    if (/SELECT court_price_quote/.test(sql)) return { rows: [{quote:{total:40000,standard:40000,memberType:'casual',lines:[]}}] };
    if (/SELECT b.id, b.status, b.court_id/.test(sql)) return { rows: booking ? [booking] : [] };
    if (/SELECT status, court_id FROM bookings/.test(sql)) return { rows: booking ? [booking] : [] };
    if (/SELECT id, court_id, status, confirmed_at, payment_method, paid,/.test(sql)) return { rows: booking ? [booking] : [] };
    if (/UPDATE bookings SET ends_at/.test(sql) && overlap) throw Object.assign(new Error('overlap'), { code: '23P01' });
    if (/INSERT INTO booking_addons/.test(sql)) return { rows: [{ id: 4, booking_id: 1 }] };
    return { rows: [], rowCount: 0 };
  },
  release() {},
};
class Pool { query(sql) {
  if (/FROM booking_charge_lines/.test(sql)) return Promise.resolve({rows:[{line_id:0,net:80000,discount:0,paid:true},...addons.map(a=>({line_id:a.id,net:a.quantity*a.unit_price,discount:0,paid:a.paid}))]});
  if (/SELECT b\.\*, c.name AS court_name/.test(sql)) return Promise.resolve({ rows: [{ ...booking, total_price: 80000, paid: true, court_name: 'Court 01' }] });
  if (/FROM booking_addons WHERE booking_id/.test(sql)) return Promise.resolve({ rows: addons });
  return Promise.resolve({ rows: [], rowCount: 0 });
} connect() { return Promise.resolve(client); } }
class Server { on() {} emit() {} }
const source = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8')
  .replace(/setup\(\)\s*\.then\([\s\S]*$/, '');
vm.runInNewContext(source, {
  require(name) {
    if (name === 'express') return express;
    if (name === 'http') return { createServer: () => ({ on() {} }) };
    if (name === 'pg') return { Pool };
    if (name === 'socket.io') return { Server };
    if (name === 'jsonwebtoken') return { sign() {}, verify() {} };
    if (name === 'bcryptjs') return {};
    return require(name);
  },
  __dirname: path.join(__dirname, '../server'), process, console,
  setInterval() {}, setTimeout, Date, Intl, Buffer,
});

async function call(method, route, body = {}, id = '1') {
  const handler = routes.get(`${method} ${route}`);
  assert.ok(handler, `Missing ${method} ${route}`);
  const response = { statusCode: 200, status(n) { this.statusCode = n; return this; },
    json(data) { this.data = data; return this; } };
  await handler({ params: { id }, body:{reason:'Test adjustment',...body}, user: { id: 5, role: 'admin' } }, response, err => { response.status(err.status || (err.code==='23P01'?409:500)).json({error:err.message}); });
  return response;
}

(async () => {
  const tomorrow = new Date(Date.now()+86400000); tomorrow.setUTCHours(0,0,0,0);
  const now = +tomorrow;
  booking = { id: 1, court_id: 2, status: 'confirmed', starts_at: new Date(now + 30 * 60000),
    ends_at: new Date(now + 90 * 60000), close_time: '23:00', price_per_hour: 80000,
    under_maintenance: false };
  let result = await call('POST', '/api/admin/bookings/:id/extend', { minutes: 30 });
  assert.equal(result.statusCode, 201);
  assert.ok(queries.some(([s]) => s === 'COMMIT'));
  assert.deepEqual(Array.from(queries.find(([s]) => /Gia hạn sân/.test(JSON.stringify(s)) || /INSERT INTO booking_addons/.test(s))[1]).slice(2, 3), [40000]);

  booking.ends_at = new Date(new Date(booking.starts_at).getTime() + 3 * 3600000);
  result = await call('POST', '/api/admin/bookings/:id/extend', { minutes: 30 });
  assert.equal(result.statusCode, 201, 'Admin can extend an initial 3-hour booking');
  booking.ends_at = new Date(now + 90 * 60000);

  queries.length = 0; overlap = true;
  result = await call('POST', '/api/admin/bookings/:id/extend', { minutes: 30 });
  assert.equal(result.statusCode, 409);
  assert.ok(queries.some(([s]) => s === 'ROLLBACK'));
  assert.ok(!queries.some(([s]) => s === 'COMMIT'));
  overlap = false;

  booking.close_time = '06:00'; queries.length = 0;
  result = await call('POST', '/api/admin/bookings/:id/extend', { minutes: 30 });
  assert.equal(result.statusCode, 409);
  assert.ok(!queries.some(([s]) => /UPDATE bookings SET ends_at/.test(s)));
  booking.close_time = '23:00';

  result = await call('POST', '/api/admin/bookings/:id/addons', { label: 'Nước suối', quantity: 2, unitPrice: 10000, paid: false });
  assert.equal(result.statusCode, 201);
  result = await call('POST', '/api/admin/bookings/:id/addons', { label: 'Bánh', quantity: 0, unitPrice: 20000, paid: false });
  assert.equal(result.statusCode, 400);

  addons = [{ id: 4, kind: 'product', label: 'Nước suối', quantity: 2, unit_price: 10000, paid: false }];
  result = await call('GET', '/api/admin/bookings/:id/bill');
  assert.equal(result.data.base, 80000);
  assert.equal(result.data.total, 100000);
  assert.equal(result.data.due, 20000);

  queries.length = 0;
  result = await call('POST', '/api/admin/bookings/:id/settle');
  assert.equal(result.data.ok, true);
  assert.ok(queries.some(([sql]) => /UPDATE bookings SET paid=true/.test(sql)));
  assert.ok(queries.some(([sql]) => /UPDATE booking_addons SET paid=true/.test(sql)));
  assert.ok(queries.some(([sql]) => sql === 'COMMIT'), 'thu tiền sân và dịch vụ trong một transaction');
  booking.status = 'cancelled'; queries.length = 0;
  result = await call('POST', '/api/admin/bookings/:id/settle');
  assert.equal(result.statusCode, 409, 'booking đã hủy không được ghi nhận thu tiền');
  assert.ok(!queries.some(([sql]) => /UPDATE bookings SET paid=true/.test(sql)));
  booking.confirmed_at = new Date(now); queries.length = 0;
  result = await call('POST', '/api/admin/bookings/:id/settle');
  assert.equal(result.statusCode, 200, 'booking đã hủy sau xác nhận vẫn ghi nhận thu tiền');
  assert.ok(queries.some(([sql]) => /UPDATE bookings SET paid=true/.test(sql)));
  console.log('Addon routes: extension, overlap rollback, closing time, product, invoice totals and full settlement OK');
})().catch(err => { console.error(err); process.exitCode = 1; });
