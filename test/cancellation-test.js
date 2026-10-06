// Chạy bằng `node test/cancellation-test.js`; kiểm tra đường đi của giữ chỗ và hủy đã xác nhận.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const routes = new Map();
const timers = new Map();
const app = { use() {}, get(p, ...handlers) { routes.set(`GET ${p}`, handlers.at(-1)); },
  post(p, ...handlers) { routes.set(`POST ${p}`, handlers.at(-1)); },
  patch(p, ...handlers) { routes.set(`PATCH ${p}`, handlers.at(-1)); },
  delete(p, ...handlers) { routes.set(`DELETE ${p}`, handlers.at(-1)); }, put(p, ...handlers) { routes.set(`PUT ${p}`, handlers.at(-1)); } };
const express = () => app;
express.raw = express.json = express.static = () => () => {};
const bookings = new Map();
const sqlSeen = [];
let currentActor;
class Pool {
  async connect(){return {query:this.query.bind(this),release(){}};}
  async query(sql, params = []) {
    sqlSeen.push(sql);
    if(sql.includes('SELECT * FROM users WHERE id=$1 FOR SHARE')) return {rows:[currentActor]};
    if(sql.includes('SELECT * FROM bookings WHERE id=$1 FOR UPDATE')) return {rows:[bookings.get(+params[0])].filter(Boolean)};
    if(sql.includes("UPDATE bookings SET status='cancelled'")) {bookings.get(+params[0]).status='cancelled'; return {rows:[]};}
    if (/SELECT \* FROM courts WHERE id/.test(sql)) return { rows: [{ open_time: '06:00', close_time: '23:00' }] };
    if (/SELECT \* FROM create_booking/.test(sql)) throw Object.assign(new Error('conflict'), { code: '23P01' });
    if (/UPDATE bookings SET status = 'confirmed'/.test(sql)) return { rows: [] };
    if (/DELETE FROM bookings/.test(sql)) {
      const targets = params.length ? [bookings.get(+params[0])].filter(Boolean) : [...bookings.values()];
      const removed = targets.filter(b => b.status === 'pending' &&
        (params.length ? b.user_id === params[1] : b.expired));
      removed.forEach(b => bookings.delete(b.id));
      return { rows: removed };
    }
    if (/UPDATE bookings SET status = 'cancelled'/.test(sql)) {
      const b = bookings.get(+params[0]);
      if (b?.status !== 'confirmed' || (b.user_id !== params[1] && params[2] !== 'admin') ||
          (+new Date(b.starts_at) <= Date.now() && params[2] !== 'admin')) return { rows: [] };
      b.status = 'cancelled';
      return { rows: [{ court_id: b.court_id }] };
    }
    if (/FROM bookings b JOIN courts/.test(sql)) {
      return { rows: [...bookings.values()].filter(b => b.status === 'confirmed' && +new Date(b.ends_at) > Date.now()) };
    }
    if (/FROM courts c JOIN court_live_status/.test(sql)) return { rows: [] };
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
  setInterval(callback, ms) { timers.set(ms, callback); }, setTimeout, Date, Intl, Buffer,
});
async function call(method, route, id, body = {}, user = { id: 5, role: 'user' }) {
  const response = { statusCode: 200, status(n) { this.statusCode = n; return this; },
    json(data) { this.data = data; return this; } };
  const handler = routes.get(`${method} ${route}`);
  assert.ok(handler, `Thiếu ${method} ${route}`);
  currentActor=user;
  await handler({ params: { id }, body:{reason:'Test cancellation',...body}, user }, response,
    error => {response.status(error.status || 500).json({error:error.message});});
  return response;
}
(async () => {
  const start = new Date(Date.now() + 86400000);
  start.setUTCHours(1, 0, 0, 0); // 08:00 giờ Việt Nam hôm sau.
  const conflict = await call('POST', '/api/bookings/hold', '0', {
    courtId: 1, startsAt: start.toISOString(), endsAt: new Date(+start + 3600000).toISOString(),
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(bookings.size, 0, 'đặt trùng giờ không tạo bản ghi hủy');

  bookings.set(1, { id: 1, user_id: 5, court_id: 1, status: 'pending' });
  assert.equal((await call('PATCH', '/api/bookings/:id/release', '1')).data.ok, true);
  assert.equal(bookings.has(1), false, 'đổi giờ xóa giữ chỗ tạm');

  bookings.set(2, { id: 2, user_id: 5, court_id: 1, status: 'pending', expired: true });
  await timers.get(15_000)();
  assert.equal(bookings.has(2), false, 'quá hạn xóa giữ chỗ tạm');
  assert.equal((await call('POST', '/api/bookings/:id/confirm', '2', {
    playerName: 'Người chơi', playerPhone: '0900000000', paymentMethod: 'onsite',
  })).statusCode, 410, 'xác nhận quá hạn báo hết thời gian giữ sân');
  assert.equal(bookings.size, 0, 'xác nhận quá hạn không sinh bản ghi hủy');

  bookings.set(3, { id: 3, user_id: 5, court_id: 1, status: 'confirmed', confirmed_at: new Date(), starts_at: start });
  assert.equal((await call('PATCH', '/api/bookings/:id/cancel', '3')).data.ok, true);
  assert.equal(bookings.get(3).status, 'cancelled', 'bấm Hủy mới ghi trạng thái hủy');
  assert.equal((await call('GET', '/api/bookings/mine')).data.length, 0, 'lịch sắp tới không chứa booking đã hủy');
  assert.equal(sqlSeen.filter(sql => /UPDATE bookings SET status='cancelled'/.test(sql)).length, 1);
  bookings.set(4, { id: 4, user_id: 5, court_id: 1, status: 'confirmed',
    confirmed_at: new Date(Date.now() - 86400000), starts_at: new Date(Date.now() - 3600000) });
  assert.equal((await call('PATCH', '/api/bookings/:id/cancel', '4')).statusCode, 403,
    'người chơi không hủy được booking đã hoàn thành');
  assert.equal((await call('PATCH', '/api/bookings/:id/cancel', '4', {}, { id: 1, role: 'admin' })).data.ok, true,
    'chủ sân có thể hủy booking đã hoàn thành');
  assert.ok(sqlSeen.some(sql=>sql.includes('FROM bookings WHERE id=$1 FOR UPDATE')), 'hủy phải khóa booking trước khi kiểm tra khoản thu');
  console.log('Booking cancellation: conflict, expiry and release do not persist; explicit cancellation persists OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
