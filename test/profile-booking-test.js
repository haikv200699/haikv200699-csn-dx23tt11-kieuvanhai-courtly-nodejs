const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const frontend = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const start = frontend.indexOf("$('#confirmBtn').onclick = async () => {");
const end = frontend.indexOf('// Hướng dẫn thanh toán theo booking', start);
assert.ok(start > 0 && end > start);

async function checkBooking() {
  const elements = new Map();
  const el = (key) => {
    if (!elements.has(key)) elements.set(key, { value: '', textContent: '', disabled: false, focus() { this.focused = true; } });
    return elements.get(key);
  };
  el('#playerName').value = 'Nguyễn An';
  el('#playerPhone').value = 'sai';
  const state = { user: { id: 1 }, bk: { selected: [540], holdId: 21, holdRangeKey: '1:540:570', holdExpiresAt: '2030-01-01' } };
  const calls = [], messages = [];
  let failure = null, released = 0, slots = 0;
  const context = {
    $: el, state, selectedRange: () => ({ start: 540, end: 570 }), document: {
      querySelector: () => ({ value: 'onsite' }),
    },
    api: async (url, options) => { calls.push({ url, options }); if (failure) throw failure; },
    toast: (message) => messages.push(message), openAuth() {}, stopCountdown() {},
    releaseHold() { released++; state.bk.holdId = null; state.bk.holdRangeKey = null; },
    renderSlots() { slots++; }, renderSummary() {}, fillPlayerDetails() {},
    loadBooked: async () => {}, loadMine: async () => {},
  };
  vm.runInNewContext('let confirmPending = false;\n' + frontend.slice(start, end), context);
  const confirm = el('#confirmBtn').onclick;
  await confirm();
  assert.equal(calls.length, 0, 'số điện thoại sai phải được kiểm tra trước API');
  assert.equal(state.bk.holdId, 21, 'số điện thoại sai không nhả giờ đang giữ');
  assert.equal(el('#playerPhone').focused, true);
  el('#playerPhone').value = '0912 345 678';
  failure = Object.assign(new Error('Dữ liệu cần sửa'), { status: 400 });
  await confirm();
  assert.equal(state.bk.holdId, 21, 'lỗi 400 không làm mất hold');
  assert.deepEqual(Array.from(state.bk.selected), [540]);
  assert.equal(calls[0].options.body.playerPhone, '0912345678');
  assert.equal(released, 0);
  failure = null;
  await confirm();
  assert.equal(calls.length, 2, 'khách được xác nhận lại chính hold cũ');
  assert.equal(state.bk.holdId, null);
  assert.deepEqual(Array.from(state.bk.selected), []);
  assert.ok(messages.includes('Đặt sân thành công'));
  state.bk.holdId = 22; state.bk.selected = [540];
  failure = Object.assign(new Error('Đã hết thời gian giữ chỗ'), { status: 410 });
  await confirm();
  assert.equal(released, 1, 'hold hết hạn được nhả');
  assert.equal(state.bk.holdId, null);
  assert.deepEqual(Array.from(state.bk.selected), []);
  assert.ok(slots >= 2);
}

async function checkProfile() {
  const routes = new Map(), queries = [];
  const app = {
    use() {}, get() {}, post(p, ...fn) { routes.set(`POST ${p}`, fn); },
    patch(p, ...fn) { routes.set(`PATCH ${p}`, fn); }, delete() {}, put() {},
  };
  const express = () => app;
  express.raw = express.json = express.static = () => () => {};
  class Pool {
    async query(sql, params) {
      queries.push({ sql, params });
      if(sql.includes('SELECT * FROM users WHERE id=$1')) return {rows:[{id:19,role:'user',session_version:0}]};
      if (sql.includes('INSERT INTO users')) return { rows: [{ id: 19, email: 'an@example.com', full_name: 'An', phone: '0912345678', role: 'user', avatar_key: params[4] }] };
      if (sql.includes('UPDATE users SET full_name')) return { rows: [{ id: params[0], email: 'an@example.com', full_name: params[1], phone: params[2], role: 'user', avatar_key: 'animal-7' }] };
      return { rows: [] };
    }
  }
  const source = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8').replace(/setup\(\)\s*\.then\([\s\S]*$/, '');
  vm.runInNewContext(source, {
    require(name) {
      if (name === 'express') return express;
      if (name === 'http') return { createServer: () => ({ on() {} }) };
      if (name === 'pg') return { Pool };
      if (name === 'socket.io') return { Server: class { on() {} emit() {} } };
      if (name === 'jsonwebtoken') return { sign: () => 'token', verify: () => ({ id: 19, role: 'user' }) };
      if (name === 'bcryptjs') return { hash: async () => 'hash' };
      return require(name);
    },
    __dirname: path.join(__dirname, '../server'), process, console,
    setInterval() {}, setTimeout, Date, Intl, Buffer,
  });
  async function call(method, url, body) {
    const res = { code: 200, status(n) { this.code = n; return this; }, json(data) { this.data = data; return this; } };
    const req = { headers: { authorization: 'Bearer token' }, body };
    for (const handler of routes.get(`${method} ${url}`)) await handler(req, res, err => { if (err) throw err; });
    return res;
  }
  const invalid = await call('PATCH', '/api/me', { fullName: 'An', phone: 'abc' });
  assert.equal(invalid.code, 400);
  assert.ok(!queries.some(q=>/UPDATE|INSERT/.test(q.sql)), 'dữ liệu sai không cập nhật DB');
  const updated = await call('PATCH', '/api/me', { fullName: '  An Mới ', phone: '0912 345 678' });
  assert.equal(updated.data.fullName, 'An Mới');
  assert.equal(updated.data.phone, '0912345678');
  assert.equal(updated.data.avatarKey, 'animal-7');
  assert.equal(queries.find(({ sql }) => sql.includes('UPDATE users SET full_name')).params[0], 19, 'chỉ sửa chính tài khoản trong token');
  const registered = await call('POST', '/api/auth/register', { email: 'an@example.com', password: '123456', fullName: 'An', phone: '0912345678' });
  assert.match(registered.data.user.avatarKey, /^animal-(?:[1-9]|10)$/);
  assert.match(queries.find(({ sql }) => sql.includes('INSERT INTO users')).params[4], /^animal-(?:[1-9]|10)$/);
  assert.match(frontend, /u\.role === 'admin' \? 'shuttlecock'/);
}

Promise.all([checkBooking(), checkProfile()]).then(() => {
  console.log('Booking: retry within hold, expiration; profile: validation, own account update and persisted avatar OK');
}).catch(err => { console.error(err); process.exitCode = 1; });
