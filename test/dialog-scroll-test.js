const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

for (const id of ['accountsDlg', 'accountsScroll', 'accEditDlg']) {
  assert.match(html, new RegExp(`id="${id}"[^>]*data-lenis-prevent`), `${id} must preserve native wheel/touch events`);
}
assert.match(html, /id="accountsScroll"[^>]*tabindex="0"/, 'keyboard can focus account scroller');
assert.match(css, /\.accounts-dialog\{[^}]*overflow:hidden/);
assert.match(css, /\.accounts-shell\{[^}]*flex-direction:column;[^}]*height:100%/);
assert.match(css, /\.accounts-body\{[^}]*flex:1 1 0;min-height:0;overflow-y:auto;[^}]*touch-action:pan-y/,
  'the inner area must be the scroll container inside a fixed-height dialog');
assert.match(css, /\.account-edit-dialog\{[^}]*overflow-y:auto;[^}]*touch-action:pan-y/);

let config;
class Lenis { constructor(options) { config = options; } on() {} raf() {} }
const timeline = { from() { return this; } };
const gsap = { registerPlugin() {}, ticker: { add() {}, lagSmoothing() {} }, timeline: () => timeline, to() {} };
const start = app.indexOf('function initMotion() {');
const end = app.indexOf('// ---------- boot ----------', start);
assert.ok(start >= 0 && end > start);
vm.runInNewContext(`let lenis; ${app.slice(start, end)} initMotion();`, {
  motion: true, Lenis, gsap, ScrollTrigger: { update() {} },
  matchMedia: () => ({ matches: false }), document: { querySelectorAll: () => [] },
});
assert.equal(typeof config.prevent, 'function');
const within = (selector) => ({ closest(query) {
  return query.includes(selector) ? { id: selector } : null;
} });
assert.ok(config.prevent(within('dialog[open]')), 'wheel in account or other open modal stays native');
assert.ok(config.prevent(within('#scheduleViewport')), 'schedule grid keeps its own scroll');
assert.ok(config.prevent(within('.amenity-grid')), 'amenities rail keeps its own scroll');
assert.equal(config.prevent(within('.page-content')), false, 'ordinary page scroll still uses Lenis');
console.log('Dialog scroll: fixed-height flex viewport, native wheel/touch in every open modal, page motion isolated OK');
