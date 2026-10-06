const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
const courtGrid = { innerHTML: '' };
const context = vm.createContext({
  $: () => courtGrid, pricingConfig: require('../public/pricing.js').defaults,
  state: { bk: { courtId: 2 }, courts: [
    { id: 1, name: 'Sân 1', district: 'Quận 1', status: 'AVAILABLE', price_per_hour: 80000, under_maintenance: false },
    { id: 2, name: 'Sân 2', district: 'Quận 2', status: 'MAINTENANCE', price_per_hour: 90000, under_maintenance: true },
  ] },
  LABEL: { AVAILABLE: 'Còn trống', MAINTENANCE: 'Bảo trì' },
  esc: value => String(value), money: value => `${value}đ`,
});
const begin = app.indexOf('function renderBkCourts()');
const end = app.indexOf("$('#bkCourts').addEventListener", begin);
vm.runInContext(app.slice(begin, end) + '\nrenderBkCourts();', context);
assert.match(courtGrid.innerHTML, /Sân 1/);
assert.match(courtGrid.innerHTML, /60000đ <small>\/ giờ<\/small>/);
context.state.user = { role: 'user', memberType: 'fixed' };
vm.runInContext('renderBkCourts()', context);
assert.match(courtGrid.innerHTML, /50000đ <small>\/ giờ<\/small>/);
assert.match(courtGrid.innerHTML, /role="img" aria-label="Còn trống"/);
assert.doesNotMatch(courtGrid.innerHTML, /Quận 1|Quận 2|>Còn trống<|>Bảo trì</);
assert.match(courtGrid.innerHTML, /data-c="2" aria-pressed="true" disabled/);
assert.match(css, /\.cc \.top\{display:flex;align-items:center;justify-content:space-between/);
assert.match(css, /\.cc \.status\{display:block;width:9px;height:9px/);
assert.match(css, /\.cc \.price\{display:flex;align-items:baseline;flex-wrap:wrap/);
assert.match(css, /\.cc\.sel\{border-color:var\(--lime\)/);
assert.doesNotMatch(css, /\.cc:disabled\{opacity:/);
assert.match(css, /@media\(max-width:1100px\)\{\s*nav\{display:flex/);
console.log('Court card: compact layout, readable price, clear selection and status dot OK');
