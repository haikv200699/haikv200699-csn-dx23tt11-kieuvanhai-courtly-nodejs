const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
const begin = source.indexOf('function initAmenityRail() {');
const end = source.indexOf('function initMotion() {', begin);
assert.ok(begin > 0 && end > begin);
assert.doesNotMatch(css.match(/\.amenity-grid\{[^}]+\}/)[0], /scroll-snap-type/, 'dải tiện ích không ép dừng giữa quán tính');

let now = 0, nextId = 0;
const frames = new Map(), events = new Map(), captured = new Set();
const card = { tabIndex: -1 };
const rail = {
  scrollLeft: 0, scrollWidth: 1800, clientWidth: 600,
  addEventListener(type, callback) { events.set(type, callback); },
  querySelectorAll(selector) { return selector === '.amenity' ? [card] : []; },
  querySelector() { return { getBoundingClientRect: () => ({ width: 200 }) }; },
  getBoundingClientRect() { return { left: 0, width: 600 }; },
  setPointerCapture(id) { captured.add(id); },
  hasPointerCapture(id) { return captured.has(id); },
  releasePointerCapture(id) { captured.delete(id); },
  scrollBy({ left }) { this.scrollLeft += left; },
  classList: { add() {}, remove() {} },
};
const context = vm.createContext({
  document: { querySelector: () => rail },
  window: { addEventListener() {} },
  performance: { now: () => now },
  requestAnimationFrame(callback) { frames.set(++nextId, callback); return nextId; },
  cancelAnimationFrame(id) { frames.delete(id); },
  matchMedia: () => ({ matches: true }),
  setTimeout() {},
  reduce: false,
});
vm.runInContext(source.slice(begin, end) + '\ninitAmenityRail();', context);
const pointer = (type, x, pointerType = 'mouse') => events.get(type)({ type, pointerId: 1, pointerType, button: 0, clientX: x });
assert.equal(events.has('click'), false, 'tiện ích không còn sự kiện mở popup');
assert.equal(card.tabIndex, 0, 'vẫn có thể focus carousel bằng bàn phím');
const step = () => {
  now += 16;
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach(callback => callback(now));
};

pointer('pointerdown', 400);
now += 16;
pointer('pointermove', 240);
const releasedAt = rail.scrollLeft;
pointer('pointerup', 240);
assert.ok(frames.size > 0, 'kéo nhanh tiếp tục chạy sau khi thả');
step();
assert.ok(rail.scrollLeft > releasedAt, 'quán tính đi theo hướng kéo');
for (let i = 0; i < 150 && frames.size; i++) step();
assert.equal(frames.size, 0, 'quán tính dừng sau khi giảm tốc');
assert.ok(rail.scrollLeft <= 1200, 'không cuộn quá mép');

pointer('pointerdown', 400);
now += 160;
pointer('pointermove', 392);
now += 150;
pointer('pointerup', 392);
assert.equal(frames.size, 0, 'giữ yên trước khi thả không tạo quán tính');

rail.scrollLeft = 0;
let prevented = false;
events.get('wheel')({ deltaX: 0, deltaY: 250, deltaMode: 0, preventDefault() { prevented = true; } });
assert.ok(prevented);
assert.equal(rail.scrollLeft, 0, 'con lăn không nhảy trực tiếp');
step();
assert.ok(rail.scrollLeft > 0 && rail.scrollLeft < 250, 'con lăn dịch chuyển theo chuyển động dịu');
for (let i = 0; i < 100 && frames.size; i++) step();
assert.ok(Math.abs(rail.scrollLeft - 250) < 1);

pointer('pointerdown', 400);
now += 16;
pointer('pointermove', 150);
pointer('pointerup', 150);
assert.ok(frames.size > 0);
pointer('pointerdown', 400, 'touch');
assert.equal(frames.size, 0, 'vuốt cảm ứng hủy chuyển động lập trình để dùng quán tính trình duyệt');
for (const key of ['Enter', ' ']) {
  events.get('keydown')({ key, preventDefault() { assert.fail('không chặn Enter/Space để mở popup'); } });
}
const beforeArrow = rail.scrollLeft;
events.get('keydown')({ key: 'ArrowRight', preventDefault() {} });
assert.equal(rail.scrollLeft, beforeArrow + 200, 'phím mũi tên vẫn di chuyển carousel');
console.log('Facility motion: no popup, keyboard navigation, inertia, wheel smoothing and touch handoff OK');
