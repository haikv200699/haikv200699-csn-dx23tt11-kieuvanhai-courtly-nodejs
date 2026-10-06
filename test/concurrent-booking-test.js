// ============================================================
// TEST: 2 người cùng bấm đặt 1 khung giờ CÙNG LÚC
// ============================================================
//
// Cách chạy:
//   1) docker compose up -d          (khởi động PostgreSQL)
//   2) npm start                     (chạy server, mặc định cổng 4000)
//   3) node test/concurrent-booking-test.js
//
// Script sẽ:
//   - Đăng ký 2 tài khoản test (hoặc đăng nhập lại nếu đã tồn tại)
//   - Cả 2 cùng gửi request "giữ chỗ" (POST /api/bookings/hold) cho
//     CÙNG một sân + CÙNG một khung giờ, bắn đi gần như đồng thời
//     (Promise.all, không await tuần tự) để mô phỏng race condition thật.
//   - In kết quả: phải có ĐÚNG 1 người giữ chỗ thành công (201),
//     người còn lại phải nhận lỗi 409 "Khung giờ này vừa có người đặt".
//   - Sau đó lặp lại N lần với slot khác nhau để tăng độ tin cậy.
//   - Dọn dẹp: nhả (release) các hold đã tạo thành công khi kết thúc.
//
// Nếu ở bất kỳ lần lặp nào CẢ HAI đều thành công (201/201) -> có race
// condition thật sự, cần kiểm tra lại constraint `no_overlap` trong
// db/schema.sql. Với thiết kế hiện tại (EXCLUDE USING gist ở tầng DB),
// điều này không nên xảy ra dù chạy bao nhiêu lần.
// ============================================================

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const ROUNDS = Number(process.env.ROUNDS || 20); // số lần lặp thử

async function api(path, opt = {}) {
  const r = await fetch(BASE + '/api' + path, {
    ...opt,
    headers: { 'Content-Type': 'application/json', ...(opt.token ? { Authorization: 'Bearer ' + opt.token } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, body: j };
}

async function ensureUser(email, password, fullName, phone) {
  let r = await api('/auth/register', { method: 'POST', body: { email, password, fullName, phone } });
  if (r.status === 409) r = await api('/auth/login', { method: 'POST', body: { email, password } }); // đã tồn tại từ lần chạy trước
  if (!r.ok && r.status !== 201) throw new Error('Không đăng nhập được ' + email + ': ' + JSON.stringify(r.body));
  return r.body.token;
}

async function firstAvailableCourtId(token) {
  const r = await api('/courts', { token });
  const c = r.body.find((x) => !x.under_maintenance);
  if (!c) throw new Error('Không có sân nào khả dụng để test');
  return c.id;
}

function slotTimes(dayOffset, hour) {
  // Luôn dùng khung giờ trong tương lai, cách nhau theo round để tránh đụng dữ liệu thật đang test trước đó
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dayOffset);
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, '0'), day = String(d.getUTCDate()).padStart(2, '0');
  const startsAt = `${y}-${m}-${day}T${String(hour).padStart(2, '0')}:00:00+07:00`;
  const end = new Date(new Date(startsAt).getTime() + 30 * 60000).toISOString();
  return { startsAt: new Date(startsAt).toISOString(), endsAt: end };
}

async function run() {
  console.log(`== Test đặt sân đồng thời (${ROUNDS} vòng) ==\n`);
  const tokenA = await ensureUser('race-a@test.local', 'test1234', 'Race Tester A', '0900000001');
  const tokenB = await ensureUser('race-b@test.local', 'test1234', 'Race Tester B', '0900000002');
  const courtId = await firstAvailableCourtId(tokenA);
  console.log(`Dùng sân id=${courtId} để test.\n`);

  let doubleSuccessCount = 0, bothFailCount = 0, okRounds = 0;
  const cleanupIds = [];

  for (let i = 0; i < ROUNDS; i++) {
    // Mỗi vòng dùng 1 khung giờ khác nhau (2 ngày sau, giờ 6 + i, tránh giờ đóng cửa)
    const hour = 6 + (i % 16);
    const dayOffset = 2 + Math.floor(i / 16);
    const { startsAt, endsAt } = slotTimes(dayOffset, hour);
    const body = { courtId, startsAt, endsAt, playerName: 'Race Test', playerPhone: '0900000000', paymentMethod: 'onsite' };

    // Bắn 2 request GẦN NHƯ ĐỒNG THỜI - không await tuần tự
    const [ra, rb] = await Promise.all([
      api('/bookings/hold', { method: 'POST', token: tokenA, body }),
      api('/bookings/hold', { method: 'POST', token: tokenB, body }),
    ]);

    const successes = [ra, rb].filter((r) => r.status === 201);
    const conflicts = [ra, rb].filter((r) => r.status === 409);

    if (successes.length === 1 && conflicts.length === 1) {
      okRounds++;
      cleanupIds.push({ id: successes[0].body.id, token: successes[0] === ra ? tokenA : tokenB });
      process.stdout.write('.');
    } else if (successes.length === 2) {
      doubleSuccessCount++;
      console.log(`\n[ROUND ${i}] ❌ LỖI NGHIÊM TRỌNG: CẢ 2 ĐỀU THÀNH CÔNG (đặt trùng giờ!) ->`, ra, rb);
      cleanupIds.push({ id: ra.body.id, token: tokenA }, { id: rb.body.id, token: tokenB });
    } else {
      bothFailCount++;
      console.log(`\n[ROUND ${i}] ⚠️ Không round nào thành công (có thể do lỗi khác, không phải double-book) ->`, ra, rb);
    }
  }

  // Dọn dẹp: nhả các hold đã tạo trong lúc test để không rác dữ liệu
  await Promise.all(cleanupIds.map(({ id, token }) => api(`/bookings/${id}/release`, { method: 'PATCH', token }).catch(() => {})));

  console.log('\n\n== KẾT QUẢ ==');
  console.log(`✅ Đúng (1 thành công / 1 bị chặn 409): ${okRounds}/${ROUNDS}`);
  console.log(`❌ Trùng lịch thật sự (cả 2 thành công): ${doubleSuccessCount}/${ROUNDS}`);
  console.log(`⚠️  Cả 2 đều lỗi (không thuộc double-book): ${bothFailCount}/${ROUNDS}`);
  console.log(doubleSuccessCount === 0
    ? '\n🎉 Không phát hiện double-booking. Constraint EXCLUDE ở DB hoạt động đúng.'
    : '\n🚨 CÓ DOUBLE-BOOKING! Cần kiểm tra lại constraint no_overlap trong db/schema.sql.');
  process.exit(doubleSuccessCount === 0 ? 0 : 1);
}

run().catch((e) => { console.error('Test thất bại:', e); process.exit(1); });
