const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
const elements = new Map();
const $ = key => {
  if (!elements.has(key)) elements.set(key, {
    textContent: '', innerHTML: '', hidden: false, disabled: false, value: '',
    classList: { toggle() {} },
    elements: Object.assign([{disabled:false}], {type:{value:''}, value:{value:''}}),
    querySelector() { return { disabled: false }; },
    addEventListener(type, cb) { this[type] = cb; },
  });
  return elements.get(key);
};
const booking = { id: 89, court_name: 'Sân 2', player_name: 'minh', player_phone: '0988888888',
  status: 'confirmed', paid: true, starts_at: '2026-09-30T01:00:00Z', ends_at: '2026-09-30T06:00:00Z',
  confirmed_at: '2026-09-26T00:41:00Z' };
const context = vm.createContext({
  can: () => true, canCollect: () => true, renderBookingEdit() {},
  tariffDescription: () => 'Giá theo khung giờ', tariffLines: () => '', previewInvoiceDiscount() {},
  $, TZ: 'Asia/Ho_Chi_Minh', Date, Intl,
  extrasBookingId: '89', extrasBill: null, state: { user: { role: 'admin' } },
  api: async () => ({ booking, base: 400000, total: 400000, paidAmount: 400000, due: 0, addons: [] }),
  fmtT: iso => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' }),
  playTimeText: () => '30:09 • 08:00 - 13:00 (5 giờ)',
  money: amount => `${amount}đ`, esc: value => String(value),
});
const begin = app.indexOf('async function reloadBookingExtras()');
const end = app.indexOf('function refreshBookingViews()', begin);
vm.runInContext(app.slice(begin, end), context);
(async () => {
  await vm.runInContext('reloadBookingExtras()', context);
  assert.equal($('#extrasBookingCode').textContent, 'BOOKING #89');
  assert.equal($('#extrasPlacedAt').textContent, '07:41 · 26/09/26');
  assert.equal($('#extrasTitle').textContent, 'Sân 2 · 30:09 • 08:00 - 13:00 (5 giờ)');
  assert.equal($('#extrasMeta').textContent, 'minh · 0988888888');
  assert.equal($('#extrasPaidTag').hidden, false);

  const product = html.match(/<form id="extrasProductForm"[\s\S]*?<\/form>/)?.[0];
  assert.ok(product);
  assert.doesNotMatch(product, /extras-paid-option|name="paid"/);
  assert.match(product, /data-extras-quantity="-1"/);
  assert.match(product, /data-extras-quantity="1"/);
  assert.match(html, /class="sheet-close extras-close"[^>]+id="extrasClose" aria-label="Đóng chi tiết booking"/);
  assert.match(css, /\.extras-head \.extras-close\{position:absolute;top:0;right:0/);
  assert.doesNotMatch(html, /id="chart"|<h4>7 ngày gần nhất<\/h4>/);
  assert.match(html, /id="revChart"/);
  assert.match(css, /@media\(max-width:520px\)\{\.extras-product-form\{grid-template-columns:minmax\(0,1fr\) 132px\}/);

  const quantityInput = { value: '1' };
  const quantityForm = { elements: { quantity: quantityInput }, addEventListener(type, cb) { this[type] = cb; } };
  context.$ = key => key === '#extrasProductForm' ? quantityForm : $(key);
  const clickBegin = app.indexOf("$('#extrasProductForm').addEventListener('click'");
  const clickEnd = app.indexOf("$('#extrasExtendForm').addEventListener", clickBegin);
  vm.runInContext(app.slice(clickBegin, clickEnd), context);
  const tap = delta => quantityForm.click({ target: { closest: () => ({ dataset: { extrasQuantity: String(delta) } }) } });
  tap(-1); assert.equal(quantityInput.value, '1');
  tap(1); assert.equal(quantityInput.value, '2');
  quantityInput.value = '100'; tap(1); assert.equal(quantityInput.value, '100');
  console.log('Booking detail header, clean add-on form, quantity controls, and weekly chart removal OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
