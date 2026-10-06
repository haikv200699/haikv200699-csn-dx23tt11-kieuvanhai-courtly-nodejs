const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'db/schema.sql'), 'utf8');
const frontend = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
assert.match(schema, /member_type\s+TEXT NOT NULL DEFAULT 'casual'/);
assert.match(schema, /v_quote := court_price_quote\(p_starts_at, p_ends_at, v_member\)/);
assert.match(schema, /SELECT CASE WHEN role = 'user' THEN member_type ELSE 'casual' END/);
assert.match(serverSource, /b\.status = 'confirmed' AND b\.ends_at <= now\(\)/);
assert.match(serverSource, /count\(DISTINCT date_trunc\('month', b\.ends_at AT TIME ZONE 'Asia\/Ho_Chi_Minh'\)\)/);
assert.match(html, /id="profileMenuPlayers"[^>]*>Tài khoản người chơi/);
assert.match(html, /id="accCreatePanel"[^>]*hidden/);
assert.match(css, /\.accounts-dialog\{[^}]*width:min\(96vw,1180px\)/);

const routes = new Map(), queries = [], emitted = [];
const app = { use() {}, get(p, ...cb) { routes.set(`GET ${p}`, cb.at(-1)); },
  post(p, ...cb) { routes.set(`POST ${p}`, cb.at(-1)); },
  patch(p, ...cb) { routes.set(`PATCH ${p}`, cb.at(-1)); }, delete() {}, put() {} };
const express = () => app;
express.raw = express.json = express.static = () => () => {};
class Pool {
  async connect() { return {query: this.query.bind(this),release(){}}; }
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (/SELECT \* FROM users WHERE id=\$1 FOR SHARE/.test(sql)) return {rows:[{id:1,role:'admin'}]};
    if (/SELECT court_price_quote/.test(sql)) return {rows:[{quote:{total:80000,standard:100000,memberType:'fixed',lines:[]}}]};
    if (/SELECT \* FROM ranked/.test(sql) && /LIMIT \$3/.test(sql)) return { rows: [{ id: 8, full_name: 'Lan', member_type: 'fixed', completed_count: 12, booking_rank: 1 }] };
    if (/count\(\*\)::int AS total FROM ranked/.test(sql)) return { rows: [{ total: 1 }] };
    if (/AS fixed,/.test(sql)) return { rows: [{ fixed: 1, casual: 3, staff: 1 }] };
    if (/UPDATE users SET member_type/.test(sql)) return { rows: [{ id: +params[0], member_type: params[1] }] };
    if (/SELECT \* FROM courts WHERE id/.test(sql)) return { rows: [{ id: 2, name: 'Court 02', price_per_hour: 80000, open_time: '06:00', close_time: '23:00' }] };
    if (/SELECT id, member_type FROM users/.test(sql)) return { rows: [{ id: 8, member_type: 'fixed' }] };
    if (/INSERT INTO bookings \(court_id, user_id/.test(sql)) return { rows: [{ id: 90, court_id: 2 }] };
    if (/SELECT \* FROM create_booking/.test(sql)) return { rows: [{ create_booking: 91 }] };
    if (/SELECT hold_expires_at, total_price/.test(sql)) return { rows: [{ hold_expires_at: new Date(Date.now() + 300000), total_price: 80000, standard_price: 100000, discount_percent: 0 }] };
    return { rows: [], rowCount: 0 };
  }
}
class Server { on() {} emit(event, data) { emitted.push([event, data]); } }
vm.runInNewContext(serverSource.replace(/setup\(\)\s*\.then\([\s\S]*$/, ''), {
  require(name) {
    if (name === 'express') return express;
    if (name === 'http') return { createServer: () => ({ on() {} }) };
    if (name === 'pg') return { Pool };
    if (name === 'socket.io') return { Server };
    if (name === 'jsonwebtoken') return { sign() {}, verify() {} };
    if (name === 'bcryptjs') return {};
    return require(name);
  }, __dirname: path.join(root, 'server'), process, console, setInterval() {}, setTimeout, Date, Intl, Buffer,
});
const call = async (method, route, { body = {}, role = 'admin', id = '8', query = {} } = {}) => {
  const response = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
  await routes.get(`${method} ${route}`)({ body, user: { id: 1, role, name: 'Admin' }, params: { id }, query }, response, error => { throw error; });
  return response;
};

(async () => {
  const list = await call('GET', '/api/admin/accounts', { query: { view: 'fixed', q: 'Lan', page: '1' } });
  assert.equal(list.data.rows[0].completed_count, 12);
  assert.equal('leaderboard' in list.data, false, 'chỉ trả dữ liệu quản lý thành viên');
  assert.ok(!queries.some(({sql}) => /completed_count > 0 ORDER BY booking_rank LIMIT 6/.test(sql)), 'không truy vấn bảng xếp hạng đã bỏ');
  assert.equal(list.data.summary.fixed, 1);
  assert.deepEqual(Array.from(queries.find(({ sql }) => /LIMIT \$3 OFFSET \$4/.test(sql)).params), ['fixed', 'Lan', 20, 0]);
  assert.equal((await call('GET', '/api/admin/accounts', { role: 'user' })).code, 403);
  assert.equal((await call('PATCH', '/api/admin/accounts/:id/membership', { body: { memberType: 'admin' } })).code, 400);
  assert.equal((await call('PATCH', '/api/admin/accounts/:id/membership', { id: 'abc', body: { memberType: 'fixed' } })).code, 400);
  assert.equal((await call('PATCH', '/api/admin/accounts/:id/membership', { role: 'staff', body: { memberType: 'fixed' } })).code, 403);
  const member = await call('PATCH', '/api/admin/accounts/:id/membership', { body: { memberType: 'fixed' } });
  assert.equal(member.data.member_type, 'fixed');
  assert.deepEqual(Array.from(queries.find(({ sql }) => /UPDATE users SET member_type/.test(sql)).params), ['8', 'fixed']);
  assert.ok(emitted.some(([event]) => event === 'account:membershipUpdated'));

  const start = new Date(Date.now() + 86400000);
  start.setUTCHours(10, 0, 0, 0);
  const end = new Date(+start + 3600000);
  const assigned = await call('POST', '/api/admin/bookings', { body: {
    courtId: 2, startsAt: start.toISOString(), endsAt: end.toISOString(), userId: 8,
    playerName: 'Lan', playerPhone: '0912345678', paymentMethod: 'onsite',
  } });
  assert.equal(assigned.code, 201);
  assert.equal(assigned.data.totalPrice, 80000);
  assert.equal(assigned.data.discountPercent, 0);
  const insert = queries.find(({ sql }) => /INSERT INTO bookings \(court_id, user_id/.test(sql));
  assert.equal(insert.params[4], 80000, 'dùng bảng giá cố định theo khung giờ');
  assert.equal(insert.params[5], 100000, 'giữ giá tiêu chuẩn trên booking để đối chiếu');
  assert.equal(insert.params[6], 0, 'lưu ưu đãi cho booking, không phụ thuộc nhóm tài khoản về sau');

  const held = await call('POST', '/api/bookings/hold', { role: 'user', body: {
    courtId: 2, startsAt: start.toISOString(), endsAt: end.toISOString(), paymentMethod: 'onsite',
  } });
  assert.equal(held.data.totalPrice, 80000);
  assert.equal(held.data.discountPercent, 0);
  assert.match(frontend, /b\.holdPrice = r\.totalPrice; b\.holdDiscountPercent = r\.discountPercent/);
  console.log('Membership: ranking filter, admin permissions, fixed tariff assigned price and customer hold snapshot OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
