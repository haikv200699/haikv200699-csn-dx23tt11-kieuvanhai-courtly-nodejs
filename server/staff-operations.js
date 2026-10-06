const { Access, fail, requirePermission, reason, fingerprint, audit } = require('./staff-access');
async function transaction(pool, user, fn) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const current = (await db.query('SELECT * FROM users WHERE id=$1 FOR SHARE', [user.id])).rows[0];
    if (!current || current.disabled_at || current.session_version !== user.session_version) fail(401, 'Phiên đăng nhập đã hết hiệu lực. Vui lòng đăng nhập lại.');
    const result = await fn(db, current);
    await db.query('COMMIT');
    return result;
  } catch (e) { await db.query('ROLLBACK'); throw e; }
  finally { db.release(); }
}
async function locked(db, id) {
  if (!/^\d+$/.test(String(id))) fail(400, 'Mã booking không hợp lệ');
  const b = (await db.query('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!b) fail(404, 'Không tìm thấy booking');
  const items = (await db.query('SELECT * FROM booking_addons WHERE booking_id=$1 ORDER BY id FOR UPDATE', [id])).rows;
  return { b, items };
}
const active = b => { if (b.status !== 'confirmed') fail(409, 'Booking không còn hiệu lực'); };
const unpaid = (b, items) => { if (b.paid || items.some(a => a.paid)) fail(409, 'Booking đã có khoản thu. Chỉ chủ sân được điều chỉnh khoản đã thu.'); };
const validTransfer = b => { if (b.payment_method === 'transfer' && !b.paid && +new Date(b.confirmed_at) <= Date.now()-600000) fail(409, 'Booking đã quá 10 phút xác nhận chuyển khoản'); };
function collection(user, b, paid) {
  if (typeof paid !== 'boolean') fail(400, 'Trạng thái thanh toán không hợp lệ');
  requirePermission(user, b.payment_method === 'transfer' ? 'transferConfirm' : 'cashCollect');
  if (user.role === 'staff' && !paid) fail(403, 'Chỉ chủ sân được bỏ xác nhận đã thu tiền');
  if (paid) validTransfer(b);
}
function validateDiscount(b, items, type, value) {
  active(b); unpaid(b, items); validTransfer(b);
  if (!['amount','percent'].includes(type) || !Number.isSafeInteger(value) || value < 0 || value > 2147483647 || (type === 'percent' && value > 100)) fail(400, 'Nhập số tiền nguyên không âm hoặc phần trăm từ 0 đến 100');
  const amounts = Access.discountAmount(b, items, type, value);
  if (amounts.amount > amounts.gross) fail(400, 'Mức giảm vượt tổng hóa đơn');
  return amounts;
}
async function applyDiscount(db, b, type, value, amount, gross) {
  await db.query('UPDATE bookings SET invoice_discount_type=$2,invoice_discount_value=$3 WHERE id=$1', [b.id,type,value]);
  if (amount === gross) {
    await db.query('UPDATE bookings SET paid=true WHERE id=$1', [b.id]);
    await db.query('UPDATE booking_addons SET paid=true WHERE booking_id=$1', [b.id]);
  }
}
// A percentage discount may grow when services or time are added. An approved cap cannot be bypassed that way.
function checkChangedDiscount(user, b, items) {
  if (user.role !== 'staff' || !b.invoice_discount_value) return;
  const {gross, amount} = Access.discountAmount(b, items, b.invoice_discount_type, b.invoice_discount_value);
  if (!Access.withinLimit(user,gross,amount)) fail(403, 'Hóa đơn có giảm giá vượt hạn mức. Nhờ chủ sân điều chỉnh dịch vụ hoặc thời gian.');
  if (amount > gross) fail(409, 'Tổng mới thấp hơn số tiền giảm');
}
function register({ app, auth, admin, ah, pool, io, broadcast, priceQuote, vnDay, vnMinutes, toMin, bookingWindow }) {
  const updated = id => { io.emit('booking:updated', {bookingId:id}); broadcast().catch(console.error); };
  const mutate = (action, fn) => ah(async (req,res) => {
    const result = await transaction(pool, req.user, async (db,user) => {
      const {b,items} = await locked(db,req.params.id);
      const before = {booking:b, addons:items};
      const result = await fn({req,db,user,b,items});
      const after = await locked(db,b.id);
      if (!result?.pending) await audit(db,user,action,b.id,req.body.reason,before,{booking:after.b,addons:after.items});
      return result || {ok:true};
    });
    res.status(result.pending ? 202 : ['service.add','booking.extend'].includes(action) ? 201 : 200).json(result);
    updated(req.params.id);
  });
  app.patch('/api/bookings/:id/cancel', auth, mutate('booking.cancel', async ({req,db,user,b,items}) => {
    active(b); const why = reason(req.body.reason); req.body.reason = why;
    if (user.role === 'user') {
      if (String(user.id) !== String(b.user_id) || +new Date(b.starts_at) <= Date.now()) fail(403,'Không thể hủy booking này');
      unpaid(b,items);
    } else { requirePermission(user,'cancelUnpaid'); if(user.role === 'staff') unpaid(b,items); }
    await db.query("UPDATE bookings SET status='cancelled' WHERE id=$1",[b.id]);
  }));
  app.patch('/api/admin/bookings/:id/paid', auth, admin, mutate('payment.court', async ({req,db,user,b}) => {
    active(b); collection(user,b,req.body.paid);
    if (!req.body.paid) req.body.reason = reason(req.body.reason);
    await db.query('UPDATE bookings SET paid=$2 WHERE id=$1',[b.id,req.body.paid]);
  }));
  app.post('/api/admin/bookings/:id/settle', auth, admin, mutate('payment.settle', async ({db,user,b}) => {
    if (user.role === 'staff') active(b);
    else if (b.status !== 'confirmed' && !(b.status === 'cancelled' && b.confirmed_at)) fail(409,'Booking chưa được xác nhận');
    collection(user,b,true);
    await db.query('UPDATE bookings SET paid=true WHERE id=$1',[b.id]);
    await db.query('UPDATE booking_addons SET paid=true WHERE booking_id=$1',[b.id]);
  }));
  app.patch('/api/admin/bookings/:id/addons/:addonId/paid', auth, admin, mutate('payment.service', async ({req,db,user,b,items}) => {
    active(b); collection(user,b,req.body.paid);
    if (!items.some(a => String(a.id) === req.params.addonId)) fail(404,'Không tìm thấy dịch vụ');
    if (!req.body.paid) req.body.reason = reason(req.body.reason);
    await db.query('UPDATE booking_addons SET paid=$3 WHERE booking_id=$1 AND id=$2',[b.id,req.params.addonId,req.body.paid]);
  }));
  app.post('/api/admin/bookings/:id/addons', auth, admin, mutate('service.add', async ({req,db,user,b,items}) => {
    requirePermission(user,'addonManage'); active(b); validTransfer(b);
    const {label,quantity,unitPrice,paid=false} = req.body;
    if (typeof label !== 'string' || !label.trim() || label.length>100 || !Number.isSafeInteger(quantity) || quantity<1 || quantity>100 || !Number.isSafeInteger(unitPrice) || unitPrice<1 || unitPrice>100000000 || typeof paid!=='boolean') fail(400,'Tên, số lượng hoặc giá dịch vụ không hợp lệ');
    if (paid) collection(user,b,true);
    if (b.invoice_discount_value && (b.paid || items.some(a=>a.paid))) fail(409,'Hóa đơn có giảm giá và khoản đã thu. Nhờ chủ sân xử lý trước khi thêm dịch vụ.');
    checkChangedDiscount(user,b,[...items,{quantity,unit_price:unitPrice}]);
    const item = (await db.query(`INSERT INTO booking_addons(booking_id,kind,label,quantity,unit_price,paid,created_by)
      VALUES($1,'product',$2,$3,$4,$5,$6) RETURNING *`,[b.id,label.trim(),quantity,unitPrice,paid,user.id])).rows[0];
    return item;
  }));
  app.delete('/api/admin/bookings/:id/addons/:addonId', auth, admin, mutate('service.remove', async ({req,db,user,b,items}) => {
    requirePermission(user,'addonManage'); active(b); req.body.reason=reason(req.body.reason);
    const item=items.find(a=>String(a.id)===req.params.addonId && a.kind==='product');
    if(!item) fail(404,'Chỉ xóa được dịch vụ bán thêm');
    if(user.role==='staff' && item.paid) fail(403,'Chỉ chủ sân được xóa dịch vụ đã thu tiền');
    if(b.invoice_discount_value) unpaid(b,items);
    const remaining=items.filter(a=>a!==item);
    checkChangedDiscount(user,b,remaining);
    if(b.invoice_discount_type==='amount' && b.invoice_discount_value>Number(b.total_price)+remaining.reduce((n,a)=>n+a.quantity*a.unit_price,0)) fail(409,'Điều chỉnh giảm giá trước khi xóa dịch vụ');
    await db.query('DELETE FROM booking_addons WHERE id=$1',[item.id]);
  }));
  app.patch('/api/admin/bookings/:id/discount', auth, admin, mutate('discount.change', async ({req,db,user,b,items}) => {
    requirePermission(user,'discount'); req.body.reason=reason(req.body.reason);
    const {type,value}=req.body, {gross,amount}=validateDiscount(b,items,type,value);
    if (!Access.withinLimit(user,gross,amount)) {
      const row=(await db.query(`INSERT INTO discount_requests(booking_id,requested_by,discount_type,discount_value,reason,fingerprint)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(booking_id) WHERE status='pending' DO NOTHING RETURNING id`,[b.id,user.id,type,value,req.body.reason,fingerprint(b,items)])).rows[0];
      if(!row) fail(409,'Booking đã có yêu cầu giảm giá chờ chủ sân duyệt');
      await audit(db,user,'discount.request',b.id,req.body.reason,null,{requestId:row.id,type,value,amount});
      return {pending:true,requestId:row.id,message:'Đã gửi yêu cầu cho chủ sân. Giá hiện tại chưa thay đổi.'};
    }
    await applyDiscount(db,b,type,value,amount,gross);
  }));
  app.post('/api/admin/bookings/:id/extend', auth, admin, mutate('booking.extend', async ({req,db,user,b,items}) => {
    requirePermission(user,'bookingEdit'); active(b); validTransfer(b); unpaid(b,items); req.body.reason=reason(req.body.reason);
    const minutes=Number(req.body.minutes);
    if(![30,60,90,120,150].includes(minutes)) fail(400,'Chọn ca gia hạn 30 phút');
    const c=(await db.query('SELECT * FROM courts WHERE id=$1 FOR SHARE',[b.court_id])).rows[0];
    const end=new Date(b.ends_at), next=new Date(+end+minutes*60000);
    if(end<=new Date() || c.under_maintenance || vnDay(new Date(next-1))!==vnDay(new Date(b.starts_at)) || vnMinutes(new Date(next-1))>=toMin(c.close_time)) fail(409,'Không thể gia hạn ngoài giờ mở cửa hoặc booking đã kết thúc');
    const quote=await priceQuote(db,end,next,b.pricing_snapshot?.memberType || (b.discount_percent?'fixed':'casual'));
    checkChangedDiscount(user,b,[...items,{quantity:1,unit_price:quote.total}]);
    await db.query('UPDATE bookings SET ends_at=$2 WHERE id=$1',[b.id,next]);
    await db.query(`INSERT INTO booking_addons(booking_id,kind,label,quantity,unit_price,paid,created_by) VALUES($1,'extra_time',$2,1,$3,false,$4)`,[b.id,`Gia hạn sân ${minutes} phút`,quote.total,user.id]);
  }));
  app.patch('/api/admin/bookings/:id/details', auth, admin, mutate('booking.edit', async ({req,db,user,b,items}) => {
    requirePermission(user,'bookingEdit'); active(b); validTransfer(b); unpaid(b,items); req.body.reason=reason(req.body.reason);
    const s=new Date(req.body.startsAt), e=new Date(req.body.endsAt),courtId=Number(req.body.courtId);
    if(!Number.isFinite(+s)||!Number.isFinite(+e)||s<=new Date()||e<=s||e-s>10800000||+s%1800000||+e%1800000||!bookingWindow(vnDay(s))) fail(400,'Chọn giờ tương lai theo ca 30 phút, tối đa 3 giờ trong 30 ngày tới');
    if(items.some(a=>a.kind==='extra_time')) fail(409,'Booking đã gia hạn. Nhờ chủ sân xử lý các khoản gia hạn trước khi đổi giờ.');
    const c=(await db.query('SELECT * FROM courts WHERE id=$1 FOR SHARE',[courtId])).rows[0];
    if(!c || c.under_maintenance || vnDay(s)!==vnDay(new Date(e-1)) || vnMinutes(s)<Math.max(300,toMin(c.open_time)) || vnMinutes(new Date(e-1))>=toMin(c.close_time)) fail(409,'Sân hoặc giờ chơi không khả dụng');
    const quote=await priceQuote(db,s,e,b.pricing_snapshot?.memberType || (b.discount_percent?'fixed':'casual'));
    if(b.invoice_discount_type==='amount' && b.invoice_discount_value>quote.total+items.reduce((n,a)=>n+a.quantity*a.unit_price,0)) fail(409,'Điều chỉnh giảm giá trước khi đổi giờ');
    checkChangedDiscount(user,{...b,total_price:quote.total},items);
    await db.query(`UPDATE bookings SET court_id=$2,starts_at=$3,ends_at=$4,total_price=$5,standard_price=$6,discount_percent=0,pricing_snapshot=$7 WHERE id=$1`,[b.id,courtId,s,e,quote.total,quote.standard,JSON.stringify(quote)]);
  }));

  const owner = (req,_res,next) => { if(req.user.role!=='admin') return next(Object.assign(new Error('Chỉ dành cho chủ sân'),{status:403})); next(); };
  app.get('/api/admin/staff/:id/access',auth,owner,ah(async(req,res)=>{
    const u=(await pool.query("SELECT * FROM users WHERE id=$1 AND role='staff'",[req.params.id])).rows[0];
    if(!u) fail(404,'Không tìm thấy ca trưởng');
    res.json({...Access.config(u),disabled:!!u.disabled_at,version:u.session_version});
  }));
  app.patch('/api/admin/staff/:id/access',auth,owner,ah(async(req,res)=>{
    const {permissions,maxPercent,maxAmount,disabled,version}=req.body;
    if(!permissions || Object.keys(permissions).length!==Object.keys(Access.catalog).length || Object.keys(Access.catalog).some(k=>typeof permissions[k]!=='boolean') || !Number.isInteger(maxPercent)||maxPercent<0||maxPercent>100 || !Number.isInteger(maxAmount)||maxAmount<0||maxAmount>2147483647 || typeof disabled!=='boolean' || !Number.isInteger(version)) fail(400,'Cấu hình quyền hoặc hạn mức không hợp lệ');
    const why=reason(req.body.reason);
    const next=await transaction(pool,req.user,async(db,user)=>{
      const old=(await db.query("SELECT * FROM users WHERE id=$1 AND role='staff' FOR UPDATE",[req.params.id])).rows[0];
      if(!old) fail(404,'Không tìm thấy ca trưởng');
      if(old.session_version!==version) fail(409,'Quyền đã thay đổi ở nơi khác. Đóng và mở lại tài khoản.');
      const row=(await db.query(`UPDATE users SET staff_permissions=$2,staff_discount_max_percent=$3,staff_discount_max_amount=$4,disabled_at=CASE WHEN $5 THEN coalesce(disabled_at,now()) ELSE null END,session_version=session_version+1 WHERE id=$1 RETURNING *`,[old.id,JSON.stringify(permissions),maxPercent,maxAmount,disabled])).rows[0];
      const clean=u=>({...Access.config(u),disabled:!!u.disabled_at,version:u.session_version});
      await audit(db,user,'staff.access',old.id,why,clean(old),clean(row)); return clean(row);
    });
    res.json(next); io.emit('session:changed',{userId:req.params.id});
  }));
  app.get('/api/admin/audit',auth,owner,ah(async(req,res)=>{
    const page=Math.max(1,Math.min(100000,parseInt(req.query.page,10)||1));
    const rows=(await pool.query('SELECT * FROM operation_audit ORDER BY id DESC LIMIT 30 OFFSET $1',[(page-1)*30])).rows;
    res.json({rows,page});
  }));
  app.get('/api/admin/discount-requests',auth,owner,ah(async(req,res)=>{
    res.json((await pool.query(`SELECT r.*,u.full_name requester,b.player_name,c.name court_name FROM discount_requests r JOIN users u ON u.id=r.requested_by JOIN bookings b ON b.id=r.booking_id JOIN courts c ON c.id=b.court_id WHERE r.status='pending' ORDER BY r.id LIMIT 100`)).rows);
  }));
  app.post('/api/admin/discount-requests/:id/review',auth,owner,ah(async(req,res)=>{
    const why=reason(req.body.reason), approve=req.body.approve;
    if(typeof approve!=='boolean') fail(400,'Chọn duyệt hoặc từ chối');
    const result=await transaction(pool,req.user,async(db,user)=>{
      const request=(await db.query('SELECT * FROM discount_requests WHERE id=$1',[req.params.id])).rows[0];
      if(!request) fail(404,'Không tìm thấy yêu cầu');
      // Consistent lock order: booking, services, request.
      const {b,items}=await locked(db,request.booking_id);
      const r=(await db.query('SELECT * FROM discount_requests WHERE id=$1 FOR UPDATE',[request.id])).rows[0];
      if(r.status!=='pending') fail(409,'Yêu cầu đã được xử lý');
      if(approve) {
        if(fingerprint(b,items)!==r.fingerprint) fail(409,'Booking đã thay đổi. Từ chối yêu cầu cũ và yêu cầu ca trưởng gửi lại.');
        const {gross,amount}=validateDiscount(b,items,r.discount_type,r.discount_value);
        await applyDiscount(db,b,r.discount_type,r.discount_value,amount,gross);
      }
      await db.query('UPDATE discount_requests SET status=$2,reviewed_by=$3,review_reason=$4,reviewed_at=now() WHERE id=$1',[r.id,approve?'approved':'rejected',user.id,why]);
      const after=await locked(db,b.id);
      await audit(db,user,approve?'discount.approve':'discount.reject',b.id,why,{request:r,booking:b,addons:items},{booking:after.b,addons:after.items});
      return {ok:true,bookingId:b.id};
    });
    res.json(result);updated(result.bookingId);
  }));
  app.get('/api/admin/customers/export',auth,admin,ah(async(req,res)=>{
    requirePermission(req.user,'customerExport');
    const rows=(await pool.query("SELECT full_name,phone FROM users WHERE role='user' ORDER BY id")).rows;
    const csv=s=>'"'+String(s||'').replace(/^[=+\-@\t\r]/,"'$&").replace(/"/g,'""')+'"';
    await audit(pool,req.user,'customer.export',null,'Xuất danh sách tên và số điện thoại',null,{count:rows.length});
    res.set('Content-Type','text/csv; charset=utf-8').set('Content-Disposition','attachment; filename="courtly-khach-hang.csv"').send('\uFEFFTên,Số điện thoại\r\n'+rows.map(r=>[r.full_name,r.phone].map(csv).join(',')).join('\r\n'));
  }));
}
module.exports = { register, transaction, locked };
