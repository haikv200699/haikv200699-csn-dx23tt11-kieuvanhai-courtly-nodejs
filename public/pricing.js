/* Pure pricing helpers shared by server, browser and regression tests. All times are Vietnam time. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CourtlyPricing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const defaults = {
    weekday: [{ start: 300, end: 1020, casual: 60000, fixed: 50000 }, { start: 1020, end: 1200, casual: 100000, fixed: 80000 }, { start: 1200, end: 1440, casual: 80000, fixed: 70000 }],
    weekend: [{ start: 300, end: 900, casual: 80000, fixed: 70000 }, { start: 900, end: 1200, casual: 100000, fixed: 80000 }, { start: 1200, end: 1440, casual: 80000, fixed: 70000 }],
    holidays: []
  };
  function validate(config) {
    if (!config || typeof config !== 'object') throw new Error('Bảng giá không hợp lệ');
    for (const group of ['weekday', 'weekend']) {
      const rows = config[group];
      if (!Array.isArray(rows) || !rows.length || rows.length > 12) throw new Error('Mỗi nhóm ngày cần 1–12 khung giờ');
      let end = 300;
      for (const r of rows) {
        if (!r || r.start !== end || !Number.isInteger(r.end) || r.end <= r.start || r.end > 1440 || r.end % 30 ||
            !['casual', 'fixed'].every(k => Number.isSafeInteger(r[k]) && r[k] >= 1000 && r[k] <= 10000000))
          throw new Error('Các khung giờ phải liên tục từ 05:00 đến 24:00, theo ca 30 phút; giá 1.000–10.000.000đ/giờ');
        end = r.end;
      }
      if (end !== 1440) throw new Error('Khung giờ cuối phải kết thúc lúc 24:00');
    }
    if (!Array.isArray(config.holidays) || config.holidays.length > 366 || config.holidays.some(d =>
      typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d)) || new Date(d).toISOString().slice(0,10) !== d))
      throw new Error('Danh sách ngày lễ/Tết không hợp lệ');
    return { weekday: config.weekday.map(r => ({...r})), weekend: config.weekend.map(r => ({...r})), holidays: [...new Set(config.holidays)].sort() };
  }
  function quote(config, startsAt, endsAt, memberType = 'casual') {
    const start = +new Date(startsAt), end = +new Date(endsAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || (end-start)%1800000 || start%1800000 || end-start > 86400000)
      throw new Error('Chọn giờ theo ca 30 phút');
    const member = memberType === 'fixed' ? 'fixed' : 'casual', lines = [];
    let total = 0, standard = 0;
    for (let at = start; at < end; at += 1800000) {
      const d = new Date(at + 7*3600000), day = d.toISOString().slice(0,10), minute = d.getUTCHours()*60+d.getUTCMinutes();
      const group = [0,6].includes(d.getUTCDay()) || config.holidays.includes(day) ? 'weekend' : 'weekday';
      const rate = config[group].find(r => minute >= r.start && minute < r.end);
      if (!rate) throw new Error('Chưa có bảng giá cho khung giờ này');
      const amount = Math.round(rate[member]/2), standardAmount = Math.round(rate.casual/2);
      total += amount; standard += standardAmount;
      lines.push({ startsAt: new Date(at).toISOString(), endsAt: new Date(at+1800000).toISOString(), rate: rate[member], amount, group });
    }
    return { total, standard, memberType: member, lines };
  }
  return { defaults, validate, quote };
});
