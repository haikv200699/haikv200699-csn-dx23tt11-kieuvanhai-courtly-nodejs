const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
const begin = source.indexOf('function initTodayRail() {');
const end = source.indexOf('function initMotion() {', begin);
assert.ok(begin > 0 && end > begin);
let now = 0, nextId = 0;
const frames = new Map(), events = new Map(), captured = new Set(), timeouts = [];
const classes = new Set(['has-more']);
const rail = {
  scrollTop: 0, scrollHeight: 2000, clientHeight: 600,
  classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name) },
  addEventListener(type, callback) { events.set(type, callback); },
  setPointerCapture(id) { captured.add(id); },
  hasPointerCapture(id) { return captured.has(id); },
  releasePointerCapture(id) { captured.delete(id); },
  scrollBy({ top }) { this.scrollTop += top; },
};
const ctx = vm.createContext({
  $: () => rail, reduce: false,
  matchMedia: () => ({ matches: true }),
  performance: { now: () => now },
  requestAnimationFrame(callback) { frames.set(++nextId, callback); return nextId; },
  cancelAnimationFrame(id) { frames.delete(id); },
  setTimeout(callback) { timeouts.push(callback); },
});
vm.runInContext(source.slice(begin, end) + '\ninitTodayRail();', ctx);
const pointer = (type, y, pointerType = 'mouse') => events.get(type)({ type, pointerId: 1, pointerType, button: 0, clientY: y });
const step = () => { now += 16; const list = [...frames.values()]; frames.clear(); list.forEach(callback => callback(now)); };
pointer('pointerdown', 400);
now += 16;
pointer('pointermove', 200);
const releasedAt = rail.scrollTop;
pointer('pointerup', 200);
assert.ok(frames.size > 0, 'kéo dọc nhanh tiếp tục trôi sau khi thả');
let blocked = false;
events.get('click')({ preventDefault() { blocked = true; }, stopImmediatePropagation() {} });
assert.ok(blocked, 'kéo không vô tình mở chi tiết booking');
timeouts.splice(0).forEach(callback => callback());
step();
assert.ok(rail.scrollTop > releasedAt, 'quán tính theo hướng kéo');
for (let i = 0; i < 150 && frames.size; i++) step();
assert.equal(frames.size, 0);
assert.ok(rail.scrollTop <= 1400);
rail.scrollTop = 0;
let prevented = false;
events.get('wheel')({ deltaY: 240, deltaMode: 0, preventDefault() { prevented = true; } });
assert.ok(prevented);
assert.equal(rail.scrollTop, 0, 'con lăn không nhảy đột ngột');
step();
assert.ok(rail.scrollTop > 0 && rail.scrollTop < 240);
for (let i = 0; i < 100 && frames.size; i++) step();
rail.scrollTop = 1400;
prevented = false;
events.get('wheel')({ deltaY: 180, deltaMode: 0, preventDefault() { prevented = true; } });
assert.equal(prevented, false, 'đến cuối danh sách trả con lăn về trang');
pointer('pointerdown', 400, 'touch');
assert.equal(frames.size, 0, 'cảm ứng dùng cuộn native');
assert.match(css, /\.today-rail\{[^}]*touch-action:pan-y/);
console.log('Today rail: vertical inertia, wheel easing, click guard, boundary and native touch OK');
