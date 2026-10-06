const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8')
  .replace(/setup\(\)\s*\.then\([\s\S]*$/, '');
const routes = new Map(), queries = [], emitted = [];
const people = [
  { id: 7, email: 'lan@example.com', full_name: 'Lan', phone: '0912345678', role: 'user', member_type: 'fixed', password_hash: 'hash:secret' },
  { id: 8, email: 'nhanvien@example.com', full_name: 'Nhân viên', phone: '0987654321', role: 'staff', member_type: 'casual', password_hash: 'hash:staffpass' },
];
const app = { use() {}, get(route, ...handlers) { routes.set(`GET ${route}`, handlers); },
  post(route, ...handlers) { routes.set(`POST ${route}`, handlers); },
  patch(route, ...handlers) { routes.set(`PATCH ${route}`, handlers); }, put() {}, delete() {} };
const express = () => app;
express.json = express.raw = express.static = () => () => {};
const query = async (sql, params = []) => {
  queries.push({ sql, params });
  if(sql.includes('SELECT * FROM users WHERE id=$1')) return {rows:[{id:params[0],role:params[0]===1?'admin':params[0]===8?'staff':'user',session_version:0}]};
  if (sql.includes('SELECT * FROM users WHERE email')) return { rows: people.filter(u => u.email === params[0]) };
  if (sql.includes('SELECT * FROM users WHERE phone')) return { rows: people.filter(u => u.phone === params[0]).slice(0, 2) };
  if (sql.includes("SELECT id, role, member_type FROM users")) return { rows: people.filter(u => u.id === Number(params[0]) && u.role !== 'admin').map(u => ({ ...u })) };
  if (sql.includes('SELECT id FROM users WHERE phone=$1 AND id<>$2')) {
    const matches = people.filter(u => u.phone === params[0] && u.id !== Number(params[1]));
    return { rows: matches, rowCount: matches.length };
  }
  if (sql.includes('UPDATE users SET full_name=$2, email=$3')) {
    const u = people.find(person => person.id === Number(params[0]));
    Object.assign(u, { full_name: params[1], email: params[2], phone: params[3], member_type: params[4] });
    return { rows: [u] };
  }
  if (sql.includes('FROM generate_series')) return { rows: [
    { date: params[0], label: '30/09/26', bookings: 1, revenue: 80000 },
    { date: params[1], label: '01/10/26', bookings: 2, revenue: 120000 },
  ] };
  return { rows: [], rowCount: 0 };
};
class Pool { query(sql, params) { return query(sql, params); } async connect() { return { query, release() {} }; } }
class Server { on() {} emit(event, payload) { emitted.push([event, payload]); } }
vm.runInNewContext(source, {
  require(name) {
    if (name === 'express') return express;
    if (name === 'http') return { createServer: () => ({ on() {} }) };
    if (name === 'pg') return { Pool };
    if (name === 'socket.io') return { Server };
    if (name === 'jsonwebtoken') return { sign: () => 'token', verify: token => ({ id: token==='admin'?1:token==='staff'?8:7, role: token }) };
    if (name === 'bcryptjs') return { compare: async (password, hash) => hash === 'hash:' + password };
    return require(name);
  }, __dirname: path.join(__dirname, '../server'), process, console, setTimeout, setInterval() {}, Date, Intl, Buffer,
});
async function call(method, route, { body = {}, query: qs = {}, id = '7', role = 'admin' } = {}) {
  const response = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
  const request = { method,route:{path:route},body, query: qs, params: { id }, headers: { authorization: `Bearer ${role}` } };
  const handlers = routes.get(`${method} ${route}`);
  assert.ok(handlers, route);
  for (const handler of handlers) {
    let rejected;
    await handler(request, response, error => { if (error) rejected = error; });
    if (rejected) {if(!rejected.status) throw rejected;response.status(rejected.status).json({error:rejected.message});}
    if (response.code >= 400) break;
  }
  return response;
}
const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

(async () => {
  const phone = await call('POST', '/api/auth/login', { body: { email: '0912 345 678', password: 'secret' } });
  assert.equal(phone.data.user.id, 7);
  const email = await call('POST', '/api/auth/login', { body: { email: 'LAN@EXAMPLE.COM', password: 'secret' } });
  assert.equal(email.data.user.id, 7);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: '0912345678', password: 'wrong' } })).code, 401);
  people.push({ ...people[0], id: 9, email: 'duplicate@example.com' });
  assert.equal((await call('POST', '/api/auth/login', { body: { email: '0912345678', password: 'secret' } })).code, 409);
  people.pop();

  const from = addDays(today, -6);
  const report = await call('GET', '/api/admin/revenue', { query: { from, to: today } });
  assert.equal(report.data.total, 200000);
  assert.equal(report.data.bookings, 3);
  const revenueSql = queries.find(({ sql }) => sql.includes('FROM generate_series')).sql;
  assert.match(revenueSql, /AT TIME ZONE 'Asia\/Ho_Chi_Minh'/);
  assert.equal((await call('GET', '/api/admin/revenue', { query: { from: today, to: from } })).code, 400);
  assert.equal((await call('GET', '/api/admin/revenue', { query: { from: '2026-02-30', to: today } })).code, 400);
  assert.equal((await call('GET', '/api/admin/revenue', { query: { from: addDays(today, -400), to: today } })).code, 400);
  assert.equal((await call('GET', '/api/admin/revenue', { query: { from: today, to: addDays(today, 1) } })).code, 400);
  assert.equal((await call('GET', '/api/admin/revenue', { role: 'user' })).code, 403);

  const update = await call('PATCH', '/api/admin/accounts/:id', { body: {
    fullName: 'Lan Mới', email: 'LanMoi@example.com', phone: '0912345678', memberType: 'casual',
  } });
  assert.equal(update.data.member_type, 'casual');
  assert.equal(update.data.email, 'lanmoi@example.com');
  assert.ok(queries.some(({ sql }) => sql.includes('UPDATE weekly_schedules SET active=false')));
  assert.ok(emitted.some(([event, payload]) => event === 'account:membershipUpdated' && payload.userId === 7));
  const staff = await call('PATCH', '/api/admin/accounts/:id', { id: '8', body: {
    fullName: 'Nhân viên Mới', email: 'nv@example.com', phone: '0987654321', memberType: 'fixed',
  } });
  assert.equal(staff.data.member_type, 'casual', 'staff cannot receive player discount');
  assert.equal((await call('PATCH', '/api/admin/accounts/:id', { role: 'staff', body: {
    fullName: 'Lan', email: 'lan@example.com', phone: '0912345678', memberType: 'fixed',
  } })).code, 403);
  assert.equal((await call('PATCH', '/api/admin/accounts/:id', { body: {
    fullName: 'Lan', email: 'lan@example.com', phone: '0987654321', memberType: 'fixed',
  } })).code, 409);
  console.log('Revenue range, Vietnam date bounds, phone/email login, account edit permissions and discount update OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
