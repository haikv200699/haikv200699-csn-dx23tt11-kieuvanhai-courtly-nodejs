// Lịch cố định phải tạo booking theo tuần, chốt ưu đãi và không lưu nửa chừng khi bị trùng.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
assert.match(schema, /CREATE TABLE IF NOT EXISTS weekly_schedules/);
assert.match(schema, /bookings_schedule_occurrence_idx/);

const routes = new Map(), rules = [], bookings = [], events = [];
let saved, occupiedDay = null;
const client = {
  async query(sql, p = []) {
    if (sql === 'BEGIN') { saved = { rules: rules.map(r => ({ ...r })), bookings: bookings.map(b => ({ ...b })) }; return {}; }
    if (sql === 'COMMIT') { saved = null; return {}; }
    if (sql === 'ROLLBACK') { rules.splice(0, rules.length, ...saved.rules); bookings.splice(0, bookings.length, ...saved.bookings); saved = null; return {}; }
    if (sql.startsWith('SAVEPOINT') || sql.startsWith('RELEASE SAVEPOINT') || sql.startsWith('ROLLBACK TO SAVEPOINT')) return {};
    if (/SELECT id, member_type, phone FROM users/.test(sql))
      return { rows: [{ id: 8, member_type: 'fixed', phone: '0912345678' }] };
    if (/SELECT \* FROM courts WHERE id/.test(sql))
      return { rows: [{ id: 2, open_time: '06:00', close_time: '23:00', under_maintenance: false }] };
    if (/SELECT \* FROM weekly_schedules WHERE id=/.test(sql)) {
      const found = rules.find(r => r.id === Number(p[0]) && r.user_id === Number(p[1]) && r.active);
      return { rows: found ? [{ ...found }] : [] };
    }
    if (/SELECT id FROM weekly_schedules WHERE user_id/.test(sql)) {
      const found = rules.find(r => r.active && r.user_id === Number(p[0]) && r.court_id === Number(p[1]) && r.weekday === Number(p[2]) && r.start_min === p[3] && r.end_min === p[4] && (!sql.includes('id<>') || r.id !== Number(p[5])));
      return { rows: found ? [{ id: found.id }] : [], rowCount: found ? 1 : 0 };
    }
    if (/INSERT INTO weekly_schedules/.test(sql)) {
      const row = { id: rules.length + 1, user_id: Number(p[0]), court_id: Number(p[1]), weekday: Number(p[2]), start_min: p[3], end_min: p[4], active: true,
        member_type: 'fixed', phone: '0912345678', full_name: 'Lan', court_name: 'Court 02', price_per_hour: 80000,
        open_time: '06:00', close_time: '23:00', under_maintenance: false };
      rules.push(row); return { rows: [{ id: row.id }] };
    }
    if (/FROM weekly_schedules s JOIN users/.test(sql)) {
      const found = rules.filter(r => sql.includes('WHERE s.id=') ? r.id === Number(p[0]) : sql.includes('WHERE s.user_id=') ? r.user_id === Number(p[0]) && r.active : r.active);
      return { rows: found };
    }
    if (/SELECT id FROM bookings WHERE schedule_rule_id/.test(sql)) {
      const row = bookings.find(b => b.ruleId === Number(p[0]) && b.day === p[1]);
      return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
    }
    if (/SELECT id FROM bookings WHERE user_id/.test(sql))
      return { rows: [], rowCount: occupiedDay === new Date(p[1].getTime() + 7 * 3600e3).toISOString().slice(0, 10) ? 1 : 0 };
    if (/INSERT INTO bookings \(court_id,user_id,starts_at/.test(sql)) {
      const row = { id: bookings.length + 1, ruleId: Number(p[8]), day: p[9], price: p[4], standard: p[5], paid: false };
      bookings.push(row); return { rows: [{ id: row.id }] };
    }
    if (/UPDATE weekly_schedules SET active=false/.test(sql)) {
      const row = rules.find(r => r.id === Number(p[0]) && r.user_id === Number(p[1]) && r.active);
      if (row) row.active = false;
      return { rowCount: row ? 1 : 0 };
    }
    throw new Error('Unexpected SQL: ' + sql);
  }, release() {},
};
const app = { get(p, ...fn) { routes.set('GET ' + p, fn.at(-1)); }, post(p, ...fn) { routes.set('POST ' + p, fn.at(-1)); }, patch(p, ...fn) { routes.set('PATCH ' + p, fn.at(-1)); }, delete(p, ...fn) { routes.set('DELETE ' + p, fn.at(-1)); } };
const start = source.indexOf('const scheduleDays =');
const end = source.indexOf('// Tạo tài khoản nhân viên', start);
assert.ok(start > 0 && end > start);
const context = vm.createContext({ app, auth() {}, admin() {}, ah: fn => fn,
  pool: { connect: async () => client, query: (...args) => client.query(...args) },
  io: { emit: (...args) => events.push(args) }, broadcast: async () => {},
  vnDay: d => new Date(d.getTime() + 7 * 3600e3).toISOString().slice(0, 10),
  toMin: t => { const [h, m] = t.split(':'); return +h * 60 + +m; },
  priceQuote: async (_client,start,end,member) => require('../public/pricing.js').quote(require('../public/pricing.js').defaults,start,end,member),
  Date, console,
});
vm.runInContext(source.slice(start, end), context);
async function call(method, route, { body = {}, role = 'admin', id = '8', ruleId } = {}) {
  const res = { code: 200, status(n) { this.code = n; return this; }, json(data) { this.data = data; return this; } };
  await routes.get(`${method} ${route}`)({ body, user: { role, id: 1 }, params: { id, ruleId } }, res);
  return res;
}
(async () => {
  const weekday = vm.runInContext('scheduleDays(1).length', context);
  assert.ok(weekday >= 4 && weekday <= 5, 'một thứ trong cửa sổ 30 ngày có 4–5 lượt');
  const nextDay = new Date(vm.runInContext('vnDay(new Date())', context) + 'T00:00:00Z');
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const monday = nextDay.getUTCDay();
  const expectedCount = vm.runInContext(`scheduleDays(${monday}).length`, context);
  const body = { courtId: 2, weekday: monday, start: '08:00', end: '09:00' };
  assert.equal((await call('POST', '/api/admin/accounts/:id/schedule', { body, role: 'staff' })).code, 403);
  const created = await call('POST', '/api/admin/accounts/:id/schedule', { body });
  assert.equal(created.code, 201);
  assert.equal(created.data.created, expectedCount);
  assert.equal(bookings.length, expectedCount);
  assert.ok(bookings.every(b => { const q=require('../public/pricing.js').quote(require('../public/pricing.js').defaults,b.day+'T08:00:00+07:00',b.day+'T09:00:00+07:00','fixed'); return b.price===q.total && b.standard===q.standard && !b.paid; }));
  assert.equal((await call('POST', '/api/admin/accounts/:id/schedule', { body })).code, 409);
  const before = bookings.length;
  occupiedDay = vm.runInContext(`scheduleDays(${monday})[0]`, context);
  const conflict = await call('POST', '/api/admin/accounts/:id/schedule', { body: { ...body, start: '09:00', end: '10:00' } });
  assert.equal(conflict.code, 409);
  assert.equal(bookings.length, before, 'lịch bị trùng phải rollback toàn bộ');
  assert.equal(rules.length, 1);
  occupiedDay = null;
  const list = await call('GET', '/api/admin/accounts/:id/schedule');
  assert.equal(list.data.length, 1);
  assert.equal((await call('PATCH', '/api/admin/accounts/:id/schedule/:ruleId', { ruleId: '1', body, role: 'staff' })).code, 403);
  assert.equal((await call('PATCH', '/api/admin/accounts/:id/schedule/:ruleId', { ruleId: 'abc', body })).code, 400);
  const revised = await call('PATCH', '/api/admin/accounts/:id/schedule/:ruleId', { ruleId: '1', body: { ...body, start: '09:00', end: '10:00' } });
  assert.equal(revised.code, 200);
  assert.equal(revised.data.created, 0, 'booking cũ cùng ngày không được nhân đôi khi sửa quy tắc');
  assert.equal(rules[0].active, false);
  assert.equal(rules[1].active, true);
  assert.equal(rules[1].start_min, 540);
  assert.equal((await call('GET', '/api/admin/accounts/:id/schedule')).data.length, 1);
  assert.equal((await call('DELETE', '/api/admin/accounts/:id/schedule/:ruleId', { ruleId: '2' })).code, 200);
  assert.equal(bookings.length, expectedCount, 'ngừng lặp không xóa booking đã tạo');
  assert.ok(events.some(([event]) => event === 'booking:created'));
  console.log('Weekly schedules: permissions, in-place edit of recurrence, preserved bookings, conflict rollback and stop OK');
})().catch(err => { console.error(err); process.exitCode = 1; });
