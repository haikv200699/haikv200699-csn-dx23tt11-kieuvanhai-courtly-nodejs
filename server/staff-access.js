const Access = require('../public/permissions');
const { createHash } = require('crypto');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const requirePermission = (user, key) => { if (!Access.can(user, key)) fail(403, 'Tài khoản chưa được cấp quyền thực hiện thao tác này'); };
const reason = value => {
  if (typeof value !== 'string' || value.trim().length < 3 || value.trim().length > 500) fail(400, 'Nhập lý do từ 3 đến 500 ký tự');
  return value.trim();
};
const fingerprint = (b, items) => createHash('sha256').update(JSON.stringify([b, items])).digest('hex');
async function audit(db, user, action, id, why, before, after) {
  await db.query(`INSERT INTO operation_audit(actor_id,actor_name,actor_role,action,entity_id,reason,before_data,after_data)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [user.id, user.full_name || user.name || '', user.role, action, id, why || '', before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]);
}
// Called after authoritative account lookup, before every protected route. Unknown staff routes are denied.
function authorize(req) {
  if (req.user.role !== 'staff') return;
  const p = req.route.path, method = req.method;
  if (p === '/api/me') return;
  const reads = {
    '/api/bookings/mine': 'bookingView', '/api/bookings/history': 'bookingView',
    '/api/bookings/:id/invoice': 'bookingView', '/api/bookings/:id/payment': 'bookingView', '/api/bookings/:id/payment/qr': 'bookingView',
    '/api/admin/overview': 'bookingView', '/api/admin/bookings': 'bookingView', '/api/admin/schedule': 'bookingView',
    '/api/admin/courts/:id/bookings': 'bookingView', '/api/admin/bookings/:id/bill': 'bookingView',
    '/api/admin/revenue': 'revenueView', '/api/admin/players': 'customerLookup', '/api/admin/customers/export': 'customerExport',
  };
  if (method === 'GET' && reads[p]) return requirePermission(req.user, reads[p]);
  const writes = {
    'POST /api/admin/bookings': 'bookingCreate', 'PATCH /api/admin/bookings/:id/details': 'bookingEdit',
    'POST /api/admin/bookings/:id/extend': 'bookingEdit', 'POST /api/admin/bookings/:id/addons': 'addonManage',
    'DELETE /api/admin/bookings/:id/addons/:addonId': 'addonManage', 'PATCH /api/bookings/:id/cancel': 'cancelUnpaid',
    'PATCH /api/admin/bookings/:id/discount': 'discount',
  };
  if (writes[method+' '+p]) return requirePermission(req.user, writes[method+' '+p]);
  // Method-specific collection rights are checked against the locked booking in the handler.
  if (['PATCH /api/admin/bookings/:id/paid','PATCH /api/admin/bookings/:id/addons/:addonId/paid','POST /api/admin/bookings/:id/settle'].includes(method+' '+p)) {
    if (Access.can(req.user, 'cashCollect') || Access.can(req.user, 'transferConfirm')) return;
  }
  fail(403, 'Thao tác này chỉ dành cho chủ sân');
}
module.exports = { Access, fail, requirePermission, reason, fingerprint, audit, authorize };
