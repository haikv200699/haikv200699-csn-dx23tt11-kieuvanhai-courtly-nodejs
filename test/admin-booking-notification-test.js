// Booking mới: chấm báo thuộc Lịch đặt sân, mỗi booking phát một âm báo sau tương tác đầu tiên.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
assert.match(html, /id="nav-mine"[^>]*><span id="navMineLabel">[^<]*<\/span><span class="notif-dot" id="admNotifDot"/);
assert.doesNotMatch(html, /id="nav-admin"[^>]*>[^<]*<span class="notif-dot"/);
assert.match(app, /\$\('#navMineLabel'\)\.textContent = isAdm/,
  'cập nhật tên mục không xóa mất chấm báo');
assert.match(css, /body\.signed-in \.nav-section-links \.notif-dot\{top:50%;right:12px/,
  'chấm báo nằm trong hàng Lịch đặt sân trên mobile');

const handlers = new Map(), starts = [], calls = [];
const elements = new Map();
const $ = id => {
  if (!elements.has(id)) elements.set(id, {
    hidden: true, textContent: '', attrs: {},
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(name, listener) { handlers.set(`${id}:${name}`, listener); },
  });
  return elements.get(id);
};
class AudioContext {
  constructor() { this.state = 'suspended'; this.currentTime = 1; this.destination = {}; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  createOscillator() {
    return { frequency: { setValueAtTime() {} }, connect() {}, start(time) { starts.push(time); }, stop() {} };
  }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
}
const state = { user: { role: 'admin' }, adm: { unread: 0, newIds: new Set() } };
const context = vm.createContext({
  can: key => require('../public/permissions').can(state.user,key),
  $, state, window: { AudioContext }, document: { addEventListener(name, listener) { handlers.set(name, listener); } },
  Promise, Date, String, fmtT: () => '08:00',
  toast: msg => calls.push(['toast', msg]),
  loadMine: async () => calls.push(['mine']),
  loadAdminSchedule: () => calls.push(['schedule']),
  loadAdmin: () => calls.push(['admin']),
});
const start = app.indexOf('// ---- thông báo booking mới + lịch sân ----');
const end = app.indexOf('let admScheduleData = null;', start);
assert.ok(start >= 0 && end > start);
vm.runInContext(app.slice(start, end), context);

(async () => {
  handlers.get('pointerdown')();
  const booking = { id: 42, playerName: 'Lan', courtName: 'Court 01', startsAt: new Date().toISOString() };
  context.onAdminNewBooking(booking);
  assert.equal(state.adm.unread, 1);
  assert.equal($('#admNotifDot').hidden, false);
  assert.equal($('#admNotifDot').textContent, 1);
  assert.match($('#nav-mine').attrs['aria-label'], /1 booking mới/);
  assert.equal(starts.length, 2, 'một booking có hai nốt nhạc nhẹ');
  context.onAdminNewBooking(booking);
  assert.equal(state.adm.unread, 1, 'socket phát lặp không cộng thông báo hai lần');
  assert.equal(starts.length, 2, 'socket phát lặp không đánh chuông hai lần');

  handlers.get('#nav-admin:click')();
  assert.equal(state.adm.unread, 1, 'mở Quản trị không đánh dấu booking đã xem');
  handlers.get('#nav-mine:click')();
  await Promise.resolve();
  assert.equal(state.adm.unread, 0, 'mở Lịch đặt sân đánh dấu booking đã xem');
  assert.equal($('#admNotifDot').hidden, true);
  assert.ok(calls.some(c => c[0] === 'mine'), 'lịch được làm mới khi mở');

  state.user.role = 'user';
  context.onAdminNewBooking({ ...booking, id: 43 });
  assert.equal(state.adm.unread, 0, 'người chơi không nhận thông báo của admin');
  assert.equal(starts.length, 2);
  console.log('New booking notification: admin booking link, unread state, deduplication and chime OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
