// Kiểm tra phân trang, bộ lọc và quyền xem hóa đơn mà không cần PostgreSQL.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

const routes = new Map(), queries = [];
const app = { use() {}, get(p, ...f) { routes.set(`GET ${p}`, f.at(-1)); },
  post() {}, patch() {}, delete() {}, put() {} };
const express = () => app;
express.raw = express.json = express.static = () => () => {};
class Pool {
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (/FROM booking_charge_lines/.test(sql)) return { rows: [{line_id:0,gross:80000,net:80000,discount:0,paid:false},{line_id:1,gross:20000,net:20000,discount:0,paid:true}] };
    if (/SELECT count\(\*\)::int total,/.test(sql)) return { rows: [{ total: 47, upcoming: 8, completed: 34, cancelled: 5, revenue: 4200000 }] };
    if (/ORDER BY COALESCE\(b.confirmed_at, b.created_at\) DESC, b.id DESC LIMIT/.test(sql)) return { rows: [{ id: 9, court_name: 'Court 01' }] };
    if (/ORDER BY COALESCE\(b.confirmed_at, b.created_at\) DESC, b.id DESC/.test(sql)) return { rows: [{ id: 12, court_name: 'Court 02' }] };
    if (/SELECT b\.\*, c.name AS court_name, c.district, u.email AS user_email/.test(sql))
      return { rows: [{ id: 9, user_id: 7, status: 'confirmed', total_price: 80000, paid: false, court_name: 'Court 01' }] };
    if (/FROM booking_addons WHERE booking_id/.test(sql)) return { rows: [{ label: 'Nước', quantity: 2, unit_price: 10000, paid: true }] };
    return { rows: [] };
  }
}
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
async function call(route, user, query = {}, id = '9') {
  const handler = routes.get(`GET ${route}`);
  assert.ok(handler, route);
  const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.data = value; return this; } };
  await handler({ params: { id }, query, user }, res, error => { throw error; });
  return res;
}
(async () => {
  const user = { id: 7, role: 'user' };
  const history = await call('/api/bookings/history', user,
    { name: 'Nguyễn', phone: '090', court: 'Court', date: '2026-09-29', page: '3', limit: '20' });
  assert.equal(history.data.summary.total, 47);
  assert.equal(history.data.summary.upcoming, 8);
  assert.equal(history.data.rows.length, 1);
  assert.equal(history.data.page, 3);
  const list = queries.find(({ sql }) => /ORDER BY COALESCE\(b.confirmed_at, b.created_at\) DESC, b.id DESC LIMIT/.test(sql));
  assert.deepEqual(Array.from(list.params), [7, false, 'Nguyễn', '090', 'Court', '2026-09-29', 20, 40]);
  assert.match(list.sql, /AND \(\$2::boolean OR b.user_id=\$1\)/);
  assert.match(list.sql, /b.status='cancelled' AND b.confirmed_at IS NOT NULL/);
  assert.doesNotMatch(list.sql, /AND \(b.status='cancelled' OR b.ends_at <= now\(\)\)/, 'booking tương lai phải nằm trong toàn bộ booking');
  assert.match(list.sql, /ORDER BY COALESCE\(b.confirmed_at, b.created_at\) DESC, b.id DESC/);
  const today = await call('/api/bookings/mine', user);
  assert.equal(today.data.length, 1);
  const todayQuery = queries.find(({ sql }) => sql.includes('$3::date::timestamp') && /ORDER BY COALESCE\(b.confirmed_at, b.created_at\) DESC, b.id DESC/.test(sql));
  assert.match(todayQuery.sql, /\$3::date::timestamp AT TIME ZONE 'Asia\/Ho_Chi_Minh'/);
  assert.match(todayQuery.sql, /b.status = 'cancelled' AND b.confirmed_at IS NOT NULL/);
  assert.deepEqual(Array.from(todayQuery.params.slice(0, 2)), [7, false]);
  assert.match(list.sql, /nullif\(\$6,''\)::date::timestamp AT TIME ZONE 'Asia\/Ho_Chi_Minh'/);
  assert.match(list.sql, /lower\(c.name\)/);
  assert.match(html, /name="date" type="date" aria-label="Lọc theo ngày chơi"/);
  assert.doesNotMatch(html, /Email tài khoản<input name="email"/);
  const invalid = await call('/api/bookings/history', user, { date: '2026-02-30' });
  assert.equal(invalid.code, 400, 'ngày không tồn tại bị từ chối');

  let invoice = await call('/api/bookings/:id/invoice', user);
  assert.equal(invoice.data.total, 100000);
  assert.equal(invoice.data.paidAmount, 20000);
  invoice = await call('/api/bookings/:id/invoice', { id: 99, role: 'user' });
  assert.equal(invoice.code, 404, 'người chơi không được xem hóa đơn của tài khoản khác');
  invoice = await call('/api/bookings/:id/invoice', { id: 99, role: 'staff' });
  assert.equal(invoice.code, 200, 'nhân viên được xem hóa đơn phục vụ thống kê');
  console.log('History: scoped filters, pagination, aggregate and invoice access OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
