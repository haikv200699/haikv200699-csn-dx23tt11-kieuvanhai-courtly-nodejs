const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { randomInt } = require('crypto');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const Pricing = require('../public/pricing.js');
const Staff = require(path.join(__dirname, 'staff-access.js'));
const StaffOps = require(path.join(__dirname, 'staff-operations.js'));

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'courtly-dev-secret-change-me';
const isProduction = process.env.NODE_ENV === 'production';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://courtly:courtly@localhost:5432/courtly',
  options: '-c timezone=Asia/Ho_Chi_Minh',
});

const app = express();
app.use(express.json());
const nm = (...p) => path.join(__dirname, '..', 'node_modules', ...p);
app.use('/vendor/gsap', express.static(nm('gsap', 'dist')));
app.use('/vendor/lenis', express.static(nm('lenis', 'dist')));
app.use('/vendor/fonts', express.static(nm('@fontsource'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
const server = http.createServer(app);
const io = new Server(server);

// ---------- helpers ----------
const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const sign = (u) => jwt.sign({ id: u.id, role: u.role, name: u.full_name, sv: u.session_version || 0 }, JWT_SECRET, { expiresIn: '7d' });
const randomAvatar = () => `animal-${randomInt(1, 11)}`;
const paymentSettings = async () => (await pool.query('SELECT bank_bin, bank_name, account_no, account_name, qr_image IS NOT NULL AS has_qr FROM payment_settings WHERE id=true')).rows[0];
const pub = (u) => ({
  id: u.id, email: u.email, fullName: u.full_name, phone: u.phone || '', role: u.role,
  memberType: u.member_type || 'casual',
  ...(u.role === 'staff' ? Staff.Access.config(u) : {}),
  avatarKey: u.role === 'admin' ? 'shuttlecock' : /^animal-(?:[1-9]|10)$/.test(u.avatar_key || '') ? u.avatar_key : 'animal-1',
});

async function authenticatedAccount(req) {
  let token;
  try { token = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET); }
  catch { Staff.fail(401, 'Bạn cần đăng nhập'); }
  const u = (await pool.query('SELECT * FROM users WHERE id=$1', [token.id])).rows[0];
  if (!u || u.disabled_at || (token.sv || 0) !== u.session_version) Staff.fail(401, 'Tài khoản đã bị khóa hoặc phiên đăng nhập đã hết hiệu lực');
  return u;
}
const auth = ah(async (req,res,next) => {
  req.user = await authenticatedAccount(req);
  Staff.authorize(req);
  // Staff operational responses do not expose account emails or aggregate historical revenue.
  if (req.user.role === 'staff') {
    const json = res.json.bind(res);
    res.json = data => {
      const clean = value => {
        if (Array.isArray(value)) return value.map(clean);
        if (!value || typeof value !== 'object' || value instanceof Date) return value;
        return Object.fromEntries(Object.entries(value).filter(([key]) => !['user_email','password_hash'].includes(key)).map(([key,v]) => [key, clean(v)]));
      };
      if(req.route.path === '/api/bookings/history' && data?.summary) data.summary.revenue = null;
      return json(clean(data));
    };
  }
  next();
});
const admin = (req,res,next) => ['admin','staff'].includes(req.user.role) ? next() : res.status(403).json({error:'Chỉ dành cho chủ sân hoặc ca trưởng'});
const maybeAuth = ah(async (req,res,next) => {
  if(req.headers.authorization) {
    try { req.user = await authenticatedAccount(req); } catch(e) { if(e.status !== 401) throw e; }
  }
  next();
});

const vnMinutes = (d) => Math.floor((d.getTime() + 7 * 3600e3) / 60000) % 1440;
const vnDay = (d) => new Date(d.getTime() + 7 * 3600e3).toISOString().slice(0, 10);
const bookingWindow = (day) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)) ||
      new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return false;
  const today = vnDay(new Date());
  const end = new Date(`${today}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 29);
  return day >= today && day <= end.toISOString().slice(0, 10);
};
const toMin = (t) => { const [h, m] = t.split(':'); return +h * 60 + +m; };

const courtsLive = async () =>
  (await pool.query(
    `SELECT c.*, v.status, v.next_start
     FROM courts c JOIN court_live_status v ON v.court_id = c.id ORDER BY c.id`
  )).rows;
const broadcast = async () => io.emit('courts:snapshot', await courtsLive());

// Cùng một câu UPDATE đảm bảo thao tác xác nhận thu tiền và hủy quá hạn không thể ghi đè nhau.
const expireUnconfirmedTransfers = async () => {
  const { rows } = await pool.query(
    `UPDATE bookings SET status = 'cancelled'
     WHERE status = 'confirmed' AND payment_method = 'transfer' AND paid = false
       AND confirmed_at <= now() - interval '10 minutes'
     RETURNING id, court_id, starts_at, ends_at`
  );
  if (rows.length) {
    rows.forEach((b) => io.emit('booking:cancelled', {
      bookingId: b.id, courtId: b.court_id, startsAt: b.starts_at, endsAt: b.ends_at,
    }));
    await broadcast();
  }
  return rows;
};

async function priceQuote(client, start, end, memberType) {
  return (await client.query('SELECT court_price_quote($1,$2,$3) AS quote', [start, end, memberType])).rows[0].quote;
}
app.get('/api/pricing', ah(async (_req, res) => {
  res.json((await pool.query('SELECT config, version FROM pricing_settings WHERE id=true')).rows[0]);
}));
app.put('/api/admin/pricing', auth, admin, ah(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Chỉ chủ sân được sửa bảng giá' });
  let config;
  try { config = Pricing.validate(req.body.config); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  if (!Number.isSafeInteger(req.body.version)) return res.status(400).json({ error: 'Tải lại bảng giá trước khi lưu' });
  const { rows } = await pool.query(`UPDATE pricing_settings SET config=$1,version=version+1,updated_at=now()
    WHERE id=true AND version=$2 RETURNING config,version`, [JSON.stringify(config), req.body.version]);
  if (!rows[0]) return res.status(409).json({ error: 'Bảng giá đã được thay đổi ở nơi khác. Đóng rồi mở lại để tải phiên bản mới.' });
  res.json(rows[0]); io.emit('pricing:updated', rows[0]);
}));

// ---------- auth ----------
app.post('/api/auth/register', ah(async (req, res) => {
  const { email = '', password = '', fullName = '', phone = '' } = req.body;
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Email không hợp lệ' });
  if (password.length < 6) return res.status(400).json({ error: 'Mật khẩu tối thiểu 6 ký tự' });
  if (!fullName.trim()) return res.status(400).json({ error: 'Vui lòng nhập họ tên' });
  const normalizedPhone = phone.replace(/[ .-]/g, '');
  if (!/^0\d{9,10}$/.test(normalizedPhone)) return res.status(400).json({ error: 'Số điện thoại không hợp lệ' });
  if ((await pool.query('SELECT id FROM users WHERE phone=$1 LIMIT 1', [normalizedPhone])).rowCount)
    return res.status(409).json({ error: 'Số điện thoại này đã được đăng ký' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash, full_name, phone, avatar_key) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [email.toLowerCase(), await bcrypt.hash(password, 10), fullName.trim(), normalizedPhone, randomAvatar()]
    );
    res.status(201).json({ token: sign(rows[0]), user: pub(rows[0]) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email này đã được đăng ký' });
    throw e;
  }
}));

app.post('/api/auth/login', ah(async (req, res) => {
  const identifier = String(req.body.email ?? req.body.identifier ?? '').trim();
  const password = String(req.body.password ?? '');
  const byEmail = identifier.includes('@');
  const normalizedPhone = identifier.replace(/[ .-]/g, '');
  const candidates = byEmail
    ? (await pool.query('SELECT * FROM users WHERE email = $1', [identifier.toLowerCase()])).rows
    : /^0\d{9,10}$/.test(normalizedPhone)
      ? (await pool.query('SELECT * FROM users WHERE phone = $1 ORDER BY id LIMIT 2', [normalizedPhone])).rows
      : [];
  if (!byEmail && candidates.length > 1)
    return res.status(409).json({ error: 'Số điện thoại thuộc nhiều tài khoản. Vui lòng đăng nhập bằng email.' });
  const u = candidates[0];
  if (!u || !(await bcrypt.compare(password, u.password_hash)))
    return res.status(401).json({ error: 'Sai email, số điện thoại hoặc mật khẩu' });
  if (u.disabled_at) return res.status(403).json({error:'Tài khoản đã bị chủ sân tạm khóa'});
  res.json({ token: sign(u), user: pub(u) });
}));

app.get('/api/me', auth, ah(async (req, res) => {
  const u = (await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
  u ? res.json(pub(u)) : res.status(401).json({ error: 'Tài khoản không tồn tại' });
}));

app.patch('/api/me', auth, ah(async (req, res) => {
  const { fullName, phone } = req.body;
  if (typeof fullName !== 'string' || !fullName.trim() || fullName.trim().length > 80)
    return res.status(400).json({ error: 'Họ tên phải có từ 1 đến 80 ký tự' });
  if (typeof phone !== 'string') return res.status(400).json({ error: 'Số điện thoại không hợp lệ' });
  const normalizedPhone = phone.replace(/[ .-]/g, '');
  if (!/^0\d{9,10}$/.test(normalizedPhone)) return res.status(400).json({ error: 'Số điện thoại không hợp lệ' });
  if ((await pool.query('SELECT id FROM users WHERE phone=$1 AND id<>$2 LIMIT 1', [normalizedPhone, req.user.id])).rowCount)
    return res.status(409).json({ error: 'Số điện thoại này đã thuộc tài khoản khác' });
  const { rows } = await pool.query(
    'UPDATE users SET full_name=$2, phone=$3 WHERE id=$1 RETURNING *',
    [req.user.id, fullName.trim(), normalizedPhone]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
  res.json(pub(rows[0]));
}));

// ---------- courts ----------
app.get('/api/courts', ah(async (_req, res) => res.json(await courtsLive())));

app.get('/api/courts/:id/booked', maybeAuth, ah(async (req, res) => {
  // Lấy cả 'confirmed' lẫn 'pending' còn hạn giữ chỗ, vì cả hai đều chiếm slot (khớp ràng buộc no_overlap trong DB).
  const { rows } = await pool.query(
    `SELECT starts_at, ends_at, status, user_id FROM bookings
     WHERE court_id = $1
       AND (status = 'confirmed' OR (status = 'pending' AND hold_expires_at > now()))
       AND starts_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
       AND starts_at < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh') ORDER BY starts_at`,
    [req.params.id, req.query.date]
  );
  // Loại trừ giữ chỗ của chính người đang xem, để họ vẫn thấy slot mình vừa chọn là "đang chọn" chứ không phải "bị chặn".
  const uid = req.user?.id;
  res.json(rows.filter((r) => r.status !== 'pending' || r.user_id !== uid)
    .map(({ starts_at, ends_at, status }) => ({ starts_at, ends_at, status })));
}));

// ---------- bookings ----------
//
// Luồng chống double-booking (2 bước):
//
// 1) HOLD  - Khách chọn khung giờ trống -> chèn ngay 1 dòng status='pending', hold_expires_at = now()+5'.
//            DB (ràng buộc EXCLUDE no_overlap, tương đương UNIQUE cho khoảng thời gian) sẽ TỰ CHẶN nếu
//            trùng với 1 pending/confirmed khác -> trả lỗi 409 ngay lập tức, không cần tự kiểm tra trước
//            (tránh race condition khi 2 người bấm cùng lúc).
//            Slot vừa hold được phát realtime (slot:held) để MỌI trình duyệt khác chuyển slot đó sang màu xám.
//
// 2) CONFIRM - Khách điền tên/SĐT/thanh toán rồi xác nhận -> chuyển pending -> confirmed (chỉ khi còn hạn giữ).
//
// Nếu khách không hoàn tất trong 5 phút (hoặc thoát trang): script định kỳ dưới cuối file sẽ xóa pending
// hết hạn và phát slot:released để nhả sân lại cho người khác - không cần khách phải làm gì.
app.post('/api/bookings/hold', auth, ah(async (req, res) => {
  const { courtId, startsAt, endsAt, playerName = '', playerPhone = '', paymentMethod = 'onsite' } = req.body;
  if (!['onsite', 'transfer'].includes(paymentMethod)) return res.status(400).json({ error: 'Phương thức thanh toán không hợp lệ' });
  const s = new Date(startsAt), e = new Date(endsAt);
  if (isNaN(s) || isNaN(e) || e <= s) return res.status(400).json({ error: 'Khung giờ không hợp lệ' });
  if (s < new Date()) return res.status(400).json({ error: 'Khung giờ này đã qua' });
  if (+s % 1800000 || +e % 1800000 || vnMinutes(s) < 300) return res.status(400).json({ error: 'Chọn ca 30 phút từ 05:00 đến 24:00' });
  if (!bookingWindow(vnDay(s))) return res.status(400).json({ error: 'Chỉ có thể đặt sân trong 30 ngày tới' });

  const court = (await pool.query('SELECT * FROM courts WHERE id = $1', [courtId])).rows[0];
  if (!court) return res.status(404).json({ error: 'Không tìm thấy sân' });
  if (court.under_maintenance) return res.status(409).json({ error: 'Sân đang bảo trì' });
  if (vnDay(s) !== vnDay(new Date(e - 1)) || vnMinutes(s) < toMin(court.open_time) || vnMinutes(new Date(e - 1)) >= toMin(court.close_time))
    return res.status(400).json({ error: 'Ngoài giờ mở cửa của sân' });

  try {
    // create_booking(): hàm SQL tạo booking pending + hold_expires_at = now()+5 phút (xem db/schema.sql mục 12).
    // Nếu trùng slot, ràng buộc EXCLUDE (no_overlap) sẽ khiến hàm này raise exception -> bắt bên dưới.
    const { rows } = await pool.query('SELECT * FROM create_booking($1,$2,$3,$4,$5,$6,$7)', [
      courtId, req.user.id, s, e,
      playerName.trim() || req.user.name || 'Đang giữ chỗ',
      playerPhone.replace(/[ .-]/g, '') || '0000000000',
      paymentMethod,
    ]);
    const id = rows[0].create_booking;
    const { rows: hr } = await pool.query('SELECT hold_expires_at, total_price, standard_price, discount_percent, pricing_snapshot FROM bookings WHERE id = $1', [id]);
    res.status(201).json({ id, holdExpiresAt: hr[0].hold_expires_at, totalPrice: hr[0].total_price,
      standardPrice: hr[0].standard_price, discountPercent: hr[0].discount_percent, pricing: hr[0].pricing_snapshot });
    io.emit('slot:held', { courtId: +courtId, startsAt: s, endsAt: e });
    broadcast();
  } catch (err) {
    if (err.code === '23P01' || /vừa được người khác giữ hoặc đặt/.test(err.message))
      return res.status(409).json({ error: 'Khung giờ này vừa có người đặt, hãy chọn giờ khác' });
    if (/Court không tồn tại|Thời gian|Thời lượng|Giờ bắt đầu/.test(err.message))
      return res.status(400).json({ error: err.message });
    throw err;
  }
}));

app.post('/api/bookings/:id/confirm', auth, ah(async (req, res) => {
  const { playerName = '', playerPhone = '', paymentMethod = 'onsite' } = req.body;
  if (!playerName.trim()) return res.status(400).json({ error: 'Vui lòng nhập tên người chơi' });
  if (!/^0\d{9,10}$/.test(playerPhone.replace(/[ .-]/g, ''))) return res.status(400).json({ error: 'Số điện thoại không hợp lệ' });
  if (!['onsite', 'transfer'].includes(paymentMethod)) return res.status(400).json({ error: 'Phương thức thanh toán không hợp lệ' });
  if (paymentMethod === 'transfer' && !await paymentSettings())
    return res.status(409).json({ error: 'Chủ sân chưa thiết lập tài khoản nhận chuyển khoản. Vui lòng chọn thanh toán tại sân.' });

  const { rows } = await pool.query(
    `UPDATE bookings SET status = 'confirmed', player_name = $1, player_phone = $2, payment_method = $3
     WHERE id = $4 AND user_id = $5 AND status = 'pending' AND hold_expires_at > now()
     RETURNING *`,
    [playerName.trim(), playerPhone.replace(/[ .-]/g, ''), paymentMethod, req.params.id, req.user.id]
  );
  const b = rows[0];
  if (!b) return res.status(410).json({ error: 'Đã hết thời gian giữ chỗ (5 phút), vui lòng chọn lại giờ' });
  const court = (await pool.query('SELECT name FROM courts WHERE id = $1', [b.court_id])).rows[0];
  res.json(b);
  io.emit('booking:created', { courtId: b.court_id });
  // Public realtime only invalidates lists; private details require an authorized API request.
  io.emit('admin:newBooking', { id: b.id, courtId: b.court_id });
  broadcast();
}));

const transferBooking = async (req) => {
  if (!/^\d+$/.test(req.params.id)) return null;
  const booking = (await pool.query(
    `SELECT id, user_id, status, payment_method, paid, total_price, confirmed_at, created_at
     FROM bookings WHERE id=$1`, [req.params.id]
  )).rows[0];
  return booking && (String(booking.user_id) === String(req.user.id) || ['admin', 'staff'].includes(req.user.role)) &&
    (booking.status === 'confirmed' || (booking.status === 'cancelled' && booking.confirmed_at)) &&
    booking.payment_method === 'transfer' ? booking : null;
};
app.get('/api/bookings/:id/payment', auth, ah(async (req, res) => {
  await expireUnconfirmedTransfers();
  const b = await transferBooking(req);
  if (!b)
    return res.status(404).json({ error: 'Không tìm thấy thông tin chuyển khoản' });
  const settings = await paymentSettings();
  const dueAt = new Date(+new Date(b.confirmed_at || b.created_at) + 10 * 60 * 1000).toISOString();
  const code = `COURTLY ${b.id}`;
  const invoice = (await pool.query('SELECT total-paid_amount AS due FROM booking_invoice_totals WHERE booking_id=$1',[b.id])).rows[0];
  const amount = Number(invoice.due);
  const qrUrl = b.status === 'confirmed' && !b.paid && Date.now() < +new Date(dueAt) && settings
    ? settings.has_qr ? `/api/bookings/${b.id}/payment/qr`
      : `https://img.vietqr.io/image/${settings.bank_bin}-${settings.account_no}-qr_only.png?amount=${amount}&addInfo=${encodeURIComponent(code)}&accountName=${encodeURIComponent(settings.account_name)}`
    : null;
  res.json({ id: b.id, status: b.status, paid: b.paid, amount, dueAt, code, qrUrl,
    bankName: settings?.bank_name || '', bankBin: settings?.bank_bin || '',
    accountNo: settings?.account_no || '', accountName: settings?.account_name || '' });
}));

app.get('/api/bookings/:id/payment/qr', auth, ah(async (req, res) => {
  const b = await transferBooking(req);
  if (!b || b.status !== 'confirmed' || b.paid || Date.now() >= +new Date(b.confirmed_at || b.created_at) + 10 * 60 * 1000)
    return res.status(404).json({ error: 'Mã QR không còn hiệu lực' });
  const { rows } = await pool.query('SELECT qr_image, qr_mime FROM payment_settings WHERE id=true');
  if (!rows[0]?.qr_image) return res.status(404).json({ error: 'Chưa có ảnh QR tải lên' });
  res.set('Cache-Control', 'private, no-store').set('X-Content-Type-Options', 'nosniff');
  res.type(rows[0].qr_mime).send(rows[0].qr_image);
}));

// Nhả sân sớm: gọi khi khách đổi lựa chọn giờ khác, hoặc rời trang (xem beforeunload ở app.js).
app.patch('/api/bookings/:id/release', auth, ah(async (req, res) => {
  const { rows } = await pool.query(
    `DELETE FROM bookings
     WHERE id = $1 AND user_id = $2 AND status = 'pending'
     RETURNING court_id, starts_at, ends_at`,
    [req.params.id, req.user.id]
  );
  const b = rows[0];
  res.json({ ok: !!b });
  if (b) { io.emit('slot:released', { courtId: b.court_id, startsAt: b.starts_at, endsAt: b.ends_at }); broadcast(); }
}));

app.get('/api/bookings/mine', auth, ah(async (req, res) => {
  const manager = ['admin', 'staff'].includes(req.user.role);
  const today = vnDay(new Date());
  const { rows } = await pool.query(
    `SELECT b.*, c.name AS court_name, c.district,
            (SELECT total FROM booking_invoice_totals WHERE booking_id=b.id) AS invoice_total,
            (SELECT paid_amount FROM booking_invoice_totals WHERE booking_id=b.id) AS paid_amount
     FROM bookings b JOIN courts c ON c.id = b.court_id
     WHERE (b.status = 'confirmed' OR (b.status = 'cancelled' AND b.confirmed_at IS NOT NULL))
       AND b.starts_at >= ($3::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
       AND b.starts_at < (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
       AND ($2::boolean OR b.user_id = $1)
     ORDER BY COALESCE(b.confirmed_at, b.created_at) DESC, b.id DESC`,
    [req.user.id, manager, today]
  );
  res.json(rows);
}));

// Toàn bộ booking đã xác nhận: lịch sắp tới, đã chơi và đã hủy; không chứa hold/pending.
app.get('/api/bookings/history', auth, ah(async (req, res) => {
  const manager = ['admin', 'staff'].includes(req.user.role);
  const page = Math.min(1000000, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  const filters = ['name', 'phone', 'court'].map((key) => String(req.query[key] || '').trim().slice(0, 100));
  const date = String(req.query.date || '').trim();
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date))
    return res.status(400).json({ error: 'Ngày chơi không hợp lệ' });
  const params = [req.user.id, manager, ...filters, date];
  const from = `FROM bookings b
    JOIN courts c ON c.id=b.court_id
    JOIN users u ON u.id=b.user_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(a.quantity::bigint * a.unit_price),0) addon_total,
        COALESCE(SUM(a.quantity::bigint * a.unit_price) FILTER (WHERE a.paid),0) paid_addon_total
      FROM booking_addons a WHERE a.booking_id=b.id
    ) x ON true`;
  const where = `WHERE (b.status='confirmed' OR (b.status='cancelled' AND b.confirmed_at IS NOT NULL))
    AND ($2::boolean OR b.user_id=$1)
    AND ($3='' OR position(lower($3) in lower(b.player_name)) > 0)
    AND ($4='' OR position(lower($4) in lower(b.player_phone)) > 0)
    AND ($5='' OR position(lower($5) in lower(c.name)) > 0)
    AND ($6='' OR (b.starts_at >= (nullif($6,'')::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
      AND b.starts_at < ((nullif($6,'')::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')))`;
  const [summary, list] = await Promise.all([
    pool.query(`SELECT count(*)::int total,
      count(*) FILTER (WHERE b.status='confirmed' AND b.ends_at > now())::int upcoming,
      count(*) FILTER (WHERE b.status='confirmed' AND b.ends_at <= now())::int completed,
      count(*) FILTER (WHERE b.status='cancelled')::int cancelled,
      coalesce(sum((SELECT total FROM booking_invoice_totals WHERE booking_id=b.id)) FILTER (WHERE b.status='confirmed' AND b.ends_at <= now()),0)::float8 revenue
      ${from} ${where}`, params),
    pool.query(`SELECT b.id, b.user_id, b.court_id, b.starts_at, b.ends_at, b.status, b.created_at, b.confirmed_at,
      b.player_name, b.player_phone, b.total_price, b.payment_method, b.paid,
      c.name court_name, c.district, u.email user_email,
      (SELECT total FROM booking_invoice_totals WHERE booking_id=b.id) AS invoice_total,
      (SELECT paid_amount FROM booking_invoice_totals WHERE booking_id=b.id) AS paid_amount
      ${from} ${where}
      ORDER BY COALESCE(b.confirmed_at, b.created_at) DESC, b.id DESC LIMIT $7 OFFSET $8`, [...params, limit, (page - 1) * limit]),
  ]);
  res.json({ rows: list.rows, summary: summary.rows[0], page, limit });
}));



// ---------- admin ----------
app.get('/api/admin/overview', auth, admin, ah(async (_req, res) => {
  const q = (sql) => pool.query(sql).then((r) => r.rows);
  const [[live], [today], [util], [misc]] = await Promise.all([
    q(`SELECT count(*)::int total, count(*) FILTER (WHERE status='PLAYING')::int playing,
              count(*) FILTER (WHERE status='AVAILABLE')::int available FROM court_live_status`),
    q(`SELECT count(*)::int n FROM bookings WHERE status='confirmed'
         AND starts_at >= current_date AND starts_at < current_date + 1`),
    q(`SELECT coalesce((SELECT sum(extract(epoch FROM (ends_at-starts_at))/60) FROM bookings
         WHERE status='confirmed' AND starts_at >= current_date AND starts_at < current_date + 1),0)
         / nullif((SELECT sum(extract(epoch FROM (close_time-open_time))/60) FROM courts),0) AS ratio`),
    q(`SELECT (SELECT count(*)::int FROM bookings WHERE status='cancelled' AND confirmed_at IS NOT NULL AND cancelled_at >= now() - interval '7 days') cancelled,
              (SELECT count(*)::int FROM users WHERE created_at >= now() - interval '7 days') new_users`),
  ]);
  res.json({ ...live, bookingsToday: today.n, utilization: Math.round((util.ratio || 0) * 100), ...misc });
}));

app.patch('/api/admin/courts/:id/maintenance', auth, admin, ah(async (req, res) => {
  await pool.query('UPDATE courts SET under_maintenance = $2 WHERE id = $1', [req.params.id, !!req.body.value]);
  res.json({ ok: true });
  broadcast();
}));

// Thêm sân mới
app.post('/api/admin/courts', auth, admin, ah(async (req, res) => {
  const { name = '', district = '', pricePerHour, openTime = '06:00', closeTime = '23:00', amenities = [] } = req.body;
  if (!name.trim()) return res.status(400).json({ error: 'Vui lòng nhập tên sân' });
  const price = Math.round(Number(pricePerHour));
  if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ error: 'Giá mỗi giờ không hợp lệ' });
  if (!/^\d{2}:\d{2}$/.test(openTime) || !/^\d{2}:\d{2}$/.test(closeTime) || toMin(openTime) >= toMin(closeTime))
    return res.status(400).json({ error: 'Giờ mở/đóng cửa không hợp lệ' });
  const { rows } = await pool.query(
    `INSERT INTO courts (name, district, price_per_hour, open_time, close_time, amenities) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [name.trim(), district.trim(), price, openTime, closeTime, Array.isArray(amenities) ? amenities.filter((a) => a && a.trim()).map((a) => a.trim()) : []]
  );
  res.status(201).json(rows[0]);
  broadcast();
}));

app.patch('/api/admin/courts/:id', auth, admin, ah(async (req, res) => {
  const { name = '', district = null, pricePerHour, openTime = '', closeTime = '' } = req.body;
  const price = Number(pricePerHour);
  const timeValid = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t) && toMin(t) % 30 === 0;
  if (!name.trim() || (district !== null && typeof district !== 'string') || !Number.isSafeInteger(price) || price <= 0 ||
      !timeValid(openTime) || !(closeTime === '24:00' || timeValid(closeTime)) || toMin(openTime) >= toMin(closeTime))
    return res.status(400).json({ error: 'Thông tin sân hoặc giờ mở/đóng không hợp lệ (giờ theo ca 30 phút)' });
  const { rowCount: conflicting } = await pool.query(
    `SELECT 1 FROM bookings WHERE court_id=$1 AND status IN ('confirmed','pending') AND ends_at > now()
     AND (extract(hour FROM starts_at AT TIME ZONE 'Asia/Ho_Chi_Minh') * 60 +
          extract(minute FROM starts_at AT TIME ZONE 'Asia/Ho_Chi_Minh') < $2 OR
          extract(hour FROM ends_at AT TIME ZONE 'Asia/Ho_Chi_Minh') * 60 +
          extract(minute FROM ends_at AT TIME ZONE 'Asia/Ho_Chi_Minh') +
          CASE WHEN (ends_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date > (starts_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN 1440 ELSE 0 END > $3) LIMIT 1`,
    [req.params.id, toMin(openTime), toMin(closeTime)]
  );
  if (conflicting) return res.status(409).json({ error: 'Giờ mở/đóng mới nằm ngoài booking sắp tới của sân' });
  try {
    const { rows } = await pool.query(
      `UPDATE courts SET name=$2, district=COALESCE($3,district), price_per_hour=$4, open_time=$5, close_time=$6,
       updated_at=now() WHERE id=$1 RETURNING *`,
      [req.params.id, name.trim(), district?.trim() ?? null, price, openTime, closeTime]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy sân' });
    res.json(rows[0]);
    broadcast();
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Tên sân đã tồn tại' });
    throw err;
  }
}));

// Xoá sân (chặn nếu sân đã có lịch đặt, để không mất dữ liệu lịch sử)
app.delete('/api/admin/courts/:id', auth, admin, ah(async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM courts WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Không tìm thấy sân' });
    res.json({ ok: true });
    broadcast();
  } catch (err) {
    if (err.code === '23503')
      return res.status(409).json({ error: 'Sân này đã có lịch đặt nên không thể xóa. Hãy dùng chế độ bảo trì thay vì xóa.' });
    throw err;
  }
}));

// Danh sách booking real-time, có lọc theo ngày / số điện thoại / tên / số tiền
app.get('/api/admin/bookings', auth, admin, ah(async (req, res) => {
  const { date, phone, name, minAmount, maxAmount } = req.query;
  const conds = []; const params = []; let i = 1;
  if (date) { conds.push(`b.starts_at >= $${i}::date AND b.starts_at < $${i}::date + 1`); params.push(date); i++; }
  if (phone) { conds.push(`b.player_phone ILIKE $${i}`); params.push('%' + phone.replace(/[ .-]/g, '') + '%'); i++; }
  if (name) { conds.push(`b.player_name ILIKE $${i}`); params.push('%' + name.trim() + '%'); i++; }
  if (minAmount) { conds.push(`b.total_price >= $${i}`); params.push(Number(minAmount) || 0); i++; }
  if (maxAmount) { conds.push(`b.total_price <= $${i}`); params.push(Number(maxAmount) || 0); i++; }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const { rows } = await pool.query(
    `SELECT b.id, b.court_id, c.name AS court_name, c.district, b.player_name, b.player_phone,
            b.starts_at, b.ends_at, b.total_price, b.payment_method, b.paid, b.status, b.created_at
     FROM bookings b JOIN courts c ON c.id = b.court_id
     ${where}
     ORDER BY b.created_at DESC LIMIT 300`,
    params
  );
  res.json(rows);
}));

// Admin/nhân viên xác nhận đã thực sự thu tiền sân, kể cả khi khách chuyển khoản.


// Xác nhận đã thu đủ tiền sân và toàn bộ dịch vụ trong cùng một giao dịch.


app.get('/api/admin/payment-settings', auth, admin, ah(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Chỉ chủ sân được sửa tài khoản nhận tiền' });
  res.set('Cache-Control', 'private, no-store');
  res.json(await paymentSettings() || null);
}));
// Mật khẩu của chính tài khoản admin đang đăng nhập cấp quyền sửa ngắn hạn.
app.post('/api/admin/payment-settings/unlock', auth, admin, ah(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Chỉ chủ sân được sửa tài khoản nhận tiền' });
  const password = req.body?.password;
  if (typeof password !== 'string' || !password || password.length > 256)
    return res.status(400).json({ error: 'Vui lòng nhập mật khẩu tài khoản quản trị' });
  const account = (await pool.query('SELECT role, password_hash FROM users WHERE id=$1', [req.user.id])).rows[0];
  if (!account || account.role !== 'admin' || !await bcrypt.compare(password, account.password_hash))
    return res.status(403).json({ error: 'Mật khẩu quản trị không đúng' });
  res.set('Cache-Control', 'no-store');
  res.json({ editToken: jwt.sign({ id: req.user.id, scope: 'payment-settings' }, JWT_SECRET, { expiresIn: '5m' }) });
}));
const paymentEditAllowed = (req) => {
  if (req.user.role !== 'admin') return false;
  try {
    const proof = jwt.verify(req.headers['x-payment-edit-token'] || '', JWT_SECRET);
    return proof.scope === 'payment-settings' && String(proof.id) === String(req.user.id);
  } catch { return false; }
};
app.put('/api/admin/payment-settings', auth, admin, ah(async (req, res) => {
  if (!paymentEditAllowed(req)) return res.status(403).json({ error: 'Nhập lại mật khẩu quản trị để sửa tài khoản nhận tiền' });
  const { bankBin, bankName, accountNo, accountName } = req.body;
  if (typeof bankBin !== 'string' || !/^\d{6}$/.test(bankBin.trim()) ||
      typeof accountNo !== 'string' || !/^[A-Za-z0-9]{4,19}$/.test(accountNo.trim()) ||
      typeof bankName !== 'string' || !bankName.trim() || bankName.trim().length > 80 ||
      typeof accountName !== 'string' || !accountName.trim() || accountName.trim().length > 80)
    return res.status(400).json({ error: 'Kiểm tra BIN (6 số), số tài khoản và tên ngân hàng/chủ tài khoản' });
  const { rows } = await pool.query(
    `INSERT INTO payment_settings (id, bank_bin, bank_name, account_no, account_name)
     VALUES (true,$1,$2,$3,$4)
     ON CONFLICT (id) DO UPDATE SET bank_bin=excluded.bank_bin, bank_name=excluded.bank_name,
       account_no=excluded.account_no, account_name=excluded.account_name, updated_at=now()
     RETURNING bank_bin, bank_name, account_no, account_name`,
    [bankBin.trim(), bankName.trim(), accountNo.trim(), accountName.trim()]
  );
  res.json(rows[0]);
}));

// Ảnh QR riêng của chủ sân; chỉ lưu định dạng bitmap nhỏ, không nhận SVG/script.
app.put('/api/admin/payment-settings/qr', auth, admin,
  express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '5mb' }), ah(async (req, res) => {
    if (!paymentEditAllowed(req)) return res.status(403).json({ error: 'Nhập lại mật khẩu quản trị để sửa ảnh QR' });
    const mime = (req.headers['content-type'] || '').split(';')[0].toLowerCase();
    const body = req.body;
    const image = Buffer.isBuffer(body) && body.length > 0 && body.length <= 5 * 1024 * 1024 && (
      mime === 'image/png' && body.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
      mime === 'image/jpeg' && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff ||
      mime === 'image/webp' && body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP'
    );
    if (!image) return res.status(400).json({ error: 'Chỉ hỗ trợ ảnh QR PNG, JPEG hoặc WebP tối đa 5 MB' });
    const { rowCount } = await pool.query(
      'UPDATE payment_settings SET qr_image=$1, qr_mime=$2, updated_at=now() WHERE id=true', [body, mime]
    );
    if (!rowCount) return res.status(409).json({ error: 'Hãy lưu tài khoản nhận tiền trước khi tải ảnh QR' });
    res.json({ ok: true });
  }));
app.get('/api/admin/payment-settings/qr', auth, admin, ah(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Chỉ chủ sân được xem ảnh QR' });
  const { rows } = await pool.query('SELECT qr_image, qr_mime FROM payment_settings WHERE id=true');
  if (!rows[0]?.qr_image) return res.status(404).json({ error: 'Chưa tải ảnh QR' });
  res.set('Cache-Control', 'private, no-store').set('X-Content-Type-Options', 'nosniff');
  res.type(rows[0].qr_mime).send(rows[0].qr_image);
}));
app.delete('/api/admin/payment-settings/qr', auth, admin, ah(async (req, res) => {
  if (!paymentEditAllowed(req)) return res.status(403).json({ error: 'Nhập lại mật khẩu quản trị để gỡ ảnh QR' });
  await pool.query('UPDATE payment_settings SET qr_image=NULL, qr_mime=NULL, updated_at=now() WHERE id=true');
  res.json({ ok: true });
}));

// Doanh thu theo ngày, cho một khoảng ngày tuỳ chọn (mặc định 7 ngày gần nhất)
app.get('/api/admin/revenue', auth, admin, ah(async (req, res) => {
  if(req.user.role==='staff') {
    const today=vnDay(new Date());
    if((req.query.from && req.query.from!==today)||(req.query.to && req.query.to!==today)) return res.status(403).json({error:'Ca trưởng chỉ được xem doanh thu hôm nay'});
    req.query.from=today; req.query.to=today;
  }
  const today = vnDay(new Date());
  const previous = new Date(`${today}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 6);
  const from = req.query.from === undefined ? previous.toISOString().slice(0, 10) : String(req.query.from);
  const to = req.query.to === undefined ? today : String(req.query.to);
  const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
  if (!validDate(from) || !validDate(to) || days < 0 || days > 365 || to > today)
    return res.status(400).json({ error: 'Chọn khoảng ngày hợp lệ, tối đa 366 ngày và không vượt quá hôm nay' });
  const { rows } = await pool.query(
    `SELECT to_char(d,'DD/MM/YY') label, to_char(d,'YYYY-MM-DD') date,
            count(b.id) FILTER (WHERE b.status='confirmed' AND b.ends_at <= now())::int bookings,
            coalesce(sum((SELECT total FROM booking_invoice_totals WHERE booking_id=b.id)) FILTER (WHERE b.status='confirmed' AND b.ends_at <= now()),0)::float8 revenue
     FROM generate_series($1::date, $2::date, interval '1 day') d
     LEFT JOIN bookings b ON b.starts_at >= (d::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
       AND b.starts_at < ((d + interval '1 day')::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
     LEFT JOIN LATERAL (SELECT COALESCE(SUM(quantity::bigint * unit_price),0) addon_total
                        FROM booking_addons WHERE booking_id=b.id) x ON true
     GROUP BY d ORDER BY d`,
    [from, to]
  );
  res.json({ rows, total: rows.reduce((s, r) => s + r.revenue, 0), bookings: rows.reduce((s, r) => s + r.bookings, 0) });
}));

// ---------- admin: tài khoản & quản lý sân ----------
const ROLES = ['staff', 'user'];

// Xếp hạng theo số booking đã hoàn thành. Hòa điểm: 90 ngày gần đây, lần chơi cuối, rồi ID.
// Gợi ý chơi đều: có booking trong từng tháng của ba tháng trọn vẹn gần nhất (giờ Việt Nam).
const ACCOUNT_METRICS = `WITH booking_stats AS (
  SELECT b.user_id,
    count(*)::int AS completed_count,
    count(*) FILTER (WHERE b.ends_at >= now() - interval '90 days')::int AS recent_count,
    count(*) FILTER (WHERE b.ends_at >= now() - interval '30 days')::int AS recent_30_count,
    count(DISTINCT date_trunc('month', b.ends_at AT TIME ZONE 'Asia/Ho_Chi_Minh')) FILTER (
      WHERE b.ends_at AT TIME ZONE 'Asia/Ho_Chi_Minh' >= date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '3 months'
        AND b.ends_at AT TIME ZONE 'Asia/Ho_Chi_Minh' < date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')
    )::int AS active_months_last_3,
    max(b.ends_at) AS last_play_at
  FROM bookings b WHERE b.status = 'confirmed' AND b.ends_at <= now()
  GROUP BY b.user_id
), ranked AS (
  SELECT u.id, u.email, u.full_name, u.phone, u.role, u.avatar_key, u.member_type, u.created_at, u.disabled_at,
    coalesce(s.completed_count,0) AS completed_count,
    coalesce(s.recent_count,0) AS recent_count,
    coalesce(s.recent_30_count,0) AS recent_30_count,
    coalesce(s.active_months_last_3,0) AS active_months_last_3,
    s.last_play_at,
    row_number() OVER (PARTITION BY u.role ORDER BY coalesce(s.completed_count,0) DESC,
      coalesce(s.recent_count,0) DESC, s.last_play_at DESC NULLS LAST, u.id ASC)::int AS booking_rank
  FROM users u LEFT JOIN booking_stats s ON s.user_id = u.id
  WHERE u.role IN ('user','staff')
)`;

app.get('/api/admin/accounts', auth, admin, ah(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Chỉ chủ sân được quản lý tài khoản' });
  const view = ['fixed','casual','staff'].includes(req.query.view) ? req.query.view : 'casual';
  const q = String(req.query.q || '').trim().slice(0,80);
  const page = Math.max(1, Math.min(10000, Number.parseInt(req.query.page, 10) || 1));
  const limit = 20;
  const filter = `WHERE (($1 = 'staff' AND role = 'staff') OR
    ($1 <> 'staff' AND role = 'user' AND member_type = $1))
    AND ($2 = '' OR full_name ILIKE '%' || $2 || '%' OR email ILIKE '%' || $2 || '%' OR coalesce(phone,'') ILIKE '%' || $2 || '%')`;
  const [list, count, summary] = await Promise.all([
    pool.query(`${ACCOUNT_METRICS} SELECT * FROM ranked ${filter} ORDER BY booking_rank ASC LIMIT $3 OFFSET $4`,
      [view, q, limit, (page - 1) * limit]),
    pool.query(`${ACCOUNT_METRICS} SELECT count(*)::int AS total FROM ranked ${filter}`, [view, q]),
    pool.query(`SELECT count(*) FILTER (WHERE role='user' AND member_type='fixed')::int AS fixed,
      count(*) FILTER (WHERE role='user' AND member_type='casual')::int AS casual,
      count(*) FILTER (WHERE role='staff')::int AS staff FROM users`),
  ]);
  res.json({ rows: list.rows, total: count.rows[0].total, summary: summary.rows[0],
    page, limit });
}));

app.patch('/api/admin/accounts/:id/membership', auth, admin, ah(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Chỉ chủ sân được áp dụng ưu đãi' });
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Mã tài khoản không hợp lệ' });
  const { memberType } = req.body;
  if (!['fixed','casual'].includes(memberType)) return res.status(400).json({ error: 'Loại thành viên không hợp lệ' });
  const { rows } = await pool.query(
    `UPDATE users SET member_type=$2, updated_at=now() WHERE id=$1 AND role='user'
     RETURNING id, member_type`, [req.params.id, memberType]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy tài khoản người chơi' });
  if (memberType === 'casual') await pool.query('UPDATE weekly_schedules SET active=false WHERE user_id=$1 AND active', [req.params.id]);
  io.emit('account:membershipUpdated', { userId: rows[0].id });
  res.json(rows[0]);
}));

app.patch('/api/admin/accounts/:id', auth, admin, ah(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Chỉ chủ sân được chỉnh sửa tài khoản' });
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Mã tài khoản không hợp lệ' });
  const { fullName, email, phone, memberType } = req.body || {};
  if (typeof fullName !== 'string' || !fullName.trim() || fullName.trim().length > 80)
    return res.status(400).json({ error: 'Họ tên phải có từ 1 đến 80 ký tự' });
  if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email.trim()))
    return res.status(400).json({ error: 'Email không hợp lệ' });
  if (typeof phone !== 'string') return res.status(400).json({ error: 'Số điện thoại không hợp lệ' });
  const normalizedPhone = phone.replace(/[ .-]/g, '');
  if (normalizedPhone && !/^0\d{9,10}$/.test(normalizedPhone))
    return res.status(400).json({ error: 'Số điện thoại không hợp lệ' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = (await client.query("SELECT id, role, member_type FROM users WHERE id=$1 AND role IN ('user','staff') FOR UPDATE", [req.params.id])).rows[0];
    if (!current) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy tài khoản' }); }
    if (current.role === 'user' && !['fixed', 'casual'].includes(memberType)) {
      await client.query('ROLLBACK'); return res.status(400).json({ error: 'Loại thành viên không hợp lệ' });
    }
    if (normalizedPhone && (await client.query('SELECT id FROM users WHERE phone=$1 AND id<>$2 LIMIT 1', [normalizedPhone, req.params.id])).rowCount) {
      await client.query('ROLLBACK'); return res.status(409).json({ error: 'Số điện thoại này đã thuộc tài khoản khác' });
    }
    const nextType = current.role === 'user' ? memberType : current.member_type;
    const updated = (await client.query(
      'UPDATE users SET full_name=$2, email=$3, phone=$4, member_type=$5, updated_at=now() WHERE id=$1 RETURNING id, full_name, email, phone, role, member_type',
      [req.params.id, fullName.trim(), email.trim().toLowerCase(), normalizedPhone || null, nextType]
    )).rows[0];
    if (current.role === 'user' && current.member_type === 'fixed' && nextType === 'casual')
      await client.query('UPDATE weekly_schedules SET active=false WHERE user_id=$1 AND active', [req.params.id]);
    await client.query('COMMIT');
    io.emit('account:membershipUpdated', { userId: updated.id });
    res.json(updated);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Email này đã được đăng ký' });
    throw err;
  } finally { client.release(); }
}));

// Đặt trước 30 ngày theo lịch cố định. Booking đã tạo là độc lập: đổi/hủy quy tắc
// không xóa booking hay hóa đơn; hủy từng booking từ màn hình chi tiết khi cần.
const scheduleDays = (weekday, now = new Date()) => {
  const start = vnDay(now);
  return Array.from({ length: 30 }, (_, i) => {
    const d = new Date(start + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + i);
    return d.getUTCDay() === weekday ? d.toISOString().slice(0, 10) : null;
  }).filter(Boolean);
};
async function materializeSchedule(client, rule, strict = false, replacedRuleId = null) {
  const created = [];
  if (rule.member_type !== 'fixed' || rule.under_maintenance || !rule.active || !rule.phone ||
      rule.start_min < Math.max(300, toMin(rule.open_time)) || rule.end_min > toMin(rule.close_time)) return created;
  for (const day of scheduleDays(Number(rule.weekday))) {
    const at = (minute) => new Date(`${day}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00+07:00`);
    const start = at(rule.start_min), end = at(rule.end_min);
    if (start <= new Date()) continue;
    // Khi sửa quy tắc, booking do lịch cũ tạo cho cùng ngày vẫn giữ nguyên.
    if (replacedRuleId) {
      const previous = await client.query('SELECT id FROM bookings WHERE schedule_rule_id=$1 AND schedule_date=$2', [replacedRuleId, day]);
      if (previous.rowCount) continue;
    }
    const exists = await client.query('SELECT id FROM bookings WHERE schedule_rule_id=$1 AND schedule_date=$2', [rule.id, day]);
    if (exists.rowCount) continue; // Kể cả lần đặt cố định đã bị hủy thủ công.
    const occupied = await client.query(
      `SELECT id FROM bookings WHERE user_id=$1 AND status IN ('confirmed','pending')
       AND (status='confirmed' OR hold_expires_at > now())
       AND starts_at < $3 AND ends_at > $2 LIMIT 1`, [rule.user_id, start, end]
    );
    if (occupied.rowCount) {
      if (strict) { const err = new Error(`Người chơi đã có lịch vào ${day}`); err.code = '23P01'; throw err; }
      continue;
    }
    const quote = await priceQuote(client, start, end, 'fixed');
    const standard = quote.standard;
    if (!strict) await client.query('SAVEPOINT recurring_occurrence');
    try {
      const { rows } = await client.query(
        `INSERT INTO bookings (court_id,user_id,starts_at,ends_at,status,total_price,standard_price,
         discount_percent,player_name,player_phone,payment_method,paid,confirmed_at,schedule_rule_id,schedule_date,pricing_snapshot)
         VALUES ($1,$2,$3,$4,'confirmed',$5,$6,0,$7,$8,'onsite',false,now(),$9,$10,$11)
         ON CONFLICT (schedule_rule_id,schedule_date) WHERE schedule_rule_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [rule.court_id, rule.user_id, start, end, quote.total, standard,
          rule.full_name, rule.phone, rule.id, day, JSON.stringify(quote)]
      );
      if (rows[0]) created.push(rows[0].id);
      if (!strict) await client.query('RELEASE SAVEPOINT recurring_occurrence');
    } catch (err) {
      if (strict || err.code !== '23P01') throw err;
      await client.query('ROLLBACK TO SAVEPOINT recurring_occurrence');
      await client.query('RELEASE SAVEPOINT recurring_occurrence');
    }
  }
  return created;
}
const scheduleDetails = `SELECT s.*, u.full_name, u.phone, u.member_type, c.name AS court_name,
  c.open_time, c.close_time, c.price_per_hour, c.under_maintenance
  FROM weekly_schedules s JOIN users u ON u.id=s.user_id JOIN courts c ON c.id=s.court_id`;

app.get('/api/admin/accounts/:id/schedule', auth, admin, ah(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Chỉ chủ sân được xem lịch cố định' });
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Tài khoản không hợp lệ' });
  const { rows } = await pool.query(`${scheduleDetails} WHERE s.user_id=$1 AND s.active ORDER BY s.weekday,s.start_min`, [req.params.id]);
  res.json(rows);
}));
app.post('/api/admin/accounts/:id/schedule', auth, admin, ah(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Chỉ chủ sân được đặt lịch cố định' });
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Tài khoản không hợp lệ' });
  const { courtId, weekday, start, end } = req.body || {};
  const minute = (value) => typeof value === 'string' && (value === '24:00' || /^([01]\d|2[0-3]):(00|30)$/.test(value)) ? toMin(value) : NaN;
  const from = minute(start), to = minute(end);
  if (!Number.isInteger(Number(courtId)) || !Number.isInteger(Number(weekday)) || Number(weekday) < 0 || Number(weekday) > 6 ||
      !Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 180)
    return res.status(400).json({ error: 'Chọn sân, thứ và khung giờ 30 phút (tối đa 3 giờ)' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const person = (await client.query("SELECT id, member_type, phone FROM users WHERE id=$1 AND role='user' FOR UPDATE", [req.params.id])).rows[0];
    if (!person || person.member_type !== 'fixed' || !person.phone)
      return void (await client.query('ROLLBACK'), res.status(409).json({ error: 'Chỉ tài khoản cố định có số điện thoại mới được đặt lịch tuần' }));
    const court = (await client.query('SELECT * FROM courts WHERE id=$1', [courtId])).rows[0];
    if (!court || court.under_maintenance || from < Math.max(300, toMin(court.open_time)) || to > toMin(court.close_time))
      return void (await client.query('ROLLBACK'), res.status(409).json({ error: 'Sân đang bảo trì hoặc giờ chơi ngoài giờ mở cửa' }));
    const duplicate = await client.query('SELECT id FROM weekly_schedules WHERE user_id=$1 AND court_id=$2 AND weekday=$3 AND start_min=$4 AND end_min=$5 AND active',
      [req.params.id, courtId, weekday, from, to]);
    if (duplicate.rowCount) return void (await client.query('ROLLBACK'), res.status(409).json({ error: 'Khung giờ cố định này đã tồn tại' }));
    const inserted = (await client.query(
      'INSERT INTO weekly_schedules (user_id,court_id,weekday,start_min,end_min) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [req.params.id, courtId, weekday, from, to]
    )).rows[0];
    const rule = (await client.query(`${scheduleDetails} WHERE s.id=$1`, [inserted.id])).rows[0];
    const created = await materializeSchedule(client, rule, true);
    await client.query('COMMIT');
    res.status(201).json({ rule, created: created.length });
    if (created.length) { io.emit('booking:created', { courtId: Number(courtId) }); broadcast(); }
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23P01' || err.code === '23505') return res.status(409).json({ error: `Lịch cố định bị trùng booking trong 30 ngày tới${err.message.startsWith('Người chơi') ? ': ' + err.message : ''}. Hãy chọn sân hoặc giờ khác.` });
    throw err;
  } finally { client.release(); }
}));
app.patch('/api/admin/accounts/:id/schedule/:ruleId', auth, admin, ah(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Chỉ chủ sân được sửa lịch cố định' });
  if (!/^\d+$/.test(req.params.id) || !/^\d+$/.test(req.params.ruleId)) return res.status(400).json({ error: 'Mã lịch không hợp lệ' });
  const { courtId, weekday, start, end } = req.body || {};
  const minute = (value) => typeof value === 'string' && (value === '24:00' || /^([01]\d|2[0-3]):(00|30)$/.test(value)) ? toMin(value) : NaN;
  const from = minute(start), to = minute(end);
  if (!Number.isInteger(Number(courtId)) || !Number.isInteger(Number(weekday)) || Number(weekday) < 0 || Number(weekday) > 6 ||
      !Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 180)
    return res.status(400).json({ error: 'Chọn sân, thứ và khung giờ 30 phút (tối đa 3 giờ)' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const person = (await client.query("SELECT id, member_type, phone FROM users WHERE id=$1 AND role='user' FOR UPDATE", [req.params.id])).rows[0];
    if (!person || person.member_type !== 'fixed' || !person.phone) {
      await client.query('ROLLBACK'); return res.status(409).json({ error: 'Chỉ tài khoản cố định có số điện thoại mới được sửa lịch tuần' });
    }
    const old = (await client.query('SELECT * FROM weekly_schedules WHERE id=$1 AND user_id=$2 AND active FOR UPDATE',
      [req.params.ruleId, req.params.id])).rows[0];
    if (!old) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy lịch cố định' }); }
    const court = (await client.query('SELECT * FROM courts WHERE id=$1', [courtId])).rows[0];
    if (!court || court.under_maintenance || from < Math.max(300, toMin(court.open_time)) || to > toMin(court.close_time)) {
      await client.query('ROLLBACK'); return res.status(409).json({ error: 'Sân đang bảo trì hoặc giờ chơi ngoài giờ mở cửa' });
    }
    if (Number(old.court_id) === Number(courtId) && Number(old.weekday) === Number(weekday) &&
        Number(old.start_min) === from && Number(old.end_min) === to) {
      await client.query('COMMIT'); return res.json({ rule: old, created: 0 });
    }
    const duplicate = await client.query(
      'SELECT id FROM weekly_schedules WHERE user_id=$1 AND court_id=$2 AND weekday=$3 AND start_min=$4 AND end_min=$5 AND active AND id<>$6',
      [req.params.id, courtId, weekday, from, to, req.params.ruleId]);
    if (duplicate.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Khung giờ cố định này đã tồn tại' }); }
    await client.query('UPDATE weekly_schedules SET active=false WHERE id=$1 AND user_id=$2 AND active', [req.params.ruleId, req.params.id]);
    const inserted = (await client.query(
      'INSERT INTO weekly_schedules (user_id,court_id,weekday,start_min,end_min) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [req.params.id, courtId, weekday, from, to]
    )).rows[0];
    const rule = (await client.query(`${scheduleDetails} WHERE s.id=$1`, [inserted.id])).rows[0];
    const created = await materializeSchedule(client, rule, false, Number(old.id));
    await client.query('COMMIT');
    res.json({ rule, created: created.length });
    if (created.length) { io.emit('booking:created', { courtId: Number(courtId) }); broadcast(); }
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23P01' || err.code === '23505') return res.status(409).json({ error: 'Lịch cố định bị trùng booking. Hãy chọn sân hoặc giờ khác.' });
    throw err;
  } finally { client.release(); }
}));
app.delete('/api/admin/accounts/:id/schedule/:ruleId', auth, admin, ah(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Chỉ chủ sân được sửa lịch cố định' });
  if (!/^\d+$/.test(req.params.id) || !/^\d+$/.test(req.params.ruleId)) return res.status(400).json({ error: 'Mã lịch không hợp lệ' });
  const { rowCount } = await pool.query('UPDATE weekly_schedules SET active=false WHERE id=$1 AND user_id=$2 AND active', [req.params.ruleId, req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Không tìm thấy lịch cố định' });
  res.json({ ok: true });
}));

async function replenishWeeklySchedules() {
  const { rows } = await pool.query(`${scheduleDetails} WHERE s.active AND u.member_type='fixed' AND NOT c.under_maintenance`);
  let changed = false;
  for (const rule of rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT active FROM weekly_schedules WHERE id=$1 FOR UPDATE', [rule.id]);
      if (current.rows[0]?.active) {
        const created = await materializeSchedule(client, rule);
        await client.query('COMMIT');
        if (created.length) { changed = true; io.emit('booking:created', { courtId: rule.court_id }); }
      } else await client.query('ROLLBACK');
    } catch (err) { await client.query('ROLLBACK'); console.error('Không thể bổ sung lịch cố định:', err.message); }
    finally { client.release(); }
  }
  if (changed) await broadcast();
}

// Tạo tài khoản nhân viên quản lý (staff) hoặc người chơi (user)
app.post('/api/admin/accounts', auth, admin, ah(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Chỉ chủ sân được tạo tài khoản' });
  const { email = '', password = '', fullName = '', phone = '', role = 'user' } = req.body;
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Email không hợp lệ' });
  if (password.length < 6) return res.status(400).json({ error: 'Mật khẩu tối thiểu 6 ký tự' });
  if (!fullName.trim()) return res.status(400).json({ error: 'Vui lòng nhập họ tên' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Vai trò không hợp lệ' });
  const normalizedPhone = phone.replace(/[ .-]/g, '');
  if (normalizedPhone && !/^0\d{9,10}$/.test(normalizedPhone)) return res.status(400).json({ error: 'Số điện thoại không hợp lệ' });
  if (normalizedPhone && (await pool.query('SELECT id FROM users WHERE phone=$1 LIMIT 1', [normalizedPhone])).rowCount)
    return res.status(409).json({ error: 'Số điện thoại này đã được đăng ký' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash, full_name, phone, role, avatar_key) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, email, full_name, phone, role, avatar_key, created_at',
      [email.toLowerCase(), await bcrypt.hash(password, 10), fullName.trim(), normalizedPhone || null, role, randomAvatar()]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email này đã được đăng ký' });
    throw e;
  }
}));

// Lịch công khai chỉ có khoảng giờ và nhãn cố định; thông tin cá nhân vẫn riêng cho quản trị.
app.get('/api/schedule', ah(async (req, res) => {
  const date = String(req.query.date || vnDay(new Date()));
  if (!bookingWindow(date)) return res.status(400).json({ error: 'Chọn ngày hợp lệ trong 30 ngày tới' });
  const [courts, bookings] = await Promise.all([
    pool.query('SELECT id, name, price_per_hour, open_time, close_time, under_maintenance FROM courts ORDER BY id'),
    pool.query(`SELECT court_id, starts_at, ends_at, status, (schedule_rule_id IS NOT NULL) AS is_fixed
                FROM bookings WHERE status IN ('confirmed','pending')
                  AND starts_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
                  AND starts_at < (($1::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
                  AND (status='confirmed' OR hold_expires_at > now())
                ORDER BY starts_at`, [date])
  ]);
  res.json({ date, courts: courts.rows, bookings: bookings.rows });
}));

// Quản trị xem thêm chi tiết booking của từng ca.
app.get('/api/admin/schedule', auth, admin, ah(async (req, res) => {
  const date = String(req.query.date || vnDay(new Date()));
  if (!bookingWindow(date)) return res.status(400).json({ error: 'Chọn ngày hợp lệ trong 30 ngày tới' });
  const [courts, bookings] = await Promise.all([
    pool.query(`SELECT id, name, district, price_per_hour, open_time, close_time, under_maintenance
                FROM courts ORDER BY id`),
    pool.query(`SELECT b.id, b.court_id, b.user_id, b.starts_at, b.ends_at, b.status, b.schedule_rule_id,
                       b.player_name, b.player_phone, b.payment_method, b.paid, b.total_price,
                       b.created_at, b.confirmed_at, b.hold_expires_at, u.email AS user_email,
                       (SELECT total FROM booking_invoice_totals WHERE booking_id=b.id) AS invoice_total,
            (SELECT paid_amount FROM booking_invoice_totals WHERE booking_id=b.id) AS paid_amount
                FROM bookings b
                LEFT JOIN users u ON u.id = b.user_id
                WHERE b.status IN ('confirmed','pending')
                  AND b.starts_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
                  AND b.starts_at < (($1::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
                  AND (b.status = 'confirmed' OR b.hold_expires_at > now())
                ORDER BY b.starts_at`, [date])
  ]);
  res.json({ date, courts: courts.rows, bookings: bookings.rows });
}));

// Nguồn dữ liệu là chính booking đã confirmed (player_name/player_phone lúc đặt), không phải toàn bộ
// bảng users, vì tên/SĐT thực tế lúc chơi có thể khác thông tin đăng ký tài khoản.
// Không có ?q -> trả về những người chơi gần đây nhất (để admin thấy gợi ý ngay cả khi chưa gõ gì).
app.get('/api/admin/players', auth, admin, ah(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0,80);
  if(req.user.role==='staff' && q.replace(/[%_]/g,'').length<2) return res.json([]);
  const { rows } = await pool.query(
    `SELECT id, full_name, phone, last_booking_at FROM (
       SELECT DISTINCT ON (COALESCE(NULLIF(b.player_phone, ''), b.player_name))
         CASE WHEN u.role = 'user' AND u.phone = b.player_phone THEN b.user_id ELSE NULL END AS id,
         CASE WHEN u.role = 'user' AND u.phone = b.player_phone THEN u.member_type ELSE NULL END AS member_type,
         b.player_name AS full_name, b.player_phone AS phone, b.starts_at AS last_booking_at
       FROM bookings b
       LEFT JOIN users u ON u.id = b.user_id
       WHERE b.status = 'confirmed'
         AND NULLIF(trim(b.player_name), '') IS NOT NULL
       ORDER BY COALESCE(NULLIF(b.player_phone, ''), b.player_name), b.starts_at DESC
     ) t
     WHERE $1 = '' OR full_name ILIKE '%' || $1 || '%' OR phone ILIKE '%' || $1 || '%'
     ORDER BY last_booking_at DESC
     LIMIT 20`,
    [q]
  );
  if (!q) return res.json(rows);
  const accounts = (await pool.query(
    `SELECT id, full_name, phone, member_type, NULL::timestamptz AS last_booking_at
     FROM users WHERE role='user' AND
       (full_name ILIKE '%' || $1 || '%' OR coalesce(phone,'') ILIKE '%' || $1 || '%')
     ORDER BY full_name LIMIT 20`, [q]
  )).rows;
  const phones = new Set(accounts.map((u) => u.phone).filter(Boolean));
  res.json([...accounts, ...rows.filter((r) => !r.phone || !phones.has(r.phone))].slice(0,20));
}));

// Lịch đặt sắp tới của một sân
app.get('/api/admin/courts/:id/bookings', auth, admin, ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, user_id, starts_at, ends_at, status, total_price, player_name, player_phone, payment_method, paid
     FROM bookings
     WHERE court_id = $1 AND status = 'confirmed' AND ends_at > now()
     ORDER BY starts_at LIMIT 200`,
    [req.params.id]
  );
  res.json(rows);
}));

// Admin gán lịch cho người chơi: tạo booking confirmed trực tiếp
app.post('/api/admin/bookings', auth, admin, ah(async (req, res) => {
  const { courtId, startsAt, endsAt, userId = null, playerName = '', playerPhone = '', paymentMethod = 'onsite' } = req.body;
  const s = new Date(startsAt), e = new Date(endsAt);
  if (isNaN(s) || isNaN(e) || e <= s) return res.status(400).json({ error: 'Khung giờ không hợp lệ' });
  if (e - s > 3 * 3600000) return res.status(400).json({ error: 'Booking mới tối đa 3 giờ; có thể gia hạn sau' });
  if (s < new Date()) return res.status(400).json({ error: 'Khung giờ này đã qua' });
  if (+s % 1800000 || +e % 1800000 || vnMinutes(s) < 300) return res.status(400).json({ error: 'Chọn ca 30 phút từ 05:00 đến 24:00' });
  if (!bookingWindow(vnDay(s))) return res.status(400).json({ error: 'Chỉ có thể gán lịch trong 30 ngày tới' });
  if (!['onsite', 'transfer'].includes(paymentMethod)) return res.status(400).json({ error: 'Phương thức thanh toán không hợp lệ' });
  if (!playerName.trim()) return res.status(400).json({ error: 'Vui lòng nhập tên người chơi' });
  const phone = playerPhone.replace(/[ .-]/g, '');
  if (!/^0\d{9,10}$/.test(phone)) return res.status(400).json({ error: 'Số điện thoại không hợp lệ' });

  const court = (await pool.query('SELECT * FROM courts WHERE id = $1', [courtId])).rows[0];
  if (!court) return res.status(404).json({ error: 'Không tìm thấy sân' });
  if (court.under_maintenance) return res.status(409).json({ error: 'Sân đang bảo trì' });
  if (vnDay(s) !== vnDay(new Date(e - 1)) || vnMinutes(s) < toMin(court.open_time) || vnMinutes(new Date(e - 1)) >= toMin(court.close_time))
    return res.status(400).json({ error: 'Ngoài giờ mở cửa của sân' });

  // Gắn vào tài khoản người chơi:
  // 1) Nếu admin chọn sẵn từ ô tìm kiếm (userId) -> dùng luôn.
  // 2) Nếu không chọn nhưng SĐT trùng với người chơi đã từng đặt sân / đã có tài khoản -> tự nhận diện,
  //    tránh gán nhầm booking vào tài khoản admin (bug cũ khiến lịch không hiện đúng chủ).
  // 3) Không tìm thấy (khách vãng lai hoàn toàn mới) -> ghi nhận tạm dưới tài khoản admin.
  let uid = null;
  let memberType = 'casual';
  if (userId) {
    const u = (await pool.query("SELECT id, member_type FROM users WHERE id = $1 AND role = 'user'", [userId])).rows[0];
    if (!u) return res.status(400).json({ error: 'Tài khoản người chơi không tồn tại' });
    uid = u.id;
    memberType = u.member_type;
  } else {
    const byBooking = (await pool.query(
      `SELECT u.id, u.member_type FROM bookings b JOIN users u ON u.id = b.user_id AND u.role = 'user'
       WHERE b.player_phone = $1 AND b.status = 'confirmed' ORDER BY b.starts_at DESC LIMIT 1`,
      [phone]
    )).rows[0];
    const byAccount = byBooking ? null : (await pool.query(
      "SELECT id, member_type FROM users WHERE phone = $1 AND role = 'user'", [phone]
    )).rows[0];
    const account = byBooking || byAccount;
    uid = account?.id || req.user.id;
    memberType = account?.member_type || 'casual';
  }

  const quote = await priceQuote(pool, s, e, memberType);
  const standardPrice = quote.standard, price = quote.total, discountPercent = 0;
  try {
    const rows = await StaffOps.transaction(pool, req.user, async (db, user) => {
      Staff.requirePermission(user, 'bookingCreate');
      const { rows } = await db.query(
      `INSERT INTO bookings (court_id, user_id, starts_at, ends_at, status, total_price, standard_price, discount_percent, player_name, player_phone, payment_method, paid, confirmed_at, pricing_snapshot)
       VALUES ($1,$2,$3,$4,'confirmed',$5,$6,$7,$8,$9,$10,$11,now(),$12) RETURNING *`,
      [courtId, uid, s, e, price, standardPrice, discountPercent, playerName.trim(), phone, paymentMethod, false, JSON.stringify(quote)]
    );
      await Staff.audit(db,user,'booking.create',rows[0].id,'',null,rows[0]);
      return rows;
    });
    res.status(201).json({ ok: true, id: rows[0].id, totalPrice: price, discountPercent, pricing: quote });
    io.emit('booking:created', { courtId: rows[0].court_id });
    broadcast();
  } catch (err) {
    if (err.code === '23P01') return res.status(409).json({ error: 'Khung giờ này đã có người đặt' });
    if (err.code === '23514') return res.status(400).json({ error: 'Thời lượng tối đa 3 giờ, tối thiểu 30 phút, bắt đầu lúc phút 00 hoặc 30' });
    throw err;
  }
}));

// Bảng kê tiền sân và các khoản phát sinh của một booking.
async function bookingBill(id) {
  const { rows } = await pool.query(
    `SELECT b.*, c.name AS court_name, c.district, u.email AS user_email
     FROM bookings b JOIN courts c ON c.id=b.court_id
     LEFT JOIN users u ON u.id=b.user_id WHERE b.id=$1`, [id]
  );
  const booking = rows[0];
  if (!booking) return null;
  const addons = (await pool.query(
    `SELECT id, kind, label, quantity, unit_price, paid, created_at
     FROM booking_addons WHERE booking_id=$1 ORDER BY id`, [id]
  )).rows;
  const lines = (await pool.query('SELECT * FROM booking_charge_lines WHERE booking_id=$1 ORDER BY line_id', [id])).rows;
  const byId = new Map(lines.map(l => [String(l.line_id), l]));
  const base = Number(booking.total_price);
  const addonTotal = addons.reduce((sum, a) => sum + a.quantity * a.unit_price, 0);
  const discount = lines.reduce((sum,l) => sum + Number(l.discount),0);
  const paidAmount = lines.reduce((sum,l) => sum + (l.paid ? Number(l.net) : 0),0);
  const total = base + addonTotal - discount;
  addons.forEach(a => { a.net = Number(byId.get(String(a.id))?.net ?? a.quantity*a.unit_price); });
  return { booking, addons, base, baseNet: Number(byId.get('0')?.net ?? base), addonTotal,
    subtotal: base + addonTotal, discount, total, paidAmount, due: total - paidAmount };

}
const validBookingId = (id) => /^\d+$/.test(String(id));
app.get('/api/bookings/:id/invoice', auth, ah(async (req, res) => {
  if (!validBookingId(req.params.id)) return res.status(400).json({ error: 'Mã booking không hợp lệ' });
  const bill = await bookingBill(req.params.id);
  if (!bill || (req.user.role !== 'admin' && req.user.role !== 'staff' && String(bill.booking.user_id) !== String(req.user.id)) ||
      (bill.booking.status !== 'confirmed' && !(bill.booking.status === 'cancelled' && bill.booking.confirmed_at)))
    return res.status(404).json({ error: 'Không tìm thấy hóa đơn' });
  res.json(bill);
}));
app.get('/api/admin/bookings/:id/bill', auth, admin, ah(async (req, res) => {
  if (!validBookingId(req.params.id)) return res.status(400).json({ error: 'Mã booking không hợp lệ' });
  const bill = await bookingBill(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Không tìm thấy booking' });
  res.json(bill);
}));



// Gia hạn chính booking hiện tại; khóa hàng để hai nhân viên không gia hạn đè nhau.








StaffOps.register({app,auth,admin,ah,pool,io,broadcast,priceQuote,vnDay,vnMinutes,toMin,bookingWindow});

// ---------- realtime ----------
io.on('connection', async (socket) => socket.emit('courts:snapshot', await courtsLive()));

// PLAYING/RESERVED đổi theo thời gian chứ không chỉ theo booking -> kiểm tra định kỳ, chỉ phát khi có thay đổi
let last = '';
setInterval(async () => {
  try {
    const rows = await courtsLive();
    const sig = JSON.stringify(rows.map((r) => [r.id, r.status, r.under_maintenance]));
    if (sig !== last) { last = sig; io.emit('courts:snapshot', rows); }
  } catch (e) { console.error(e.message); }
}, 30_000);

// Tự động nhả sân: xóa pending quá hạn 5 phút (hold_expires_at <= now()) và trả lại cho người khác.
// Đây là "script tự động" chạy định kỳ phía server thay cho Event Scheduler của MySQL (Postgres không có
// sẵn cơ chế này, giải pháp tương đương là extension pg_cron hoặc scheduler ở tầng ứng dụng như dưới đây).
setInterval(async () => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM bookings
       WHERE status = 'pending' AND hold_expires_at <= now()
       RETURNING court_id, starts_at, ends_at`
    );
    if (rows.length) {
      rows.forEach((r) => io.emit('slot:released', { courtId: r.court_id, startsAt: r.starts_at, endsAt: r.ends_at }));
      broadcast();
    }
  } catch (e) { console.error('expire pending:', e.message); }
}, 15_000);

// Booking chuyển khoản chỉ giữ sân tối đa 10 phút nếu admin chưa xác nhận đã thu tiền.
// Chạy lại khi khởi động để xử lý cả khoảng thời gian server ngừng hoạt động.
setInterval(() => expireUnconfirmedTransfers().catch((e) => console.error('expire transfers:', e.message)), 5_000);

app.use((err, _req, res, _next) => {
  if (err.status) return res.status(err.status).json({error:err.message});
  if (err.code === '23P01') return res.status(409).json({error:'Khung giờ này đã có người đặt hoặc đang giữ chỗ'});
  if (err.code === '23514') return res.status(409).json({error:'Thao tác vượt giới hạn dữ liệu cho phép'});
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Ảnh QR vượt quá 5 MB' });
  console.error(err); res.status(500).json({ error: 'Lỗi máy chủ' });
});

// ---------- migrate + seed ----------
async function waitForDatabase(maxAttempts = 30) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      lastError = err;
      console.log(`Đang chờ PostgreSQL... (${attempt}/${maxAttempts})`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError;
}

async function bootstrapProductionAdmin() {
  const adminCount = (await pool.query("SELECT count(*)::int AS n FROM users WHERE role = 'admin'")).rows[0].n;
  if (adminCount > 0) return;
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 12)
    throw new Error('Admin đầu tiên cần ADMIN_EMAIL hợp lệ và ADMIN_PASSWORD tối thiểu 12 ký tự.');
  if ((await pool.query('SELECT 1 FROM users WHERE email=$1', [email])).rowCount)
    throw new Error('ADMIN_EMAIL đã thuộc tài khoản khác; chọn email quản trị mới.');
  await pool.query(
    'INSERT INTO users (email,password_hash,full_name,role) VALUES ($1,$2,$3,$4)',
    [email, await bcrypt.hash(password, 12), 'Quản trị viên', 'admin']
  );
  console.log('Đã tạo tài khoản quản trị đầu tiên.');
}

async function setup() {
  if (isProduction && (!process.env.JWT_SECRET || Buffer.byteLength(process.env.JWT_SECRET) < 32))
    throw new Error('Production cần JWT_SECRET ngẫu nhiên tối thiểu 32 byte.');
  if (isProduction && !process.env.DATABASE_URL)
    throw new Error('Production cần DATABASE_URL của PostgreSQL.');
  await waitForDatabase();
  // ------------------------------------------------------------------
  // Bootstrap/migration an toàn cho cả DB mới lẫn DB cũ.
  //
  // DB Docker dùng volume persistent, vì vậy `CREATE TABLE IF NOT EXISTS`
  // trong schema.sql sẽ KHÔNG chạy lại khi bảng users đã tồn tại.
  // Trước đây code gọi `ALTER TYPE user_role` trực tiếp => DB cũ thiếu
  // enum sẽ làm server crash ngay khi khởi động.
  // ------------------------------------------------------------------
  await pool.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);

  // Tạo enum trước khi bất kỳ migration nào tham chiếu đến chúng.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
        CREATE TYPE user_role AS ENUM ('user', 'admin', 'staff');
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'booking_status') THEN
        CREATE TYPE booking_status AS ENUM ('pending', 'confirmed', 'cancelled');
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_method') THEN
        CREATE TYPE payment_method AS ENUM ('onsite', 'transfer');
      END IF;
    END $$;
  `);

  // PostgreSQL không cho ALTER TYPE ... ADD VALUE bên trong DO/transaction.
  const ensureEnumValue = async (typeName, value) => {
    const r = await pool.query(
      `SELECT 1 FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = $1 AND e.enumlabel = $2`,
      [typeName, value]
    );
    if (r.rowCount) return;
    // typeName/value đều là hằng số nội bộ, không lấy trực tiếp từ request.
    await pool.query(`ALTER TYPE ${typeName} ADD VALUE '${value}'`);
  };
  await ensureEnumValue('user_role', 'staff');
  await ensureEnumValue('booking_status', 'pending');
  await ensureEnumValue('booking_status', 'confirmed');
  await ensureEnumValue('booking_status', 'cancelled');
  await ensureEnumValue('payment_method', 'onsite');
  await ensureEnumValue('payment_method', 'transfer');

  const tableExists = async (name) =>
    (await pool.query(`SELECT to_regclass($1) AS t`, [`public.${name}`])).rows[0].t !== null;

  // DB hoàn toàn mới: schema.sql tạo đầy đủ bảng, constraint, trigger,
  // function, view và dữ liệu mẫu.
  if (!await tableExists('users')) {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    await pool.query(schema);
  } else {
    // ----------------------------------------------------------------
    // MIGRATION DB CŨ
    // ----------------------------------------------------------------
    // Bổ sung các cột đã xuất hiện trong những phiên bản Courtly trước.
    await pool.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS phone TEXT,
        ADD COLUMN IF NOT EXISTS avatar_key TEXT DEFAULT ('animal-' || (floor(random() * 10)::int + 1)::text),
        ADD COLUMN IF NOT EXISTS member_type TEXT NOT NULL DEFAULT 'casual' CHECK (member_type IN ('casual','fixed')),
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

      ALTER TABLE courts
        ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'standard',
        ADD COLUMN IF NOT EXISTS image_url TEXT,
        ADD COLUMN IF NOT EXISTS under_maintenance BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS amenities TEXT[] NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS open_time TIME NOT NULL DEFAULT '06:00',
        ADD COLUMN IF NOT EXISTS close_time TIME NOT NULL DEFAULT '23:00',
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

      ALTER TABLE bookings
        ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS total_price INTEGER,
        ADD COLUMN IF NOT EXISTS standard_price INTEGER CHECK (standard_price > 0),
        ADD COLUMN IF NOT EXISTS discount_percent SMALLINT NOT NULL DEFAULT 0 CHECK (discount_percent IN (0,10)),
        ADD COLUMN IF NOT EXISTS player_name TEXT,
        ADD COLUMN IF NOT EXISTS player_phone TEXT,
        ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'onsite',
        ADD COLUMN IF NOT EXISTS paid BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS hold_expires_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    `);

    // Chuẩn hoá dữ liệu legacy trước khi đổi TEXT -> ENUM.
    await pool.query(`
      UPDATE users SET role = 'user'
      WHERE role IS NULL OR role NOT IN ('user','admin','staff');

      UPDATE users SET avatar_key = 'animal-' || (floor(random() * 10)::int + 1)::text
      WHERE avatar_key IS NULL OR avatar_key !~ '^animal-(10|[1-9])$';

      ALTER TABLE users ALTER COLUMN avatar_key SET DEFAULT ('animal-' || (floor(random() * 10)::int + 1)::text);
      ALTER TABLE users ALTER COLUMN avatar_key SET NOT NULL;

      UPDATE bookings SET status = 'cancelled'
      WHERE status IS NULL OR status NOT IN ('pending','confirmed','cancelled');

      UPDATE bookings SET payment_method = 'onsite'
      WHERE payment_method IS NULL OR payment_method NOT IN ('onsite','transfer');

      UPDATE bookings b
      SET player_name = COALESCE(NULLIF(b.player_name, ''), u.full_name),
          player_phone = COALESCE(NULLIF(b.player_phone, ''), NULLIF(u.phone, ''), '0000000000')
      FROM users u
      WHERE b.user_id = u.id
        AND (b.player_name IS NULL OR b.player_phone IS NULL OR b.player_name = '' OR b.player_phone = '');

      UPDATE bookings
      SET player_name = COALESCE(NULLIF(player_name, ''), 'Người chơi'),
          player_phone = COALESCE(NULLIF(player_phone, ''), '0000000000');

      -- Booking pending cũ không có thời hạn không thể giữ sân vô thời hạn.
      DELETE FROM bookings WHERE status = 'pending' AND hold_expires_at IS NULL;
    `);

    // Chuyển các cột legacy sang enum nếu hiện tại chúng vẫn là TEXT.
    // DROP DEFAULT trước khi đổi type vì default TEXT không tự cast sang enum.
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='users'
            AND column_name='role' AND udt_name <> 'user_role'
        ) THEN
          ALTER TABLE users ALTER COLUMN role DROP DEFAULT;
          ALTER TABLE users
            ALTER COLUMN role TYPE user_role
            USING role::text::user_role;
          ALTER TABLE users ALTER COLUMN role SET DEFAULT 'user'::user_role;
          ALTER TABLE users ALTER COLUMN role SET NOT NULL;
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='bookings'
            AND column_name='status' AND udt_name <> 'booking_status'
        ) THEN
          ALTER TABLE bookings ALTER COLUMN status DROP DEFAULT;
          ALTER TABLE bookings
            ALTER COLUMN status TYPE booking_status
            USING status::text::booking_status;
          ALTER TABLE bookings ALTER COLUMN status SET DEFAULT 'pending'::booking_status;
          ALTER TABLE bookings ALTER COLUMN status SET NOT NULL;
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='bookings'
            AND column_name='payment_method' AND udt_name <> 'payment_method'
        ) THEN
          ALTER TABLE bookings ALTER COLUMN payment_method DROP DEFAULT;
          ALTER TABLE bookings
            ALTER COLUMN payment_method TYPE payment_method
            USING payment_method::text::payment_method;
          ALTER TABLE bookings ALTER COLUMN payment_method SET DEFAULT 'onsite'::payment_method;
          ALTER TABLE bookings ALTER COLUMN payment_method SET NOT NULL;
        END IF;
      END $$;
    `);

    // Bản cũ tự đánh dấu chuyển khoản đã thu. Gỡ constraint trước khi cập nhật trigger.
    await pool.query('ALTER TABLE bookings DROP CONSTRAINT IF EXISTS transfer_must_be_paid');

    // Các constraint quan trọng cho booking. Chỉ thêm nếu chưa tồn tại.
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname='booking_time_valid' AND conrelid='bookings'::regclass
        ) THEN
          ALTER TABLE bookings ADD CONSTRAINT booking_time_valid CHECK (ends_at > starts_at);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname='booking_duration_valid' AND conrelid='bookings'::regclass
        ) THEN
          ALTER TABLE bookings ADD CONSTRAINT booking_duration_valid
            CHECK (EXTRACT(EPOCH FROM (ends_at - starts_at)) % 1800 = 0);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname='booking_min_duration' AND conrelid='bookings'::regclass
        ) THEN
          ALTER TABLE bookings ADD CONSTRAINT booking_min_duration
            CHECK (ends_at - starts_at >= interval '30 minutes');
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname='booking_max_duration' AND conrelid='bookings'::regclass
        ) THEN
          ALTER TABLE bookings ADD CONSTRAINT booking_max_duration
            CHECK (ends_at - starts_at <= interval '3 hours');
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname='booking_start_slot_valid' AND conrelid='bookings'::regclass
        ) THEN
          ALTER TABLE bookings ADD CONSTRAINT booking_start_slot_valid
            CHECK (
              EXTRACT(MINUTE FROM starts_at) IN (0,30)
              AND EXTRACT(SECOND FROM starts_at) = 0
            );
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname='pending_must_have_expiration' AND conrelid='bookings'::regclass
        ) THEN
          ALTER TABLE bookings ADD CONSTRAINT pending_must_have_expiration
            CHECK (status <> 'pending' OR hold_expires_at IS NOT NULL);
        END IF;

      END $$;
    `);

    // Giữ giới hạn 3 giờ cho đặt mới, cho phép admin gia hạn booking đã xác nhận.
    const durationRule = await pool.query(`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conname='booking_max_duration' AND conrelid='bookings'::regclass
    `);
    if (!durationRule.rows[0]?.definition.includes('1 day')) {
      await pool.query(`
        ALTER TABLE bookings DROP CONSTRAINT IF EXISTS booking_max_duration;
        ALTER TABLE bookings ADD CONSTRAINT booking_max_duration CHECK (
          (status = 'confirmed' AND ends_at - starts_at <= interval '1 day') OR
          (status <> 'confirmed' AND ends_at - starts_at <= interval '3 hours')
        );
      `);
    }

    // Không xoá dữ liệu cũ. Nếu DB đã có constraint no_overlap thì giữ nguyên;
    // nếu chưa có thì thêm để chống double-booking ở tầng PostgreSQL.
    const overlap = await pool.query(`
      SELECT 1 FROM pg_constraint
      WHERE conname='no_overlap' AND conrelid='bookings'::regclass
    `);
    if (!overlap.rowCount) {
      await pool.query(`
        ALTER TABLE bookings
        ADD CONSTRAINT no_overlap
        EXCLUDE USING gist (
          court_id WITH =,
          tstzrange(starts_at, ends_at, '[)') WITH &&
        )
        WHERE (status IN ('pending','confirmed'))
      `);
    }

    // Function/view/index/trigger có thể tạo lại an toàn.
    const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    // Bỏ phần CREATE TABLE/INSERT mẫu khỏi schema khi migration DB cũ:
    // giữ các object logic ở phía sau (function/view), vì bảng đã tồn tại.
    const logicStart = schema.indexOf('-- 8. UPDATED_AT FUNCTION');
    if (logicStart >= 0) {
      await pool.query(schema.slice(logicStart, schema.indexOf('-- 18. SAMPLE USERS')));
    }
  }

  // Booking legacy được xác nhận trước khi có cột confirmed_at vẫn cần mốc hạn chuyển khoản.
  await pool.query(`UPDATE bookings SET confirmed_at = created_at
    WHERE status = 'confirmed' AND confirmed_at IS NULL`);
  await pool.query(`UPDATE bookings SET paid = false WHERE paid IS NULL`);
  await pool.query(`ALTER TABLE bookings ALTER COLUMN paid SET DEFAULT false;
    ALTER TABLE bookings ALTER COLUMN paid SET NOT NULL`);

  // DB cũ đã có bookings: bổ sung bảng phát sinh mà không sửa giá sân lịch sử.
  await pool.query(`CREATE INDEX IF NOT EXISTS bookings_member_rank_idx ON bookings (user_id, ends_at DESC) WHERE status = 'confirmed'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bookings_transfer_deadline_idx ON bookings (confirmed_at)
    WHERE status = 'confirmed' AND payment_method = 'transfer' AND paid = false`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_settings (
      id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
      bank_bin TEXT NOT NULL CHECK (bank_bin ~ '^[0-9]{6}$'),
      bank_name TEXT NOT NULL,
      account_no TEXT NOT NULL,
      account_name TEXT NOT NULL,
      qr_image BYTEA,
      qr_mime TEXT CHECK (qr_mime IN ('image/png','image/jpeg','image/webp')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS qr_image BYTEA;
    ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS qr_mime TEXT;
    CREATE TABLE IF NOT EXISTS booking_addons (
      id BIGSERIAL PRIMARY KEY,
      booking_id BIGINT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('product','extra_time')),
      label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
      quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100),
      unit_price INTEGER NOT NULL CHECK (unit_price BETWEEN 1 AND 100000000),
      paid BOOLEAN NOT NULL DEFAULT false,
      created_by BIGINT REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS booking_addons_booking_idx ON booking_addons(booking_id);
    CREATE TABLE IF NOT EXISTS weekly_schedules (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      court_id INTEGER NOT NULL REFERENCES courts(id) ON DELETE RESTRICT,
      weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
      start_min SMALLINT NOT NULL CHECK (start_min BETWEEN 0 AND 1410 AND start_min % 30 = 0),
      end_min SMALLINT NOT NULL CHECK (end_min BETWEEN 30 AND 1440 AND end_min % 30 = 0),
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (end_min > start_min AND end_min - start_min <= 180)
    );
    CREATE INDEX IF NOT EXISTS weekly_schedules_active_idx ON weekly_schedules (user_id) WHERE active;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS schedule_rule_id BIGINT REFERENCES weekly_schedules(id) ON DELETE SET NULL;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS schedule_date DATE;
    CREATE UNIQUE INDEX IF NOT EXISTS bookings_schedule_occurrence_idx ON bookings (schedule_rule_id, schedule_date) WHERE schedule_rule_id IS NOT NULL;
  `);

  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'pricing.sql'), 'utf8'));
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'staff.sql'), 'utf8'));

  // Production chỉ tạo admin khi chưa có admin; tuyệt đối không tạo demo/password mẫu.
  const userCount = (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
  if (isProduction) {
    await bootstrapProductionAdmin();
  } else if (userCount === 0) {
    // Chỉ dùng tài khoản, sân và booking mẫu trong môi trường phát triển.
    const ins = async (email, pw, name, role) => {
      const h = await bcrypt.hash(pw, 10);
      return (await pool.query(
        'INSERT INTO users (email,password_hash,full_name,role) VALUES ($1,$2,$3,$4) RETURNING id',
        [email, h, name, role]
      )).rows[0].id;
    };
    const adminId = await ins('admin@courtly.vn', 'admin123', 'Quản Trị Viên', 'admin');
    const demo = await ins('demo@courtly.vn', 'demo123', 'Nguyễn Minh Hải', 'user');

    const courtCount = (await pool.query('SELECT count(*)::int AS n FROM courts')).rows[0].n;
    if (courtCount === 0) {
      await pool.query(`
        INSERT INTO courts (name,district,type,price_per_hour,open_time,close_time,amenities)
        VALUES
          ('Court 01','Quận 1','standard',80000,'06:00','23:00','{"Đèn LED","Nước uống"}'),
          ('Court 02','Quận 3','standard',90000,'06:00','23:00','{"Đèn LED","Phòng thay đồ"}'),
          ('Court 03','Bình Thạnh','standard',70000,'06:00','23:00','{"Nước uống"}'),
          ('Court 04','Thủ Đức','standard',75000,'06:00','23:00','{"Đèn LED","Bãi xe"}'),
          ('Court 05','Quận 7','standard',85000,'06:00','23:00','{"Đèn LED","Bãi xe","Nước uống"}'),
          ('Court 06','Gò Vấp','standard',65000,'06:00','23:00','{"Nước uống"}')
        ON CONFLICT (name) DO NOTHING
      `);
    }

    const courtIds = (await pool.query('SELECT id, price_per_hour FROM courts ORDER BY id LIMIT 3')).rows;
    if (courtIds.length >= 3) {
      const half = 1800e3;
      const t0 = Math.floor(Date.now() / half) * half;
      const seed = (courtId, from, mins, price) =>
        pool.query(
          `INSERT INTO bookings
             (court_id,user_id,starts_at,ends_at,status,total_price,player_name,player_phone,payment_method,paid,confirmed_at)
           VALUES ($1,$2,$3,$4,'confirmed',$5,$6,$7,'onsite',false,now())
           ON CONFLICT DO NOTHING`,
          [courtId, demo, new Date(from), new Date(from + mins * 60e3), price, 'Nguyễn Minh Hải', '0900000000']
        );
      await seed(courtIds[1].id, t0, 60, courtIds[1].price_per_hour);
      await seed(courtIds[2].id, t0 + 3600e3, 60, courtIds[2].price_per_hour);
    }
  }

  // Kiểm tra cuối cùng để lỗi DB hiển thị rõ ràng thay vì "website không chạy".
  await pool.query('SELECT 1 FROM users LIMIT 1');
  await pool.query('SELECT * FROM court_live_status LIMIT 1');
}

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Cổng ${PORT} đang được dùng. Đặt biến PORT khác, ví dụ PORT=4001 npm start` : e.message);
  process.exit(1);
});

setup()
  .then(async () => {
    await expireUnconfirmedTransfers();
    server.listen(PORT, () => {
    console.log(`Courtly chạy tại http://localhost:${PORT}`);
    replenishWeeklySchedules().catch((err) => console.error('Không thể cập nhật lịch cố định:', err.message));
    setInterval(() => replenishWeeklySchedules().catch((err) => console.error('Không thể cập nhật lịch cố định:', err.message)), 30 * 60 * 1000);
    });
  })
  .catch((e) => {
    console.error('Không khởi động được:', e.message);
    console.error('Kiểm tra PostgreSQL: chạy "docker compose up -d" hoặc đặt biến DATABASE_URL.');
    process.exit(1);
  });
