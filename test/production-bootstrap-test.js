const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
const begin = source.indexOf('async function bootstrapProductionAdmin() {');
const end = source.indexOf('\nasync function setup() {', begin);
assert.ok(begin >= 0 && end > begin);
assert.match(source.slice(end, source.indexOf('await waitForDatabase();', end)), /JWT_SECRET[\s\S]*DATABASE_URL/);
assert.match(source, /if \(isProduction\) \{\s*await bootstrapProductionAdmin\(\);\s*\} else if \(userCount === 0\)/);

async function run({ existing = 0, collision = false, email = 'OWNER@EXAMPLE.COM', password = 'unique-admin-pass-123' } = {}) {
  const calls = [];
  const pool = { async query(sql, args) {
    calls.push({ sql, args });
    if (sql.includes('count(*)')) return { rows: [{ n: existing }] };
    if (sql.startsWith('SELECT 1')) return { rowCount: collision ? 1 : 0 };
    return { rowCount: 1 };
  } };
  const bcrypt = { async hash(pass, rounds) { assert.equal(rounds, 12); return `hashed:${pass}`; } };
  const context = { pool, bcrypt, process: { env: { ADMIN_EMAIL: email, ADMIN_PASSWORD: password } }, console: { log() {} } };
  vm.runInNewContext(`${source.slice(begin, end)}; this.bootstrap = bootstrapProductionAdmin`, context);
  await context.bootstrap();
  return calls;
}

(async () => {
  const inserted = await run();
  assert.equal(inserted.length, 3);
  assert.deepEqual(Array.from(inserted[2].args), ['owner@example.com', 'hashed:unique-admin-pass-123', 'Quản trị viên', 'admin']);
  assert.equal((await run({ existing: 1 })).length, 1, 'restart must preserve existing admin');
  await assert.rejects(run({ password: 'admin123' }), /ADMIN_PASSWORD/);
  await assert.rejects(run({ email: 'invalid' }), /ADMIN_EMAIL/);
  await assert.rejects(run({ collision: true }), /đã thuộc tài khoản khác/);
  console.log('Production bootstrap: required secrets, one-time admin, no demo account OK');
})().catch((err) => { console.error(err); process.exitCode = 1; });
