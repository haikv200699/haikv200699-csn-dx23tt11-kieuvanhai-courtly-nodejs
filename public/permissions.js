(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CourtlyAccess = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const catalog = {
    bookingView: ['Xem lịch và chi tiết booking', true],
    bookingCreate: ['Tạo booking cho khách', true],
    bookingEdit: ['Đổi sân, đổi giờ và gia hạn booking chưa thu tiền', true],
    addonManage: ['Thêm và xóa dịch vụ chưa thu tiền', true],
    cashCollect: ['Xác nhận thu tiền tại sân', true],
    transferConfirm: ['Xác nhận đã nhận chuyển khoản', false],
    discount: ['Giảm giá trong hạn mức / gửi yêu cầu duyệt', true],
    cancelUnpaid: ['Hủy booking chưa thu tiền', true],
    revenueView: ['Xem doanh thu hôm nay', true],
    customerLookup: ['Tra cứu tên và số điện thoại khách', true],
    customerExport: ['Xuất danh sách khách ra CSV', false],
  };
  function permissions(value = {}) {
    return Object.fromEntries(Object.entries(catalog).map(([key, [, enabled]]) => [key, typeof value?.[key] === 'boolean' ? value[key] : enabled]));
  }
  function config(user) {
    return { permissions: permissions(user?.permissions ?? user?.staff_permissions),
      maxPercent: user?.maxPercent ?? user?.staff_discount_max_percent ?? 5,
      maxAmount: user?.maxAmount ?? user?.staff_discount_max_amount ?? 20000 };
  }
  function can(user, key) {
    return !!catalog[key] && (user?.role === 'admin' || (user?.role === 'staff' && config(user).permissions[key]));
  }
  function discountAmount(booking, items, type, value) {
    const lines = [Number(booking.total_price), ...items.map(a => a.quantity * a.unit_price)];
    const gross = lines.reduce((a,b) => a+b, 0);
    return { gross, amount: type === 'percent' ? lines.reduce((n,p) => n + Math.round(p * value / 100), 0) : value };
  }
  function withinLimit(user, gross, amount) {
    const c = config(user);
    return user.role === 'admin' || (amount <= c.maxAmount && amount * 100 <= gross * c.maxPercent);
  }
  return { catalog, permissions, config, can, discountAmount, withinLimit };
});
