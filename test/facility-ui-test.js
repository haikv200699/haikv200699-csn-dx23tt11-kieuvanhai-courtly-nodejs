const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const facility = html.match(/<section class="pad" id="facility">[\s\S]*?<\/section>/)?.[0];
assert.ok(facility);
assert.equal((facility.match(/<article class="amenity"/g) || []).length, 9);
assert.equal((facility.match(/class="amenity-photo"/g) || []).length, 9);
assert.doesNotMatch(facility, /am-ic/);
assert.match(css, /\.amenity-grid\{display:flex;gap:16px;overflow-x:auto;overflow-y:hidden/);
assert.match(css, /\.amenity\{flex:0 0 calc\(\(100% - 32px\)\/3\)/);
assert.match(css, /\.amenity-grid::-webkit-scrollbar\{display:none\}/);
assert.match(css, /@media\(max-width:760px\)\{[\s\S]*?\.amenity-grid\{gap:12px/);
assert.match(css, /background-image:url\('\/images\/courtly-amenities\.webp'\)/);
assert.match(appJs, /function initAmenityRail\(\)/);
assert.match(appJs, /rail\.addEventListener\('wheel'/);
assert.match(appJs, /rail\.addEventListener\('pointermove'/);
assert.match(appJs, /photo\.style\.setProperty\('--parallax-x'/);
assert.doesNotMatch(facility, /amenity-swipe-hint/);
assert.match(css, /\.hc-eyebrow\{[^}]*justify-self:start;width:max-content/);
const image = path.join(root, 'public/images/courtly-amenities.webp');
assert.ok(fs.statSync(image).size < 400000, 'ảnh dùng chung đủ nhẹ cho điện thoại');
assert.doesNotMatch(html, /name="district"/);
assert.doesNotMatch(appJs, /c\.district|b\.district|court\.district/);

const routes = new Map(), queries = [];
const mockApp = { use() {}, get() {}, post(route, ...callbacks) { routes.set(`POST ${route}`, callbacks.at(-1)); },
  patch(route, ...callbacks) { routes.set(`PATCH ${route}`, callbacks.at(-1)); }, delete() {}, put() {} };
const express = () => mockApp;
express.raw = express.json = express.static = () => () => {};
class Pool {
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (/INSERT INTO courts/.test(sql)) return { rows: [{ id: 7, name: params[0], district: params[1] }] };
    if (/UPDATE courts SET name=/.test(sql)) return { rows: [{ id: params[0], name: params[1], district: params[2] }] };
    return { rows: [], rowCount: 0 };
  }
}
class Server { on() {} emit() {} }
const server = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8').replace(/setup\(\)\s*\.then\([\s\S]*$/, '');
vm.runInNewContext(server, {
  require(name) {
    if (name === 'express') return express;
    if (name === 'http') return { createServer: () => ({ on() {} }) };
    if (name === 'pg') return { Pool };
    if (name === 'socket.io') return { Server };
    if (name === 'jsonwebtoken') return { sign() {}, verify() {} };
    if (name === 'bcryptjs') return {};
    return require(name);
  }, __dirname: path.join(root, 'server'), process, console, setInterval() {}, setTimeout, Date, Intl, Buffer,
});
async function call(method, route, body, id = '7') {
  const handler = routes.get(`${method} ${route}`);
  const result = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
  await handler({ params: { id }, body, user: { role: 'admin' } }, result, error => { throw error; });
  return result;
}
(async () => {
  const body = { name: 'Sân 7', pricePerHour: 80000, openTime: '06:00', closeTime: '23:00' };
  const added = await call('POST', '/api/admin/courts', body);
  assert.equal(added.code, 201);
  assert.equal(queries.find(({ sql }) => /INSERT INTO courts/.test(sql)).params[1], '');
  const edited = await call('PATCH', '/api/admin/courts/:id', body);
  assert.equal(edited.code, 200);
  assert.equal(queries.find(({ sql }) => /UPDATE courts SET name=/.test(sql)).params[2], null);
  console.log('Facility horizontal rail, image parallax, compact eyebrow, and courts without district OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
