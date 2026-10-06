const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const from = app.indexOf('function fmtMin(m) {');
const to = app.indexOf("$('#slots').addEventListener", from);
assert.ok(from >= 0 && to > from);
const tomorrow = new Date(Date.now() + 86400000);
tomorrow.setUTCHours(0, 0, 0, 0);
const date = tomorrow.toISOString().slice(0, 10);
const start = (minutes) => +new Date(`${date}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00+07:00`);
const slots = { innerHTML: '' };
let now = Date.now(), released = 0;
const state = {
  bk: { courtId: 1, date, selected: [480], booked: [
    { status: 'confirmed', start: start(480), end: start(510) },
    { status: 'pending', start: start(510), end: start(540) },
  ] },
  courts: [{ id: 1, open_time: '08:00', close_time: '09:30', under_maintenance: false }],
};
const context = {
  state, $: () => slots, hm: (value) => { const [h, m] = value.split(':'); return +h * 60 + +m; },
  toDate: (_day, minutes) => new Date(start(minutes)),
  releaseHold() { released++; state.bk.holdId = null; },
  renderDurationTotal() {}, renderBookingStages() {}, renderSummary() {}, Date: class extends Date { static now() { return now; } }, Set,
};
vm.runInNewContext(app.slice(from, to), context);
vm.runInNewContext('renderSlots()', context);
assert.match(slots.innerHTML, /class="slot booked" disabled aria-label="08:00 đã đặt"/);
assert.match(slots.innerHTML, /class="slot held" disabled aria-label="08:30 đang giữ chỗ"/);
assert.match(slots.innerHTML, /data-m="540"/);
assert.doesNotMatch(slots.innerHTML, /data-m="480"|data-m="510"/);
assert.deepEqual(Array.from(state.bk.selected), [], 'giờ vừa bị đặt không thể giữ trong lựa chọn');
now = start(510) + 1;
vm.runInNewContext('renderSlots()', context);
assert.doesNotMatch(slots.innerHTML, /08:00|08:30/, 'khi trang vẫn mở, giờ đã qua phải biến mất sau khi làm mới');
assert.match(slots.innerHTML, /09:00/);
state.bk.selected = [540]; state.bk.holdId = 44;
now = start(540) + 1;
vm.runInNewContext('renderSlots()', context);
assert.deepEqual(Array.from(state.bk.selected), []);
assert.equal(released, 2, 'lượt giữ chỗ với giờ đã qua được nhả');
assert.doesNotMatch(slots.innerHTML, /09:00/);
assert.match(app, /setInterval\(refreshSlotClock, 10000\)/);

const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
assert.match(css, /\.slot\.booked:disabled\{[^}]*background:/);
assert.match(css, /\.extras-dialog\{[^}]*overflow-y:auto;[^}]*touch-action:pan-y/);
assert.match(app, /prevent: \(node\) => !!node\?\.closest\?\.\('dialog\[open\], #scheduleViewport, #upcoming, \.amenity-grid'\)/);
console.log('Booking UI: booked and held slots disabled; dialog native wheel/touch scrolling enabled OK');
