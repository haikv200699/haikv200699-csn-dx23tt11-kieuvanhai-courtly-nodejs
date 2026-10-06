const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
const classes = () => {
  const values = new Set();
  return { contains: v => values.has(v), add: v => values.add(v), remove: v => values.delete(v), toggle(v, on) {
    if (on === undefined) on = !values.has(v);
    on ? values.add(v) : values.delete(v);
    return on;
  } };
};
const sections = Object.fromEntries(['facility', 'assign', 'booking', 'mine', 'admin'].map(id => [id, {
  hidden: false, top: 900, getBoundingClientRect() { return { top: this.top }; },
}]));
const links = Object.keys(sections).map(id => ({
  hidden: false, classList: classes(), attrs: {},
  getAttribute: name => name === 'href' ? `#${id}` : null,
  setAttribute(name, value) { this.attrs[name] = value; },
  removeAttribute(name) { delete this.attrs[name]; },
}));
const nav = { classList: classes(), getBoundingClientRect: () => ({ height: 64 }) };
const profileBtn = { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
const dialog = { open: false, showModal() { this.open = true; } };
let viewportWidth = 375;
const elements = { nav, '#profileBtn': profileBtn, '#profileDlg': dialog, '#profileQuickMenu': { hidden: true },
  '#profileAvatar': {}, '#profileTitle': {}, '#profileViewPhone': {},
  '#profileViewEmail': {}, '#profileOverview': {}, '#profileForm': {},
  '#profileEdit': {}, '#profileErr': {}, '#profileMenuAccount': {},
  '#profileMenuPlayers': {}, '#profileDesktopPlayers': {}, '#profileDesktopAccount': { focus() {} },
  '#profileMemberRow': {}, '#profileViewMember': {},
};
const events = {};
const context = vm.createContext({
  $: key => key.startsWith('#') && sections[key.slice(1)] ? sections[key.slice(1)] : elements[key],
  document: {
    querySelectorAll: () => links,
    addEventListener(type, cb) { events[type] = cb; },
  },
  window: { addEventListener(type, cb) { events[`window:${type}`] = cb; } },
  requestAnimationFrame: cb => cb(),
  matchMedia: query => ({ matches: viewportWidth <= Number(query.match(/max-width:(\d+)px/)?.[1] || 0) }),
  state: { user: { fullName: 'Linh', phone: '0912345678', email: 'linh@example.com', role: 'user', avatarKey: 'animal-3' } },
  goto() {},
});
vm.runInContext(app.slice(app.indexOf('const navSectionLinks ='), app.indexOf('// ---------- hero carousel')), context);
vm.runInContext(app.slice(app.indexOf('const avatarUrl ='), app.indexOf("$('#profileEdit').onclick")), context);

sections.facility.top = -80;
events['window:scroll']();
assert.equal(links[0].attrs['aria-current'], 'location');
sections.booking.top = 80;
events['window:scroll']();
assert.equal(links[2].attrs['aria-current'], 'location');
assert.equal(links[0].attrs['aria-current'], undefined);
sections.booking.hidden = true;
events['window:scroll']();
assert.equal(links[2].attrs['aria-current'], undefined, 'ẩn mục không được đánh dấu đang xem');

profileBtn.onclick();
assert.equal(nav.classList.contains('menu-open'), true);
assert.equal(profileBtn.attrs['aria-expanded'], 'true');
assert.equal(dialog.open, false, 'mobile mở menu trước khi mở hồ sơ');
viewportWidth = 800;
events['window:resize']();
assert.equal(nav.classList.contains('menu-open'), true, 'xoay màn hình trong chế độ compact không tự đóng menu');
viewportWidth = 901;
events['window:resize']();
assert.equal(nav.classList.contains('menu-open'), false, 'qua breakpoint đóng menu cũ');
viewportWidth = 375;
events['window:resize']();
profileBtn.onclick();
elements['#profileMenuAccount'].onclick();
assert.equal(nav.classList.contains('menu-open'), false);
assert.equal(dialog.open, true);
assert.equal(elements['#profileTitle'].textContent, 'Linh');
profileBtn.onclick();
events.click({ target: { closest: () => null } });
assert.equal(nav.classList.contains('menu-open'), false, 'chạm ngoài menu sẽ đóng');

assert.doesNotMatch(html, /id="navProfileName"/);
assert.match(css, /\.links a\.is-active\{color:var\(--lime\)/);
assert.match(css, /body\.signed-in nav\.menu-open \.nav-section-links\{display:flex\}/);
assert.match(css, /@media\(max-width:900px\)\{\s*nav\{inset:8px 8px auto/);
assert.match(css, /body\.signed-in \.nav-section-links\{[^}]*touch-action:pan-y/);
assert.match(css, /@media\(max-width:390px\)\{\s*nav b\{font-size:22px/);
assert.match(css, /\.schedule-wrap\{[^}]*touch-action:pan-x pan-y/);
assert.match(css, /\.schedule-wrap\{scroll-snap-type:none/);
assert.match(css, /\.schedule-column\{width:calc\(100cqw\/3\)/);
assert.match(app, /if \(e\.pointerType === 'touch'\) return;/);
console.log('Mobile avatar menu, section highlight, and three-column touch schedule OK');
