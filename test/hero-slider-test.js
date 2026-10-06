const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const start = source.indexOf('const HERO_SLIDES = [');
const end = source.indexOf('// ---------- auth ----------', start);
assert.ok(start > 0 && end > start);

function createSlider(reduce) {
  const nodes = new Map(), slides = [], dots = [], events = new Map(), timers = [];
  const node = (name) => {
    if (!nodes.has(name)) nodes.set(name, {
      textContent: '', innerHTML: '', hidden: false,
      addEventListener(type, fn) { events.set(`${name}:${type}`, fn); },
      closest() { return node('hero'); },
    });
    return nodes.get(name);
  };
  for (let i = 0; i < 3; i++) {
    const child = { dataset: { i: String(i) }, classList: { toggle(name, value) { this[name] = value; } },
      setAttribute(name, value) { this[name] = value; } };
    slides.push(child);
    dots.push({ ...child, classList: { toggle(name, value) { this[name] = value; } },
      setAttribute(name, value) { this[name] = value; } });
  }
  const document = {
    hidden: false,
    querySelectorAll(selector) { return selector === '.hc-slide' ? slides : dots; },
    addEventListener(type, fn) { events.set(`document:${type}`, fn); },
  };
  vm.runInNewContext(source.slice(start, end), {
    $: node, document, reduce,
    setInterval(fn) { timers.push(fn); return timers.length; }, clearInterval() {},
    String,
  });
  return { node, slides, dots, events, timers };
}

const slider = createSlider(false);
assert.equal(slider.node('#hcCardIndex').textContent, '01 / 03');
slider.node('#hcNext').onclick();
assert.equal(slider.node('#hcCardIndex').textContent, '02 / 03');
assert.equal(slider.node('#hcCardTitle').textContent, 'Khách hàng thân thiết');
assert.equal(slider.slides[1]['aria-hidden'], 'false');
assert.equal(slider.dots[1]['aria-pressed'], 'true');
slider.events.get('#heroCarousel:touchstart')({ changedTouches: [{ clientX: 240, clientY: 150 }] });
slider.events.get('#heroCarousel:touchend')({ changedTouches: [{ clientX: 100, clientY: 164 }] });
assert.equal(slider.node('#hcCardIndex').textContent, '03 / 03', 'vuốt ngang chuyển slide');
slider.events.get('#heroCarousel:touchstart')({ changedTouches: [{ clientX: 100, clientY: 150 }] });
slider.events.get('#heroCarousel:touchend')({ changedTouches: [{ clientX: 90, clientY: 280 }] });
assert.equal(slider.node('#hcCardIndex').textContent, '03 / 03', 'vuốt dọc giữ cuộn trang');
assert.equal(createSlider(true).timers.length, 0, 'giảm chuyển động tắt tự chạy');
console.log('Hero slider: buttons, dots, touch gestures and reduced motion OK');
