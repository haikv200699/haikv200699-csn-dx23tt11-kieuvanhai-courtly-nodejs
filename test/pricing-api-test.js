// API handlers + actual SQL, including upgrade from the previous v19 schema.
// npm install --no-save @electric-sql/pglite && node test/pricing-api-test.js
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const pkg=process.env.PGLITE_MODULE || '@electric-sql/pglite';
const {PGlite}=require(pkg);
const {btree_gist}=require(process.env.PGLITE_MODULE ? pkg+'/dist/contrib/btree_gist.cjs':pkg+'/contrib/btree_gist');
const Pricing=require('../public/pricing.js');
(async()=>{
 const db=new PGlite({extensions:{btree_gist}}), routes=new Map();
 try{
  await db.exec("SET TIME ZONE 'Asia/Ho_Chi_Minh';"+fs.readFileSync(path.join(__dirname,'fixtures/schema-v19.sql'),'utf8'));
  await db.exec(`INSERT INTO users(id,email,password_hash,full_name,phone,role,member_type) VALUES
    (900,'admin-test@local','not-used','Admin','0900000000','admin','casual'),(901,'user-test@local','not-used','Fixed player','0901234567','user','fixed');
    INSERT INTO courts(id,name,district,price_per_hour,open_time,close_time) VALUES(900,'API Test','',80000,'05:00','24:00');
    INSERT INTO bookings(id,court_id,user_id,starts_at,ends_at,status,total_price,standard_price,discount_percent,player_name,player_phone,payment_method,paid)
    VALUES(900,900,901,'2026-01-05 08:00+07','2026-01-05 09:00+07','confirmed',72000,80000,10,'Fixed player','0901234567','onsite',false);`);
  const query=async(sql,args=[])=>{
   if(args.length){const r=await db.query(sql,args);return {...r,rowCount:/^\s*(SELECT|WITH)/i.test(sql) ? r.rows.length : (r.affectedRows ?? r.rows.length)};}
   const results=await db.exec(sql);const r=results.at(-1)||{rows:[]};return {...r,rowCount:/^\s*(SELECT|WITH)/i.test(sql) ? r.rows.length : (r.affectedRows ?? r.rows.length)};
  };
  class Pool{query(...a){return query(...a);}async connect(){return {query,release(){}};}}
  const app={use(){}};for(const method of ['get','post','patch','put','delete'])app[method]=(p,...f)=>routes.set(method.toUpperCase()+' '+p,f.at(-1));
  const express=()=>app;express.json=express.raw=express.static=()=>()=>{};
  const context=vm.createContext({require(name){
   if(name==='pg')return {Pool};if(name==='express')return express;
   if(name==='http')return {createServer:()=>({on(){}})};if(name==='socket.io')return {Server:class{on(){}emit(){}}};
   if(name==='jsonwebtoken')return {sign(){},verify(){}};if(name==='bcryptjs')return {};
   return require(name);
  },__dirname:path.join(__dirname,'../server'),process:{env:{NODE_ENV:'production',JWT_SECRET:'a'.repeat(40),DATABASE_URL:'test-only'},exit(){throw Error('Unexpected exit');}},console,Date,Intl,Buffer,setTimeout,setInterval(){}});
  const source=fs.readFileSync(path.join(__dirname,'../server/index.js'),'utf8').replace(/setup\(\)\s*\.then\([\s\S]*$/,'');
  vm.runInContext(source,context);await vm.runInContext('setup()',context);await vm.runInContext('setup()',context);
  await query("INSERT INTO users(id,email,password_hash,full_name,role) VALUES(902,'staff@local','unused','Staff','staff')");
  assert.equal((await query('SELECT total_price FROM bookings WHERE id=900')).rows[0].total_price,72000);
  const call=async(method,p,{body={},role='admin',id,addonId,query:q={}}={})=>{
   const res={code:200,status(n){this.code=n;return this;},json(data){this.data=data;return this;}};
   await routes.get(method+' '+p)({body:{reason:'Pricing regression adjustment',...body},query:q,params:{id,addonId:String(addonId)},user:{id:role==='user'?901:role==='staff'?902:900,role,name:'Test',session_version:0}},res,e=>{res.status(e.status || (e.code==='23P01'?409:500)).json({error:e.message});});return res;
  };
  let pricing=(await call('GET','/api/pricing')).data;
  assert.equal((await call('PUT','/api/admin/pricing',{role:'staff',body:{config:pricing.config,version:1}})).code,403);
  assert.equal((await call('PUT','/api/admin/pricing',{body:{config:{},version:1}})).code,400);
  assert.equal((await call('PUT','/api/admin/pricing',{body:{config:pricing.config,version:1}})).code,200);
  assert.equal((await call('PUT','/api/admin/pricing',{body:{config:pricing.config,version:1}})).code,409);
  const today=new Date(Date.now()+7*3600000).toISOString().slice(0,10), d=new Date(today+'T00:00Z');d.setUTCDate(d.getUTCDate()+1);const day=d.toISOString().slice(0,10);
  const recurring=await call('POST','/api/admin/accounts/:id/schedule',{id:901,body:{courtId:900,weekday:1,start:'08:00',end:'09:00'}});
  assert.equal(recurring.code,201);assert.ok(recurring.data.created>=4);
  const fixedBookings=(await query('SELECT * FROM bookings WHERE schedule_rule_id IS NOT NULL')).rows;
  assert.ok(fixedBookings.every(b=>b.total_price===50000 && b.pricing_snapshot.memberType==='fixed'));
  const startsAt=day+'T16:30:00+07:00',endsAt=day+'T17:30:00+07:00';
  const quote=Pricing.quote(pricing.config,startsAt,endsAt,'fixed');
  const assigned=await call('POST','/api/admin/bookings',{body:{courtId:900,userId:901,playerName:'Fixed player',playerPhone:'0901234567',startsAt,endsAt}});
  assert.equal(assigned.code,201);assert.equal(assigned.data.totalPrice,quote.total);
  const id=assigned.data.id;
  await call('POST','/api/admin/bookings/:id/addons',{id,body:{label:'Nước',quantity:2,unitPrice:10000}});
  assert.equal((await call('PATCH','/api/admin/bookings/:id/discount',{id,role:'staff',body:{type:'percent',value:10}})).code,202);
  assert.equal((await call('PATCH','/api/admin/bookings/:id/discount',{id,body:{type:'percent',value:101}})).code,400);
  assert.equal((await call('PATCH','/api/admin/bookings/:id/discount',{id,body:{type:'amount',value:9999999}})).code,400);
  assert.equal((await call('PATCH','/api/admin/bookings/:id/discount',{id,body:{type:'percent',value:10}})).code,200);
  let bill=(await call('GET','/api/admin/bookings/:id/bill',{id})).data;
  assert.equal(bill.total,Math.round((quote.total+20000)*.9));assert.equal(bill.due,bill.total);
  let history=(await call('GET','/api/bookings/history',{query:{page:'1'}})).data;
  assert.equal(Number(history.rows.find(b=>String(b.id)===String(id)).invoice_total),bill.total);
  assert.equal((await call('PATCH','/api/admin/bookings/:id/paid',{id,body:{paid:true}})).code,200);
  assert.equal((await call('PATCH','/api/admin/bookings/:id/discount',{id,body:{type:'amount',value:10000}})).code,409);
  assert.equal((await call('DELETE','/api/admin/bookings/:id/addons/:addonId',{id,addonId:bill.addons[0].id})).code,409);
  await call('PATCH','/api/admin/bookings/:id/paid',{id,body:{paid:false}});
  await call('PATCH','/api/admin/bookings/:id/discount',{id,body:{type:'amount',value:10000}});
  const ext=await call('POST','/api/admin/bookings/:id/extend',{id,body:{minutes:30}});assert.equal(ext.code,201);
  bill=(await call('GET','/api/admin/bookings/:id/bill',{id})).data;
  const extQuote=Pricing.quote(pricing.config,endsAt,day+'T18:00:00+07:00','fixed');
  assert.equal(bill.total,quote.total+20000+extQuote.total-10000);
  const hold=await call('POST','/api/bookings/hold',{role:'user',body:{courtId:900,startsAt:day+'T23:00:00+07:00',endsAt:day+'T24:00:00+07:00'}});
  assert.equal(hold.code,201);assert.equal(hold.data.totalPrice,70000);
  await query(`INSERT INTO payment_settings(id,bank_bin,bank_name,account_no,account_name) VALUES(true,'970436','Test','12345','Test')`);
  await call('POST','/api/bookings/:id/confirm',{id:hold.data.id,role:'user',body:{playerName:'Fixed player',playerPhone:'0901234567',paymentMethod:'transfer'}});
  await call('PATCH','/api/admin/bookings/:id/discount',{id:hold.data.id,body:{type:'amount',value:12000}});
  let payment=(await call('GET','/api/bookings/:id/payment',{id:hold.data.id,role:'user'})).data;
  assert.equal(payment.amount,58000);assert.ok(payment.qrUrl.includes('amount=58000'));
  // Completed historical booking remains discountable; revenue uses the reduced total.
  await call('PATCH','/api/admin/bookings/:id/discount',{id:900,body:{type:'amount',value:2000}});
  const rev=(await call('GET','/api/admin/revenue',{query:{from:'2026-01-05',to:'2026-01-05'}})).data;
  assert.equal(rev.total,70000);
  await call('POST','/api/admin/bookings/:id/settle',{id});
  bill=(await call('GET','/api/admin/bookings/:id/bill',{id})).data;assert.equal(bill.due,0);
  console.log('Pricing API: legacy migration twice, roles/config version, assigned & hold prices, extension, discount validation/paid locks, history, revenue and QR net amount OK');
 }finally{await db.close();}
})().catch(err=>{console.error(err.stack,err.detail||'',err.position||'');process.exitCode=1;});
