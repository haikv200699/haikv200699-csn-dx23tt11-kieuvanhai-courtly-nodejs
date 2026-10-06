// Runs real HTTP handlers, authorization middleware and SQL in an isolated PostgreSQL WASM database.
// Install app dependencies and @electric-sql/pglite, then: node test/staff-permissions-test.js
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),runtime=process.env.TEST_RUNTIME;
const dep=name=>require(runtime?path.join(runtime,name):name);
const {PGlite}=dep('@electric-sql/pglite');
const {btree_gist}=require(runtime?path.join(runtime,'@electric-sql/pglite/dist/contrib/btree_gist.cjs'):'@electric-sql/pglite/contrib/btree_gist');
const jwt=dep('jsonwebtoken'),bcrypt=dep('bcryptjs'),Access=require('../public/permissions');
const source=fs.readFileSync(path.join(root,'server/index.js'),'utf8').split('\nsetup()')[0];
const secret='test-secret-never-used-in-production';
(async()=>{
  const db=new PGlite({extensions:{btree_gist}});let http;
  try{
    await db.exec("SET TIME ZONE 'Asia/Ho_Chi_Minh';"+fs.readFileSync(path.join(root,'db/schema.sql'),'utf8'));
    const migration=fs.readFileSync(path.join(root,'db/staff.sql'),'utf8');await db.exec(migration);await db.exec(migration);
    const hash=await bcrypt.hash('test-pass',4);
    for(const [id,role] of [[1,'admin'],[2,'staff'],[3,'user'],[4,'staff']])await db.query('INSERT INTO users(id,email,password_hash,full_name,phone,role) VALUES($1,$2,$3,$4,$5,$6)',[id,role+id+'@example.test',hash,'Test '+role,'090000000'+id,role]);
    await db.exec("INSERT INTO courts(id,name,district,price_per_hour,open_time,close_time) VALUES(1,'Sân 1','',60000,'05:00','24:00'),(2,'Sân 2','',60000,'05:00','24:00')");
    const events=[];
    const query=async(sql,args)=>{const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows ?? r.rows.length};};
    const pool={query,connect:async()=>({query,release(){}})};
    const context={require:n=>n==='pg'?{Pool:function(){return pool;}}:n==='socket.io'?{Server:function(){this.emit=(...e)=>events.push(e);this.on=()=>{};}}:n==='express'?dep(n):n==='jsonwebtoken'?jwt:n==='bcryptjs'?bcrypt:n.startsWith('.')?require(path.resolve(root,'server',n)):require(n),
      __dirname:path.join(root,'server'),console,process:{env:{JWT_SECRET:secret}},Buffer,Date,setTimeout,clearTimeout,setInterval(){},clearInterval(){},module:{exports:{}}};
    vm.runInNewContext(source+'\nmodule.exports={app,setup};',context);
    http=await new Promise(resolve=>{const server=context.module.exports.app.listen(0,'127.0.0.1',()=>resolve(server));});
    const origin='http://127.0.0.1:'+http.address().port;
    const token=(id,role,sv=0)=>jwt.sign({id,role,sv},secret);
    let staffToken=token(2,'staff'),owner=token(1,'admin'),count=0;
    async function api(url,method='GET',body,auth=staffToken,status){
      status ??= method==='POST' && /\/(addons|extend)$/.test(url) ? 201 : 200;
      const r=await fetch(origin+'/api'+url,{method,headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+auth}:{})},body:body===undefined?undefined:JSON.stringify(body)});
      const text=await r.text();let data;try{data=JSON.parse(text);}catch{data=text;}
      assert.equal(r.status,status,`${method} ${url}: ${text}`);count++;return data;
    }
    const day=new Date(Date.now()+86400000+7*3600000).toISOString().slice(0,10);
    const at=h=>`${day}T${h}:00+07:00`;
    async function booking(start='08:00',end='09:00',paymentMethod='onsite',courtId=1){return (await api('/admin/bookings','POST',{courtId,startsAt:at(start),endsAt:at(end),playerName:'Khách kiểm thử',playerPhone:'0900000003',paymentMethod},staffToken,201)).id;}
    const me=await api('/me');assert.equal(me.permissions.cashCollect,true);assert.equal(me.permissions.transferConfirm,false);assert.equal(me.maxPercent,5);
    await api('/admin/accounts','GET',undefined,staffToken,403);
    await api('/admin/courts','POST',{name:'Bypass'},staffToken,403);
    await api('/admin/courts/1/maintenance','PATCH',{underMaintenance:true},staffToken,403);
    await api('/admin/payment-settings','GET',undefined,staffToken,403);
    await api('/admin/pricing','PUT',{},staffToken,403);
    await api('/admin/audit','GET',undefined,staffToken,403);
    await api('/bookings/hold','POST',{},staffToken,403);
    await api('/bookings/1/confirm','POST',{},staffToken,403);
    // Forging an owner role in an otherwise valid signed token cannot override the account row.
    await api('/admin/accounts','GET',undefined,token(2,'admin'),403);
    await api('/admin/revenue?from=2026-01-01&to=2026-01-02','GET',undefined,staffToken,403);
    await api('/admin/revenue');assert.deepEqual(await api('/admin/players?q='),[]);
    await api('/admin/customers/export','GET',undefined,staffToken,403);
    const id=await booking();
    await api(`/admin/bookings/${id}/discount`,'PATCH',{type:'amount',value:1000},staffToken,400);
    await api(`/admin/bookings/${id}/discount`,'PATCH',{type:'percent',value:5,reason:'Ưu đãi khách quen'});
    let bill=await api(`/admin/bookings/${id}/bill`);assert(!('user_email' in bill.booking));assert.equal(bill.discount,Math.round(bill.base*.05));
    const pending=await api(`/admin/bookings/${id}/discount`,'PATCH',{type:'percent',value:10,reason:'Xin ưu đãi đặc biệt'},staffToken,202);
    assert.equal(pending.pending,true);assert.equal((await api(`/admin/bookings/${id}/bill`)).booking.invoice_discount_value,5);
    await api(`/admin/bookings/${id}/discount`,'PATCH',{type:'percent',value:15,reason:'Yêu cầu trùng'},staffToken,409);
    await api(`/admin/discount-requests/${pending.requestId}/review`,'POST',{approve:true,reason:'Tự duyệt không được'},staffToken,403);
    await api(`/admin/discount-requests/${pending.requestId}/review`,'POST',{approve:true,reason:'Chủ sân đồng ý'},owner);
    assert.equal((await api(`/admin/bookings/${id}/bill`)).booking.invoice_discount_value,10);
    // Staff may not grow a discount above their cap by adding services.
    await api(`/admin/bookings/${id}/addons`,'POST',{label:'Nước',quantity:1,unitPrice:10000},staffToken,403);
    await api(`/admin/bookings/${id}/discount`,'PATCH',{type:'amount',value:0,reason:'Bỏ ưu đãi để thử tiếp'});
    const addon=await api(`/admin/bookings/${id}/addons`,'POST',{label:'Nước',quantity:2,unitPrice:10000});
    await api(`/admin/bookings/${id}/addons/${addon.id}`,'DELETE',{},staffToken,400);
    await api(`/admin/bookings/${id}/addons/${addon.id}/paid`,'PATCH',{paid:true});
    await api(`/admin/bookings/${id}/addons/${addon.id}/paid`,'PATCH',{paid:false,reason:'Bỏ thu'},staffToken,403);
    await api(`/admin/bookings/${id}/addons/${addon.id}`,'DELETE',{reason:'Xóa đã thu'},staffToken,403);
    await api(`/bookings/${id}/cancel`,'PATCH',{reason:'Hủy đã thu'},staffToken,409);
    await api(`/admin/bookings/${id}/extend`,'POST',{minutes:30,reason:'Gia hạn đã thu'},staffToken,409);
    await api(`/admin/bookings/${id}/details`,'PATCH',{courtId:2,startsAt:at('08:00'),endsAt:at('09:00'),reason:'Đổi sân đã thu'},staffToken,409);
    await api(`/admin/bookings/${id}/settle`,'POST',{});
    await api(`/admin/bookings/${id}/paid`,'PATCH',{paid:false,reason:'Bỏ thu'},staffToken,403);
    await api(`/bookings/${id}/cancel`,'PATCH',{reason:'Chủ sân hủy booking'},owner);
    await api(`/admin/bookings/${id}/settle`,'POST',{},staffToken,409);
    const transfer=await booking('09:00','10:00','transfer');
    await api(`/admin/bookings/${transfer}/paid`,'PATCH',{paid:true},staffToken,403);
    await api(`/admin/bookings/${transfer}/settle`,'POST',{},staffToken,403);
    await api(`/admin/bookings/${transfer}/addons`,'POST',{label:'Nước',quantity:1,unitPrice:10000,paid:true},staffToken,403);
    const transferAddon=await api(`/admin/bookings/${transfer}/addons`,'POST',{label:'Nước',quantity:1,unitPrice:10000});
    await api(`/admin/bookings/${transfer}/addons/${transferAddon.id}/paid`,'PATCH',{paid:true},staffToken,403);
    await api(`/admin/bookings/${transfer}/addons/${transferAddon.id}`,'DELETE',{reason:'Khách không lấy nước'});
    const stale=await api(`/admin/bookings/${transfer}/discount`,'PATCH',{type:'percent',value:15,reason:'Chờ duyệt rồi đổi'},staffToken,202);
    await api(`/admin/bookings/${transfer}/addons`,'POST',{label:'Nước mới',quantity:1,unitPrice:5000});
    await api(`/admin/discount-requests/${stale.requestId}/review`,'POST',{approve:true,reason:'Duyệt sau thay đổi'},owner,409);
    await api(`/admin/discount-requests/${stale.requestId}/review`,'POST',{approve:false,reason:'Booking đã thay đổi'},owner);
    await api(`/admin/bookings/${transfer}/details`,'PATCH',{courtId:2,startsAt:at('10:00'),endsAt:at('11:00'),reason:'Khách đổi sân giờ'});
    await api(`/admin/bookings/${transfer}/extend`,'POST',{minutes:30,reason:'Khách chơi thêm'});
    const conflict=await booking('11:30','12:30','onsite',2);
    const beforeAudit=(await db.query('SELECT count(*)::int n FROM operation_audit')).rows[0].n;
    await api(`/admin/bookings/${transfer}/extend`,'POST',{minutes:30,reason:'Gia hạn trùng sân'},staffToken,409);
    assert.equal((await db.query('SELECT count(*)::int n FROM operation_audit')).rows[0].n,beforeAudit,'failed write must not create success audit');
    assert.equal((await api(`/admin/bookings/${transfer}/bill`)).booking.ends_at,new Date(at('11:30')).toISOString());
    const history=await api('/bookings/history');assert.equal(history.summary.revenue,null);assert(!history.rows.some(b=>'user_email' in b));
    // Every individual permission is enforced by actual authenticated HTTP calls.
    const checks={bookingView:['/bookings/history','GET'],bookingCreate:['/admin/bookings','POST'],bookingEdit:[`/admin/bookings/${conflict}/details`,'PATCH'],addonManage:[`/admin/bookings/${conflict}/addons`,'POST'],cashCollect:[`/admin/bookings/${conflict}/settle`,'POST'],transferConfirm:[`/admin/bookings/${transfer}/settle`,'POST'],discount:[`/admin/bookings/${conflict}/discount`,'PATCH'],cancelUnpaid:[`/bookings/${conflict}/cancel`,'PATCH'],revenueView:['/admin/revenue','GET'],customerLookup:['/admin/players?q=Test','GET'],customerExport:['/admin/customers/export','GET']};
    for(const [key,[url,method]] of Object.entries(checks)){
      const permissions=Object.fromEntries(Object.keys(Access.catalog).map(k=>[k,k!==key]));
      await db.query('UPDATE users SET staff_permissions=$1 WHERE id=2',[JSON.stringify(permissions)]);
      await api(url,method,method==='GET'?undefined:{},staffToken,403);
    }
    await db.query('UPDATE users SET staff_permissions=$1 WHERE id=2',[JSON.stringify(Object.fromEntries(Object.keys(Access.catalog).map(k=>[k,true])))]);
    await api(`/admin/bookings/${transfer}/settle`,'POST',{});
    const exported=await api('/admin/customers/export');assert(exported.includes('Test user'));assert(!exported.includes('@example.test'));
    const access=await api('/admin/staff/2/access','GET',undefined,owner);
    const change={...access,disabled:true,reason:'Kết thúc làm việc'};
    await api('/admin/staff/2/access','PATCH',change,owner);
    await api('/me','GET',undefined,staffToken,401);
    await api('/auth/login','POST',{email:'staff2@example.test',password:'test-pass'},null,403);
    await api('/admin/staff/2/access','PATCH',{...change,disabled:false},owner,409);
    await api('/admin/staff/2/access','PATCH',{...change,disabled:false,version:access.version+1},owner);
    await api('/me','GET',undefined,staffToken,401);
    const login=await api('/auth/login','POST',{email:'staff2@example.test',password:'test-pass'},null);staffToken=login.token;
    await api('/me');
    // Playing time, IDs, hold time and confirmation time intentionally disagree.
    const today=new Date(Date.now()+7*3600000).toISOString().slice(0,10),sortIds=[];
    for(const [hour,createdMinutes,confirmedMinutes] of [[8,40,30],[12,20,10],[10,15,null]]){
      const row=(await db.query(`INSERT INTO bookings(court_id,user_id,starts_at,ends_at,status,total_price,player_name,player_phone,payment_method,paid,created_at,confirmed_at)
        VALUES(1,3,$1,$2,'confirmed',180000,'Kieu Ha','01321312321','onsite',false,now()-$3*interval '1 minute',CASE WHEN $4::int IS NULL THEN null ELSE now()-$4*interval '1 minute' END) RETURNING id`,[today+`T${String(hour).padStart(2,'0')}:00:00+07:00`,today+`T${String(hour+1).padStart(2,'0')}:00:00+07:00`,createdMinutes,confirmedMinutes])).rows[0];sortIds.push(row.id);
    }
    const expected=[sortIds[1],sortIds[2],sortIds[0]].map(String);
    assert.deepEqual((await api('/bookings/mine')).map(b=>String(b.id)),expected,'today must use placed time descending with legacy fallback');
    const sorted=await api('/bookings/history?limit=50');
    assert.deepEqual(sorted.rows.filter(b=>sortIds.includes(b.id)).map(b=>String(b.id)),expected,'history must use the same order before pagination');
    const historyRows=[];
    for(let page=1;page<=Math.ceil(sorted.summary.total/2);page++)historyRows.push(...(await api('/bookings/history?limit=2&page='+page)).rows);
    assert.deepEqual(historyRows.map(b=>String(b.id)),sorted.rows.map(b=>String(b.id)),'stable placement order across page boundaries');
    await db.query("UPDATE bookings SET status='cancelled' WHERE id=$1",[sortIds[0]]);
    await db.query('UPDATE bookings SET paid=true,total_price=210000 WHERE id=$1',[sortIds[1]]);
    const audits=await api('/admin/audit','GET',undefined,owner);
    assert(audits.rows.some(r=>r.action==='staff.access' && r.before_data && r.after_data));
    const allAudits=(await db.query('SELECT * FROM operation_audit')).rows;
    for(const action of ['booking.create','discount.request','discount.approve','discount.reject','payment.settle','booking.cancel','booking.edit','booking.extend','service.remove','customer.export'])assert(allAudits.some(r=>r.action===action),action);
    assert(!JSON.stringify(allAudits).includes(hash));
    assert(events.some(e=>e[0]==='session:changed'));
    if(process.env.STAFF_BROWSER_TEST) await require(path.resolve(process.env.STAFF_BROWSER_TEST))({origin,db,owner,staffToken});
    console.log(`PASS: ${count} HTTP assertions, independent permission switches, cap approval/staleness, transaction rollback, audit, migration twice, account/session revocation.`);
  }finally{if(http)await new Promise(r=>http.close(r));await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
