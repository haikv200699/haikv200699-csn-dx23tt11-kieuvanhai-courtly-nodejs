// Integration test with an actual PostgreSQL WASM engine, no production database touched.
// npm install --no-save @electric-sql/pglite
// node test/pricing-sql-test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pkg = process.env.PGLITE_MODULE || '@electric-sql/pglite';
const { PGlite } = require(pkg);
const { btree_gist } = require(process.env.PGLITE_MODULE ? pkg + '/dist/contrib/btree_gist.cjs' : pkg + '/contrib/btree_gist');
const Pricing = require('../public/pricing.js');
const schema = fs.readFileSync(path.join(__dirname,'../db/schema.sql'),'utf8');
const migration = fs.readFileSync(path.join(__dirname,'../db/pricing.sql'),'utf8');
(async()=>{
  const db = new PGlite({ extensions:{btree_gist} });
  try {
    await db.exec("SET TIME ZONE 'Asia/Ho_Chi_Minh';"+schema);
    const config = (await db.query('SELECT config FROM pricing_settings')).rows[0].config;
    assert.deepEqual(config,Pricing.defaults);
    let comparisons=0;
    const expected = [
      ['2026-10-05','05:00','06:00',60000,50000],
      ['2026-10-05','16:30','17:30',80000,65000],
      ['2026-10-05','17:00','20:00',300000,240000],
      ['2026-10-05','19:30','20:30',90000,75000],
      ['2026-10-05','23:00','24:00',80000,70000],
      ['2026-10-03','05:00','06:00',80000,70000],
      ['2026-10-03','14:30','15:30',90000,75000],
      ['2026-10-04','15:00','16:00',100000,80000],
      ['2026-10-04','19:30','20:30',90000,75000]
    ];
    for(const [day,start,end,casual,fixed] of expected)for(const member of ['casual','fixed']){
      const a=`${day}T${start}:00+07:00`, b=`${day}T${end}:00+07:00`;
      const js=Pricing.quote(config,a,b,member);
      const sql=(await db.query('SELECT court_price_quote($1,$2,$3) quote',[a,b,member])).rows[0].quote;
      assert.equal(js.total, member==='fixed'?fixed:casual);
      assert.equal(sql.total,js.total); assert.equal(sql.standard,js.standard);
      assert.equal(sql.lines.length,js.lines.length); comparisons++;
    }
    const holiday={...config,holidays:['2026-10-05']};
    await db.query('UPDATE pricing_settings SET config=$1',[JSON.stringify(holiday)]);
    assert.equal((await db.query("SELECT court_price_quote('2026-10-05 14:30+07','2026-10-05 15:30+07','fixed') q")).rows[0].q.total,75000);
    await db.query('UPDATE pricing_settings SET config=$1',[JSON.stringify(config)]);
    for (const bad of [{...config,weekday:[]},{...config,weekday:[{...config.weekday[0],end:1000},...config.weekday.slice(1)]},{...config,holidays:['2026-02-30']},{...config,weekend:config.weekend.map(r=>({...r,fixed:-1}))}]) assert.throws(()=>Pricing.validate(bad));
    await db.exec("INSERT INTO users(id,email,password_hash,full_name,role,member_type) VALUES(700,'pricing-test@local','not-used','Test','user','fixed'); INSERT INTO courts(id,name,district,price_per_hour,open_time,close_time) VALUES(700,'Pricing test','',999999,'05:00','24:00');");
    const id=(await db.query("SELECT create_booking(700,700,'2026-10-05 16:30+07','2026-10-05 17:30+07','Test','0901234567','onsite') id")).rows[0].id;
    let b=(await db.query('SELECT * FROM bookings WHERE id=$1',[id])).rows[0];
    assert.equal(b.total_price,65000);assert.equal(b.standard_price,80000);assert.equal(b.discount_percent,0);assert.equal(b.pricing_snapshot.memberType,'fixed');
    await assert.rejects(()=>db.query("SELECT create_booking(700,700,'2026-10-05 17:00+07','2026-10-05 18:00+07','Test','0901234567','onsite')"),e=>e.code==='23P01' || /vừa được người khác/.test(e.message));
    await db.query("UPDATE bookings SET status='confirmed' WHERE id=$1",[id]);
    await db.query("INSERT INTO booking_addons(booking_id,kind,label,quantity,unit_price) VALUES($1,'product','Water',2,10000)",[id]);
    const totals=async()=> (await db.query('SELECT * FROM booking_invoice_totals WHERE booking_id=$1',[id])).rows[0];
    assert.equal(Number((await totals()).total),85000);
    await db.query("UPDATE bookings SET invoice_discount_type='percent',invoice_discount_value=10 WHERE id=$1",[id]);
    assert.equal(Number((await totals()).total),76500);
    await db.query('UPDATE bookings SET paid=true WHERE id=$1',[id]);
    assert.equal(Number((await totals()).paid_amount),58500);
    await db.query('UPDATE booking_addons SET paid=true WHERE booking_id=$1',[id]);
    assert.equal(Number((await totals()).paid_amount),76500);
    await db.query("INSERT INTO booking_addons(booking_id,kind,label,quantity,unit_price) VALUES($1,'product','Cake',1,15000)",[id]);
    assert.equal(Number((await totals()).total),90000);assert.equal(Number((await totals()).paid_amount),76500);
    await db.query('UPDATE bookings SET paid=false WHERE id=$1',[id]);await db.query('UPDATE booking_addons SET paid=false WHERE booking_id=$1',[id]);
    await db.query("UPDATE bookings SET invoice_discount_type='amount',invoice_discount_value=70000 WHERE id=$1",[id]);
    const lines=(await db.query('SELECT * FROM booking_charge_lines WHERE booking_id=$1 ORDER BY line_id',[id])).rows;
    assert.deepEqual(lines.map(l=>Number(l.net)),[0,15000,15000]);
    await db.query('UPDATE booking_addons SET paid=true WHERE booking_id=$1',[id]);
    assert.equal(Number((await totals()).paid_amount),30000);
    await db.query("UPDATE bookings SET invoice_discount_type='percent',invoice_discount_value=100 WHERE id=$1",[id]);
    assert.equal(Number((await totals()).total),0);
    // Re-running migrations must keep custom settings and historical snapshots.
    await db.query('UPDATE pricing_settings SET config=$1,version=2',[JSON.stringify(holiday)]);
    await db.exec(migration); await db.exec(migration);
    assert.equal((await db.query('SELECT version FROM pricing_settings')).rows[0].version,2);
    b=(await db.query('SELECT * FROM bookings WHERE id=$1',[id])).rows[0];assert.equal(b.total_price,65000);
    assert.equal(b.pricing_snapshot.total,65000);
    console.log(`Pricing SQL: ${comparisons} JS/Postgres comparisons; midnight, holiday, fixed hold, overlap constraint, invoice discounts/partial payments and idempotent migration OK`);
  }finally{await db.close();}
})().catch(err=>{console.error(err.message,err.detail||'',err.position||'');process.exitCode=1;});
