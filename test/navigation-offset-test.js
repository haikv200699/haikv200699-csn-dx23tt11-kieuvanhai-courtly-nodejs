// Điều hướng tới mục không bị menu cố định che ở các chiều cao menu khác nhau.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const begin = app.indexOf('function goto(sel) {');
const end = app.indexOf('\n}', begin) + 2;
const nav = { height: 64, bottom: null, getBoundingClientRect() { return { height: this.height, ...(this.bottom === null ? {} : { bottom: this.bottom }) }; } };
const target = { getBoundingClientRect() { return { top: 300 }; } };
const results = [];
const ctx = vm.createContext({
  $: selector => selector === 'nav' ? nav : target,
  window: { scrollY: 800, scrollTo: options => results.push(options) },
  lenis: { scrollTo: value => results.push(value) }, reduce: false, Math,
});
vm.runInContext(app.slice(begin, end), ctx);
vm.runInContext("goto('#booking')", ctx);
assert.equal(results.pop(), 1016, 'desktop nav 64 px để lại khoảng trống 20 px');
nav.height = 118;
vm.runInContext("goto('#booking')", ctx);
assert.equal(results.pop(), 962, 'tablet nav cao hơn được trừ khỏi vị trí cuộn');
vm.runInContext("lenis = null; goto('#booking')", ctx);
assert.equal(results.pop().top, 962, 'cuộn mặc định cũng tính chiều cao menu');
nav.bottom = 106;
vm.runInContext("lenis = null; goto('#booking')", ctx);
assert.equal(results.pop().top, 974, 'thiết bị có safe area tính cả vị trí thanh điều hướng');
console.log('Navigation offset: desktop and tablet fixed headers stay clear OK');
