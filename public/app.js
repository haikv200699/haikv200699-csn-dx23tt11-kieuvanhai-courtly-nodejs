const TZ = 'Asia/Ho_Chi_Minh';
const $ = (s, r = document) => r.querySelector(s);
const LABEL = { AVAILABLE: 'Còn trống', RESERVED: 'Sắp có người chơi', PLAYING: 'Đang chơi', MAINTENANCE: 'Bảo trì' };
const money = (n) => new Intl.NumberFormat('vi-VN').format(n) + 'đ';
const fmtT = (iso) => new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
const fmtD = (iso) => {
  const d = new Date(iso);
  const date = d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: TZ });
  const weekday = d.toLocaleDateString('vi-VN', { weekday: 'long', timeZone: TZ });
  return `${date} · ${weekday}`;
};
const durationText = (minutes) => minutes >= 60
  ? `${Math.floor(minutes / 60)} giờ${minutes % 60 ? ` ${minutes % 60} phút` : ''}` : `${minutes} phút`;
const playTimeText = (booking) => {
  const shortDate = new Date(booking.starts_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: TZ });
  return `${shortDate} • ${fmtT(booking.starts_at)} - ${fmtT(booking.ends_at)} (${durationText(Math.round((new Date(booking.ends_at) - new Date(booking.starts_at)) / 60000))})`;
};
// confirmed_at là lúc đặt sân thành công; created_at là lúc bắt đầu giữ chỗ.
const bookingTimeText = (booking) => {
  const value = booking?.confirmed_at || booking?.created_at;
  if (!value || Number.isNaN(+new Date(value))) return '—';
  return fmtT(value);
};
const todayStr = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const toDate = (day, min) => new Date(`${day}T${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:00+07:00`);
const hm = (t) => { const [h, m] = t.split(':'); return +h * 60 + +m; };
const vnMin = (iso) => Math.floor((+new Date(iso) + 7 * 3600e3) / 60000) % 1440;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const motion = !reduce && typeof gsap !== 'undefined' && typeof ScrollTrigger !== 'undefined';

const state = {
  token: localStorage.getItem('token'), user: null, courts: [], built: false,
  bk: {
    date: todayStr(), dateChosen: true, courtId: null, selected: [], booked: [],
    holdId: null, holdRangeKey: null, holdExpiresAt: null, holdPrice: null, holdDiscountPercent: null, holdTimer: null, countdownIv: null,
  },
  adm: {
    courtId: null, bookings: [], newIds: new Set(), unread: 0,
    filters: { date: '', phone: '', name: '', amount: '' },
  },
};
const can = key => CourtlyAccess.can(state.user,key);
const canCollect = b => can(b?.payment_method === 'transfer' ? 'transferConfirm' : 'cashCollect');
let cancellationReason = '';
let pricingConfig = null, pricingVersion = null, pricingDraft = null;
function previewPrice(day, start, end, memberType = 'casual') {
  if (!pricingConfig) return null;
  try { return CourtlyPricing.quote(pricingConfig, toDate(day,start), toDate(day,end), memberType); }
  catch { return null; }
}
function tariffDescription(b) {
  return b.pricing_snapshot ? (b.pricing_snapshot.memberType === 'fixed' ? 'Giá thành viên cố định' : 'Giá vãng lai theo khung giờ')
    : b.discount_percent ? `Ưu đãi cũ ${b.discount_percent}%` : 'Giá đã lưu khi đặt';
}
function tariffLines(b) {
  return '';
}
let paymentEditToken = '';

async function confirmBookingCancellation(message) {
  cancellationReason = await operationReason('Hủy booking', message);
  return !!cancellationReason;
}

// ---------- api / ui helpers ----------
async function api(path, opt = {}) {
  if (opt.method && opt.method !== 'GET') {
    const needsReason = /\/(cancel|discount|extend|details)$/.test(path) || (/\/addons\/\d+$/.test(path) && opt.method === 'DELETE') || (/\/paid$/.test(path) && opt.body?.paid === false);
    if (needsReason && !opt.body?.reason) {
      const why = path.endsWith('/cancel') ? cancellationReason : await operationReason(path.endsWith('/discount') ? 'Điều chỉnh giảm giá' : path.endsWith('/extend') ? 'Gia hạn booking' : 'Lý do điều chỉnh');
      cancellationReason = '';
      if (!why) throw new Error('Thao tác chưa được xác nhận');
      opt = {...opt,body:{...opt.body,reason:why}};
    }
  }
  const r = await fetch('/api' + path, {
    ...opt,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}), ...opt.headers },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { if (r.status === 401 && state.token && path !== '/auth/login') logout(); const err = new Error(j.error || 'Có lỗi xảy ra'); err.status = r.status; throw err; }
  return j;
}
async function authenticatedImage(path) {
  const r = await fetch(path, { headers: { Authorization: 'Bearer ' + state.token } });
  if (!r.ok) { const data = await r.json().catch(() => ({})); throw new Error(data.error || 'Không tải được ảnh QR'); }
  return URL.createObjectURL(await r.blob());
}
let toastT;
function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = ''), 3200);
}
let lenis;
function goto(sel) {
  const el = $(sel); if (!el) return;
  const navRect = $('nav')?.getBoundingClientRect();
  const navBottom = navRect?.bottom ?? navRect?.height ?? 0;
  const top = Math.max(0, window.scrollY + el.getBoundingClientRect().top - navBottom - 20);
  if (lenis) lenis.scrollTo(top);
  else window.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
}
const navSectionLinks = [...document.querySelectorAll('#navSectionLinks a[href^="#"]')];
const isCompactNav = () => typeof matchMedia === 'function' && matchMedia('(max-width:900px)').matches;
let wasCompactNav = isCompactNav();
function closeProfileNavMenu() {
  $('nav').classList.remove('menu-open');
  $('#profileQuickMenu').hidden = true;
  $('#profileBtn').setAttribute('aria-expanded', 'false');
}
function updateActiveNav() {
  const navRect = $('nav')?.getBoundingClientRect();
  const threshold = (navRect?.bottom ?? navRect?.height ?? 0) + 34;
  let current = null;
  for (const link of navSectionLinks) {
    const section = $(link.getAttribute('href'));
    if (section && !section.hidden && !link.hidden && section.getBoundingClientRect().top <= threshold) current = link;
  }
  for (const link of navSectionLinks) {
    link.classList.toggle('is-active', link === current);
    if (link === current) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}
let navUpdateQueued = false;
function queueActiveNav() {
  if (navUpdateQueued) return;
  navUpdateQueued = true;
  requestAnimationFrame(() => { navUpdateQueued = false; updateActiveNav(); });
}
window.addEventListener('scroll', queueActiveNav, { passive: true });
window.addEventListener('resize', () => {
  const compact = isCompactNav();
  if (compact !== wasCompactNav) closeProfileNavMenu();
  wasCompactNav = compact;
  queueActiveNav();
});
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (a && a.getAttribute('href').length > 1) {
    e.preventDefault(); closeProfileNavMenu(); goto(a.getAttribute('href'));
    queueActiveNav();
  } else if (!e.target.closest('#profileBtn, #navSectionLinks, #profileQuickMenu')) closeProfileNavMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeProfileNavMenu(); });

// ---------- hero carousel (khuyến mãi) ----------
const HERO_SLIDES = [
  { eyebrow: 'COURTLY / CẦU LÔNG VIỆT NAM', t1: 'Đặt sân.', t2: 'Chơi ngay.', sub: 'Chọn sân, chọn giờ và sẵn sàng cho trận đấu. Lịch sân cập nhật trực tiếp, đặt chỗ chỉ trong vài bước.' },
  { eyebrow: 'Thành viên cố định', t1: 'Chơi đều mỗi tháng,', t2: 'giá ưu đãi.', sub: 'Thành viên cố định có bảng giá riêng theo ngày và khung giờ, áp dụng cho đặt sân và gia hạn.' },
  { eyebrow: 'Khai trương', t1: 'Sân mới tinh,', t2: 'ưu đãi 15% cho 100 lượt đầu.', sub: 'Court 07 vừa hoàn thiện, mặt sân chuẩn thi đấu — ưu đãi cho 100 lượt đặt đầu tiên.' },
];
let hcIndex = 0, hcTimer;
function renderHero(i) {
  hcIndex = i;
  $('#heroCarousel').closest('.hero').classList.toggle('hero-promo', i > 0);
  document.querySelectorAll('.hc-slide').forEach((el) => el.classList.toggle('active', +el.dataset.i === i));
  document.querySelectorAll('#hcDots button').forEach((el) => el.classList.toggle('on', +el.dataset.i === i));
  const s = HERO_SLIDES[i];
  $('#heroEyebrow').textContent = s.eyebrow;
  $('#heroT1').textContent = s.t1;
  $('#heroT2').textContent = s.t2;
  $('#heroSub').textContent = s.sub;
}
function hcGo(delta) { renderHero((hcIndex + delta + HERO_SLIDES.length) % HERO_SLIDES.length); restartHcAutoplay(); }
function restartHcAutoplay() { clearInterval(hcTimer); if (!reduce) hcTimer = setInterval(() => hcGo(1), 7000); }
$('#hcDots').innerHTML = HERO_SLIDES.map((_, i) => `<button data-i="${i}" aria-label="Chương trình ${i + 1}"></button>`).join('');
$('#hcDots').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { renderHero(+b.dataset.i); restartHcAutoplay(); } });
$('#hcPrev').onclick = () => hcGo(-1);
$('#hcNext').onclick = () => hcGo(1);
renderHero(0);
restartHcAutoplay();
$('#heroCarousel').closest('.hero').addEventListener('mouseenter', () => clearInterval(hcTimer));
$('#heroCarousel').closest('.hero').addEventListener('mouseleave', restartHcAutoplay);

// ---------- auth ----------
let mode = 'login';
function setMode(m) {
  mode = m;
  $('#authTitle').textContent = m === 'login' ? 'Chào mừng trở lại.' : 'Tạo tài khoản.';
  $('#authSubmit').textContent = m === 'login' ? 'Đăng nhập' : 'Đăng ký';
  $('#authSwitch').textContent = m === 'login' ? 'Chưa có tài khoản? Đăng ký' : 'Đã có tài khoản? Đăng nhập';
  $('#nameRow').hidden = m === 'login';
  $('#phoneRow').hidden = m === 'login';
  $('#nameRow input').required = m === 'register';
  $('#phoneRow input').required = m === 'register';
  $('#authIdentifierLabel').firstChild.textContent = m === 'login' ? 'Email hoặc số điện thoại' : 'Email';
  const identifier = $('#authIdentifier');
  identifier.type = m === 'login' ? 'text' : 'email';
  identifier.placeholder = m === 'login' ? 'Email hoặc số điện thoại' : 'ban@email.com';
  identifier.autocomplete = m === 'login' ? 'username' : 'email';
  $('#authErr').textContent = '';
}
const openAuth = () => { setMode('login'); $('#authDlg').showModal(); };
$('#authSwitch').onclick = () => setMode(mode === 'login' ? 'register' : 'login');
$('#authClose').onclick = () => $('#authDlg').close();
$('#authBtn').onclick = openAuth;
const avatarUrl = (u) => `/avatars/${u.role === 'admin' ? 'shuttlecock' : /^animal-(?:[1-9]|10)$/.test(u.avatarKey || '') ? u.avatarKey : 'animal-1'}.svg`;
function showProfileDetails(u) {
  $('#profileTitle').textContent = u.fullName;
  $('#profileViewPhone').textContent = u.phone || 'Chưa cập nhật';
  $('#profileViewEmail').textContent = u.email;
  $('#profileMemberRow').hidden = u.role !== 'user';
  $('#profileViewMember').textContent = u.memberType === 'fixed' ? 'Cố định · giá ưu đãi tiền sân cho booking mới' : 'Vãng lai · giá tiêu chuẩn';
  $('#profileOverview').hidden = false;
  $('#profileForm').hidden = true;
  $('#profileEdit').hidden = false;
}
function openProfileDialog() {
  const u = state.user;
  if (!u) return;
  $('#profileAvatar').src = avatarUrl(u);
  showProfileDetails(u);
  $('#profileErr').textContent = '';
  $('#profileDlg').showModal();
}
$('#profileBtn').onclick = () => {
  if (!state.user) return;
  if (isCompactNav()) {
    const open = !$('nav').classList.contains('menu-open');
    $('nav').classList.toggle('menu-open', open);
    $('#profileBtn').setAttribute('aria-expanded', String(open));
    if (open) navSectionLinks.find((link) => !link.hidden)?.focus?.();
    return;
  }
  const open = $('#profileQuickMenu').hidden;
  $('#profileQuickMenu').hidden = !open;
  $('#profileBtn').setAttribute('aria-expanded', String(open));
  if (open) $('#profileDesktopAccount').focus();
};
$('#profileMenuAccount').onclick = () => { closeProfileNavMenu(); openProfileDialog(); };
$('#profileDesktopAccount').onclick = $('#profileMenuAccount').onclick;
$('#profileMenuPlayers').onclick = $('#profileDesktopPlayers').onclick = () => { closeProfileNavMenu(); openAccountsDialog(); };
$('#profileEdit').onclick = () => {
  const u = state.user;
  if (!u) return;
  $('#profileName').value = u.fullName || '';
  $('#profilePhone').value = u.phone || '';
  $('#profileEmail').value = u.email || '';
  $('#profileErr').textContent = '';
  $('#profileOverview').hidden = true;
  $('#profileForm').hidden = false;
  $('#profileEdit').hidden = true;
  $('#profileName').focus();
};
$('#profileCancelEdit').onclick = () => { if (state.user) showProfileDetails(state.user); };
$('#profileClose').onclick = () => $('#profileDlg').close();
$('#profileLogout').onclick = () => { $('#profileDlg').close(); logout(); };
$('#profileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = $('#profileSave');
  button.disabled = true;
  $('#profileErr').textContent = '';
  try {
    const updated = await api('/me', { method: 'PATCH', body: {
      fullName: $('#profileName').value.trim(), phone: $('#profilePhone').value.trim(),
    } });
    state.user = updated;
    showProfileDetails(updated);
    afterAuth();
    toast('Đã cập nhật hồ sơ');
  } catch (err) { $('#profileErr').textContent = err.message; }
  finally { button.disabled = false; }
});
$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    const r = await api('/auth/' + mode, { method: 'POST', body: f });
    state.token = r.token; state.user = r.user; localStorage.setItem('token', r.token);
    $('#authDlg').close(); e.target.reset(); afterAuth();
    toast('Xin chào, ' + r.user.fullName);
  } catch (err) { $('#authErr').textContent = err.message; }
});
function logout() {
  lockPaymentEditor();
  $('#paymentSettingsForm').reset();
  $('#paymentSettingsSummary').textContent = 'Đang tải tài khoản nhận tiền…';
  setCourtAddOpen(false);
  if ($('#paymentUnlockDlg').open) $('#paymentUnlockDlg').close();
  if ($('#cancelBookingDlg').open) $('#cancelBookingDlg').close();
  if ($('#transferDlg').open) $('#transferDlg').close();
  if ($('#profileDlg').open) $('#profileDlg').close();
  for (const id of ['#operationsDlg','#operationReasonDlg']) if ($(id)?.open) $(id).close();
  if ($('#accEditDlg').open) $('#accEditDlg').close();
  if ($('#accountsDlg').open) $('#accountsDlg').close();
  if ($('#historyBillDlg').open) $('#historyBillDlg').close();
  if ($('#historyDlg').open) $('#historyDlg').close();
  if ($('#bookingExtrasDlg').open) $('#bookingExtrasDlg').close();
  releaseHold(); state.token = null; state.user = null; localStorage.removeItem('token');
  state.adm.unread = 0; state.adm.newIds.clear(); setNotifDot();
  state.bk.selected = []; state.bk.courtId = null; state.bk.dateChosen = true;
  asState.selected = []; asState.courtId = null; asState.dateChosen = true;
  $('#playerName').value = ''; $('#playerPhone').value = '';
  $('#upcoming').innerHTML = '';
  renderedTodayDay = '';
  fixedScheduleUser = null; $('#fixedSchedulePanel').hidden = true;
  $('#historyFilters').reset();
  renderBookingStages(); renderAssignStages(); renderSlots(); renderSummary();
  afterAuth(); toast('Đã đăng xuất');
}
function fillPlayerDetails() {
  if (!state.user || ['admin', 'staff'].includes(state.user.role)) return;
  $('#playerName').value = state.user.fullName || '';
  $('#playerPhone').value = state.user.phone || '';
  renderSummary();
}
async function afterAuth() {
  const u = state.user;
  document.body.classList.toggle('signed-in', !!u);
  closeProfileNavMenu();
  $('#authBtn').hidden = !!u;
  $('#profileBtn').hidden = !u;
  if (u) {
    $('#navAvatar').src = avatarUrl(u);
    $('#profileBtn').setAttribute('aria-label', `Mở menu tài khoản của ${u.fullName}`);
  }
  $('#mine').hidden = $('#nav-mine').hidden = !u;
  const isAdm = !!(u && (u.role === 'admin' || u.role === 'staff'));
  $('#booking').hidden = $('#nav-booking').hidden = false;
  $('.hero').hidden = $('#facility').hidden = $('a[href="#facility"]').hidden = isAdm;
  if (isAdm) clearInterval(hcTimer); else restartHcAutoplay();
  $('#navMineLabel').textContent = isAdm ? 'Lịch đặt sân' : 'Lịch của tôi';
  setNotifDot();
  $('#admin').hidden = $('#nav-admin').hidden = !isAdm;
  $('#profileMenuPlayers').hidden = $('#profileDesktopPlayers').hidden = u?.role !== 'admin';
  $('#paymentSettingsSection').hidden = u?.role !== 'admin';
  $('#assign').hidden = $('#nav-assign').hidden = true;
  $('#bkPublic').hidden = false;
  renderBookingStages(); renderAssignStages();
  renderBkCourts();
  $('#bookingTitle').textContent = $('#nav-booking').textContent = 'Đặt sân';
  if (u) {
    fillPlayerDetails();
    if (!isAdm && state.bk.selected.length && !state.bk.holdId) scheduleHold();
    $('#greet').textContent = 'Lịch đặt sân';
    loadMine().catch((e) => toast(e.message, true));
    if (isAdm) {
      if (u.role === 'admin') loadPaymentSettings().catch((e) => { $('#paymentSettingsSummary').textContent = e.message; });
      loadAdmin().catch((e) => toast(e.message, true));
      loadAssign();
    }
  }
  if(typeof applyStaffUI === 'function') applyStaffUI();
  loadAdminSchedule().catch((e) => toast(e.message, true));
  if (window.ScrollTrigger) ScrollTrigger.refresh();
  queueActiveNav();
}

// ---------- courts (bước 2 của đặt sân, cập nhật trực tiếp) ----------
function onSnapshot(rows) {
  state.courts = rows;
  $('#factCourts').textContent = rows.length;
  if (state.bk.courtId && !rows.some((c) => c.id === state.bk.courtId && !c.under_maintenance)) {
    releaseHold(); state.bk.courtId = null; state.bk.selected = [];
    renderDurationTotal(); renderSummary(); renderBookingStages();
  }
  renderBkCourts();
  if (state.bk.courtId) renderSlots();
  if (state.user && (state.user.role === 'admin' || state.user.role === 'staff')) {
    renderCourtList(); renderAdminCourts();
    // Nếu sân đã chọn không còn khả dụng, trở lại bước chọn sân.
    const current = rows.find((c) => c.id === asState.courtId && !c.under_maintenance);
    if (asState.courtId && !current) { asState.courtId = null; asState.selected = []; }
    renderAssignStages();
    renderAsDates();
    renderAsCourts();
    loadAsBooked();
  }
  loadAdminSchedule().catch(() => {});
}

// ---------- booking ----------
let calendarMonth = todayStr().slice(0, 7);
const lastBookingDay = () => addDays(todayStr(), 29);
const monthKey = (day) => day.slice(0, 7);
const shiftMonth = (key, delta) => {
  const [year, month] = key.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
};
function renderDates() {
  const last = lastBookingDay(), today = todayStr();
  if (calendarMonth < monthKey(today) || calendarMonth > monthKey(last)) calendarMonth = monthKey(today);
  const first = `${calendarMonth}-01`;
  const [year, month] = calendarMonth.split('-').map(Number);
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const offset = (new Date(first + 'T00:00:00Z').getUTCDay() + 6) % 7;
  const cells = Array.from({ length: offset }, () => '<span class="calendar-blank" aria-hidden="true"></span>');
  for (let n = 1; n <= count; n++) {
    const day = `${calendarMonth}-${String(n).padStart(2, '0')}`;
    const allowed = day >= today && day <= last;
    const selected = state.bk.dateChosen && day === state.bk.date;
    cells.push(`<button type="button" class="calendar-day${selected ? ' sel' : ''}${day === today ? ' today' : ''}" data-d="${day}" ${allowed ? '' : 'disabled'} aria-pressed="${selected}" aria-label="${fmtD(day + 'T00:00:00+07:00')}"><span>${n}</span>${day === today ? '<small>Hôm nay</small>' : ''}</button>`);
  }
  $('#calMonth').textContent = new Date(first + 'T00:00:00Z').toLocaleDateString('vi-VN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  $('#calPrev').disabled = calendarMonth <= monthKey(today);
  $('#calNext').disabled = calendarMonth >= monthKey(last);
  $('#dates').innerHTML = cells.join('');
  $('#selectedDateText').textContent = fmtD(state.bk.date + 'T00:00:00+07:00');
  $('#scheduleDateLabel').textContent = fmtD(state.bk.date + 'T00:00:00+07:00');
}
function setCalendarOpen(open) {
  const panel = $('#calendarPanel');
  panel.classList.toggle('is-open', open);
  panel.inert = !open;
  panel.setAttribute('aria-hidden', String(!open));
  $('#calendarToggle').setAttribute('aria-expanded', String(open));
  if (open) calendarMonth = monthKey(state.bk.date);
  if (open) renderDates();
}
$('#calendarToggle').addEventListener('click', () => setCalendarOpen(!$('#calendarPanel').classList.contains('is-open')));
$('#calPrev').addEventListener('click', () => { calendarMonth = shiftMonth(calendarMonth, -1); renderDates(); });
$('#calNext').addEventListener('click', () => { calendarMonth = shiftMonth(calendarMonth, 1); renderDates(); });
$('#dates').addEventListener('click', (e) => {
  const b = e.target.closest('[data-d]'); if (!b || b.disabled) return;
  if (b.dataset.d === state.bk.date) { setCalendarOpen(false); $('#calendarToggle').focus({ preventScroll: true }); return; }
  releaseHold();
  state.bk.date = b.dataset.d; state.bk.dateChosen = true; state.bk.courtId = null; state.bk.selected = [];
  state.bk.booked = []; $('#slots').innerHTML = '<p class="mute">Chọn sân để xem giờ trống.</p>';
  $('#scheduleViewport').scrollLeft = 0; $('#scheduleViewport').scrollTop = 0;
  asState.date = b.dataset.d; asState.dateChosen = true; asState.courtId = null; asState.selected = []; asState.booked = [];
  setCalendarOpen(false);
  $('#calendarToggle').focus({ preventScroll: true });
  renderDates(); renderBkCourts(); renderBookingStages(); renderDurationTotal(); renderSummary();
  renderAsDates(); renderAsCourts(); renderAssignStages(); renderAsSummary();
  admScheduleData = null;
  $('#courtSchedule').innerHTML = '<div class="schedule-error">Đang tải lịch sân…</div>';
  loadAdminSchedule().catch((err) => toast(err.message, true));
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#calendarPanel').classList.contains('is-open')) setCalendarOpen(false); });
function renderBookingStages() {
  $('#bkCourtStage').hidden = true;
  $('#bkTimeStage').hidden = true;
  $('#summary').hidden = ['admin', 'staff'].includes(state.user?.role) || !state.bk.selected.length;
  renderSelectionBar();
}
function renderBkCourts() {
  $('#bkCourts').innerHTML = state.courts.map((c) => {
    const sel = c.id === state.bk.courtId;
    const rate = pricingConfig ? Math.min(...pricingConfig.weekday.concat(pricingConfig.weekend).map(r=>r[state.user?.memberType === 'fixed' ? 'fixed' : 'casual'])) : null;
    return `<button class="cc ${sel ? 'sel' : ''}" data-c="${c.id}" aria-pressed="${sel}" ${c.under_maintenance ? 'disabled' : ''}>
      <span class="top"><b class="nm">${esc(c.name)}</b><span class="status s-${c.status}" role="img" aria-label="${esc(LABEL[c.status] || 'Trạng thái sân')}" title="${esc(LABEL[c.status] || 'Trạng thái sân')}"></span></span>
      <span class="price">${rate == null ? "Đang tải giá" : "Từ " + money(rate)} <small>/ giờ</small></span>
    </button>`;
  }).join('') || '<p class="mute">Đang tải danh sách sân…</p>';
}
$('#bkCourts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-c]'); if (!b) return;
  selectCourt(+b.dataset.c);
  if (matchMedia('(max-width:999px)').matches) setTimeout(() => goto('#slots'), 250); // mobile: chuyển tới bước chọn giờ
});
function selectCourt(id) { releaseHold(); state.bk.dateChosen = true; state.bk.courtId = id; state.bk.selected = []; state.bk.booked = []; $('#slots').innerHTML = '<p class="mute">Đang tải khung giờ…</p>'; renderBookingStages(); renderBkCourts(); fillPlayerDetails(); return loadBooked(); }

async function loadBooked() {
  const b = state.bk;
  if (!b.courtId) return;
  const courtId = b.courtId, date = b.date;
  try {
    const rows = await api(`/courts/${courtId}/booked?date=${date}`);
    if (b.courtId !== courtId || b.date !== date) return;
    // status: 'confirmed' (đã chốt) hoặc 'pending' (người khác đang giữ chỗ, tối đa 5 phút)
    b.booked = rows.map((x) => ({ start: +new Date(x.starts_at), end: +new Date(x.ends_at), status: x.status }));
    renderSlots();
  } catch (err) {
    if (b.courtId !== courtId || b.date !== date) return;
    toast('Không tải được khung giờ, vui lòng thử lại: ' + err.message, true);
    b.selected = [];
    $('#slots').innerHTML = '<p class="mute">Không tải được lịch sân. Vui lòng chọn lại ngày hoặc sân để thử lại.</p>';
    renderDurationTotal(); renderSummary(); $('#confirmBtn').disabled = true;
  }
}
function fmtMin(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${m % 60 ? '30' : '00'}`;
}
function selectedRange() {
  const selected = [...state.bk.selected].sort((a, z) => a - z);
  if (!selected.length) return null;
  return { start: selected[0], end: selected[selected.length - 1] + 30, dur: selected.length * 30 };
}
function renderSlots() {
  const b = state.bk, c = state.courts.find((x) => x.id === b.courtId);
  if (!c) { $('#slots').innerHTML = '<p class="mute">Không tìm thấy thông tin sân này, vui lòng chọn lại sân.</p>'; return; }
  if (c.under_maintenance) {
    b.selected = [];
    $('#slots').innerHTML = '<p class="mute">Sân đang bảo trì, vui lòng chọn sân khác.</p>';
    renderDurationTotal(); renderBookingStages(); renderSummary(); return;
  }
  const open = hm(c.open_time), close = hm(c.close_time), out = [];
  const available = new Set();
  for (let m = open; m < close; m += 30) {
    const s = +toDate(b.date, m), e = s + 30 * 60000;
    const heldByOther = b.booked.some((x) => x.status === 'pending' && s < x.end && e > x.start);
    const confirmedByOther = b.booked.some((x) => x.status === 'confirmed' && s < x.end && e > x.start);
    if (s < Date.now()) continue;
    // Hiển thị lịch đã đặt để khách dễ nhìn, nhưng chỉ slot còn trống mới có thể chọn.
    if (confirmedByOther) {
      out.push(`<button type="button" class="slot booked" disabled aria-label="${fmtMin(m)} đã đặt">${fmtMin(m)}</button>`);
      continue;
    }
    if (heldByOther) {
      out.push(`<button type="button" class="slot held" disabled aria-label="${fmtMin(m)} đang giữ chỗ">${fmtMin(m)}</button>`);
      continue;
    }
    available.add(m);
    const selected = b.selected.includes(m);
    out.push(`<button class="${['slot', selected ? 'sel' : ''].filter(Boolean).join(' ')}" data-m="${m}" aria-pressed="${selected}">${fmtMin(m)}</button>`);
  }
  // Khi ca vừa chọn đã qua giờ hoặc không còn trống, nhả toàn bộ lượt giữ chỗ.
  if (b.selected.some((m) => !available.has(m))) { releaseHold(); b.selected = []; }
  $('#slots').innerHTML = out.length ? out.join('') : '<p class="mute">Không còn khung giờ nào trong ngày này.</p>';
  renderDurationTotal(); renderBookingStages();
  renderSummary();
}
$('#slots').addEventListener('click', (e) => {
  const button = e.target.closest('[data-m]'); if (!button || button.disabled) return;
  if (!state.user) { toast('Đăng nhập để giữ chỗ', true); return openAuth(); }
  const m = +button.dataset.m;
  if (+toDate(state.bk.date, m) <= Date.now()) { renderSlots(); return; }
  const selected = [...state.bk.selected].sort((a, z) => a - z);
  if (!selected.length) {
    state.bk.selected = [m];
  } else if (selected.includes(m)) {
    const min = Math.min(...selected), max = Math.max(...selected);
    // Chỉ bỏ slot ở hai đầu để khoảng thời gian luôn liền mạch.
    if (m === min || m === max) state.bk.selected = selected.filter((x) => x !== m);
  } else {
    const min = Math.min(...selected), max = Math.max(...selected);
    // Chọn slot liền kề, tối đa 3 giờ (6 slot).
    if ((m === min - 30 || m === max + 30) && selected.length < 6) state.bk.selected = [...selected, m];
    else if (m !== min - 30 && m !== max + 30) state.bk.selected = [m];
  }
  renderSlots(); renderBookingStages();
  scheduleHold();
});

// ---------- giữ chỗ (pending, 5 phút) ----------
// Chèn ngay bản ghi 'pending' khi khách vừa chọn xong khung giờ (trước khi họ kịp điền form/thanh toán),
// để mọi người khác thấy slot chuyển xám tức thì. Nếu khách đổi lựa chọn, hold cũ được nhả và tạo hold mới.
let holdReqT;
function scheduleHold() {
  clearTimeout(holdReqT);
  holdReqT = setTimeout(commitHold, 350);
}
async function commitHold() {
  const b = state.bk, range = selectedRange();
  const key = range ? `${b.courtId}:${range.start}:${range.end}` : null;
  if (key === b.holdRangeKey) return; // không đổi gì, khỏi gọi lại
  const prevId = b.holdId;
  b.holdId = null; b.holdRangeKey = null; b.holdExpiresAt = null; b.holdPrice = null; b.holdDiscountPercent = null;
  stopCountdown();
  if (prevId) {
    try { await api(`/bookings/${prevId}/release`, { method: 'PATCH' }); }
    catch (err) { b.selected = []; renderSlots(); toast('Không thể đổi giờ giữ chỗ. Vui lòng chọn lại ca.', true); return; }
  }
  if (!range) { renderSummary(); return; }
  try {
    const paymentMethod = document.querySelector('input[name="paymentMethod"]:checked')?.value || 'onsite';
    const r = await api('/bookings/hold', { method: 'POST', body: {
      courtId: b.courtId,
      startsAt: toDate(b.date, range.start).toISOString(),
      endsAt: toDate(b.date, range.end).toISOString(),
      playerName: state.user?.fullName || '', playerPhone: '', paymentMethod,
    } });
    // Lựa chọn có thể đã đổi trong lúc chờ mạng -> nếu không còn khớp, nhả hold vừa tạo ngay.
    const nowRange = selectedRange();
    const nowKey = nowRange ? `${b.courtId}:${nowRange.start}:${nowRange.end}` : null;
    if (nowKey !== key) { api(`/bookings/${r.id}/release`, { method: 'PATCH' }).catch(() => {}); return; }
    b.holdId = r.id; b.holdRangeKey = key; b.holdExpiresAt = r.holdExpiresAt;
    b.holdPrice = r.totalPrice; b.holdDiscountPercent = r.discountPercent; b.holdPricing = r.pricing;
    startCountdown();
    renderSummary();
    if (admScheduleData?.date === b.date) renderCourtSchedule(admScheduleData);
    loadAdminSchedule().catch(() => {});
  } catch (err) {
    toast(err.message, true);
    b.selected = []; renderSlots(); loadBooked();
  }
}
function startCountdown() {
  stopCountdown();
  state.bk.countdownIv = setInterval(() => {
    const left = +new Date(state.bk.holdExpiresAt) - Date.now();
    if (left <= 0) {
      stopCountdown();
      toast('Hết 5 phút giữ chỗ, vui lòng chọn lại giờ', true);
      state.bk.holdId = null; state.bk.holdRangeKey = null; state.bk.holdPrice = null; state.bk.holdDiscountPercent = null; state.bk.selected = [];
      renderSlots(); loadBooked();
      return;
    }
    renderSummary();
  }, 1000);
}
function stopCountdown() { clearInterval(state.bk.countdownIv); state.bk.countdownIv = null; }
function releaseHold() {
  const b = state.bk;
  stopCountdown();
  if (b.holdId) api(`/bookings/${b.holdId}/release`, { method: 'PATCH' }).catch(() => {});
  b.holdId = null; b.holdRangeKey = null; b.holdExpiresAt = null; b.holdPrice = null; b.holdDiscountPercent = null;
}
// Best-effort: nhả sân ngay nếu khách đóng tab/điều hướng đi nơi khác trong lúc đang giữ chỗ.
window.addEventListener('pagehide', () => {
  const id = state.bk.holdId;
  if (id && state.token) fetch('/api/bookings/' + id + '/release', {
    method: 'PATCH', keepalive: true,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
  }).catch(() => {});
});
function renderDurationTotal() {
  const range = selectedRange();
  const el = $('#durationTotal');
  if (!range) { el.hidden = true; $('#durationValue').textContent = '0 phút'; return; }
  el.hidden = false;
  $('#durationValue').textContent = durationText(range.dur);
}
const priceObj = { v: 0 };
let confirmPending = false;
function renderSummary() {
  const b = state.bk, c = state.courts.find((x) => x.id === b.courtId), range = selectedRange();
  const hasPlayer = $('#playerName').value.trim().length > 0 && $('#playerPhone').value.trim().length > 0;
  const ok = !!(c && range && hasPlayer && b.holdId);
  $('#confirmBtn').disabled = !ok || confirmPending;
  $('#confirmBtn').textContent = b.holdId ? 'Xác nhận đặt sân' : (range ? state.user ? 'Đang giữ chỗ…' : 'Đăng nhập để đặt sân' : 'Xác nhận đặt sân');
  if (!c || !range) {
    $('#sumText').textContent = 'Chọn ngày, sân và giờ chơi.';
    $('#memberDiscountHint').hidden = true;
    $('#sumPrice').textContent = '0đ'; priceObj.v = 0; return;
  }
  const left = b.holdExpiresAt ? Math.max(0, Math.round((+new Date(b.holdExpiresAt) - Date.now()) / 1000)) : null;
  const holdTxt = left != null ? ` · Đang giữ chỗ, còn ${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}` : '';
  $('#sumText').textContent = `${c.name} · ${fmtD(b.date + 'T00:00:00+07:00').split(' · ')[0]} · ${fmtMin(range.start)}–${fmtMin(range.end)}${holdTxt}`;
  const quote = previewPrice(b.date, range.start, range.end, state.user?.memberType);
  const target = b.holdId && b.holdPrice != null ? Number(b.holdPrice) : quote?.total;
  $('#memberDiscountHint').hidden = false;
  $('#memberDiscountHint').textContent = (b.holdId ? b.holdPricing?.memberType : quote?.memberType) === 'fixed'
    ? 'Thành viên cố định · bảng giá ưu đãi theo giờ' : 'Giá vãng lai · tính theo từng ca 30 phút';
  if (target == null) { $('#sumPrice').textContent = 'Đang tải giá…'; $('#confirmBtn').disabled = true; return; }
  if (!motion) { $('#sumPrice').textContent = money(target); priceObj.v = target; }
  else gsap.to(priceObj, { v: target, duration: .5, ease: 'power2.out', onUpdate: () => ($('#sumPrice').textContent = money(Math.round(priceObj.v))) });
}
['playerName', 'playerPhone'].forEach((id) => $('#' + id).addEventListener('input', () => {
  if (id === 'playerPhone') $('#playerPhoneErr').textContent = '';
  renderSummary();
}));
document.querySelectorAll('input[name="paymentMethod"]').forEach((el) => el.addEventListener('change', () => {
  $('#paymentNote').textContent = el.checked && el.value === 'transfer' ? 'Sau khi đặt sân, quét mã VietQR và chuyển khoản trong vòng 10 phút. Chủ sân sẽ xác nhận đã thu tiền.' : 'Thanh toán tại sân khi đến chơi.';
}));
$('#confirmBtn').onclick = async () => {
  if (confirmPending) return;
  if (!state.user) { toast('Đăng nhập để đặt sân', true); return openAuth(); }
  const b = state.bk, range = selectedRange();
  if (!range || !b.holdId) return toast('Sân đang được giữ chỗ, vui lòng đợi giây lát rồi thử lại', true);
  const playerName = $('#playerName').value.trim(), playerPhone = $('#playerPhone').value.trim().replace(/[ .-]/g, '');
  const paymentMethod = document.querySelector('input[name="paymentMethod"]:checked')?.value || 'onsite';
  if (!playerName || !playerPhone) return toast('Vui lòng nhập tên và số điện thoại', true);
  if (!/^0\d{9,10}$/.test(playerPhone)) {
    $('#playerPhoneErr').textContent = 'Số điện thoại không hợp lệ (10–11 chữ số, bắt đầu bằng 0).';
    $('#playerPhone').focus();
    return;
  }
  confirmPending = true;
  renderSummary();
  let confirmed;
  try {
    // Chỉ CHUYỂN pending -> confirmed của chính hold đang giữ, không tạo bản ghi mới.
    confirmed = await api(`/bookings/${b.holdId}/confirm`, { method: 'POST', body: { playerName, playerPhone, paymentMethod } });
  } catch (err) {
    toast(err.message, true);
    // Lỗi nhập liệu giữ nguyên khung giờ để khách sửa và thử lại trong thời hạn đang giữ.
    if (err.status === 410) {
      releaseHold();
      b.selected = [];
      renderSlots();
      loadBooked().catch(() => {});
    }
    return;
  } finally {
    confirmPending = false;
    renderSummary();
  }
  toast('Đặt sân thành công');
  stopCountdown();
  b.selected = []; b.holdId = null; b.holdRangeKey = null; b.holdExpiresAt = null; b.holdPrice = null; b.holdDiscountPercent = null;
  fillPlayerDetails();
  renderSlots();
  if (paymentMethod === 'transfer') openTransferPayment(confirmed.id);
  await loadBooked().catch((err) => toast(err.message, true));
  loadMine().catch((err) => toast(err.message, true));
};

// Hướng dẫn thanh toán theo booking; thời hạn được tính từ lúc xác nhận trên server.
let transferTimer = null, transferRequest = 0, transferData = null, transferQrBlobUrl = null, transferQrSource = null;
function clearTransferQr() {
  if (transferQrBlobUrl) URL.revokeObjectURL(transferQrBlobUrl);
  transferQrBlobUrl = transferQrSource = null;
  $('#transferQr').removeAttribute('src');
}
function renderTransferPayment() {
  const data = transferData;
  if (!data) return;
  const seconds = Math.max(0, Math.ceil((+new Date(data.dueAt) - Date.now()) / 1000));
  $('#transferStatus').textContent = data.status === 'cancelled' ? 'Booking đã hủy; thông tin chuyển khoản không còn hiệu lực.'
    : data.paid ? 'Đã thu tiền · Chủ sân đã xác nhận giao dịch.'
    : seconds ? `Vui lòng chuyển khoản trong ${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}. Booking đang chờ chủ sân xác nhận đã thu tiền.`
      : 'Đã hết 10 phút. Hệ thống đang hủy booking chưa được xác nhận.';
  $('#transferQrWrap').hidden = data.status === 'cancelled' || data.paid || !seconds || !data.qrUrl;
  $('#transferHelp').hidden = data.status === 'cancelled' || !!data.paid || !seconds;
}
async function fetchTransferPayment(id, request) {
  const data = await api(`/bookings/${id}/payment`);
  if (request !== transferRequest || !$('#transferDlg').open) return;
  const wasPaid = transferData?.paid, wasCancelled = transferData?.status === 'cancelled';
  transferData = data;
  $('#transferBank').textContent = data.bankName || data.bankBin || '—';
  $('#transferAccountName').textContent = data.accountName || '—';
  $('#transferAccountNo').textContent = data.accountNo || '—';
  $('#transferAmount').textContent = money(data.amount);
  $('#transferCode').textContent = data.code;
  $('#transferDetails').hidden = !data.accountNo;
  $('#transferQrError').hidden = true;
  renderTransferPayment();
  if (data.qrUrl && transferQrSource !== data.qrUrl) {
    try {
      const imageUrl = data.qrUrl.startsWith('/api/') ? await authenticatedImage(data.qrUrl) : data.qrUrl;
      if (request !== transferRequest || !$('#transferDlg').open || data.qrUrl !== transferData?.qrUrl) {
        if (imageUrl.startsWith('blob:')) URL.revokeObjectURL(imageUrl);
        return;
      }
      clearTransferQr();
      transferQrSource = data.qrUrl;
      if (imageUrl.startsWith('blob:')) transferQrBlobUrl = imageUrl;
      $('#transferQr').src = imageUrl;
    } catch (err) {
      if (request === transferRequest) { $('#transferQr').hidden = true; $('#transferQrError').hidden = false; }
    }
  } else if (!data.qrUrl && transferQrSource) clearTransferQr();
  if ((!wasPaid && data.paid) || (!wasCancelled && data.status === 'cancelled')) loadMine().catch(() => {});
}
function openTransferPayment(id) {
  ++transferRequest;
  clearInterval(transferTimer);
  clearTransferQr();
  transferData = null;
  $('#transferStatus').textContent = 'Đang tải thông tin chuyển khoản…';
  $('#transferQrWrap').hidden = $('#transferDetails').hidden = true;
  if (!$('#transferDlg').open) $('#transferDlg').showModal();
  const request = transferRequest;
  fetchTransferPayment(id, request).catch((err) => { if (request === transferRequest) $('#transferStatus').textContent = err.message; });
  let ticks = 0;
  transferTimer = setInterval(() => {
    if (!$('#transferDlg').open) return;
    renderTransferPayment();
    if (++ticks % 10 === 0) fetchTransferPayment(id, request).catch(() => {});
  }, 1000);
}
$('#transferQr').onerror = () => { $('#transferQr').hidden = true; $('#transferQrError').hidden = false; };
$('#transferQr').onload = () => { $('#transferQr').hidden = false; $('#transferQrError').hidden = true; };
$('#transferClose').onclick = $('#transferDone').onclick = () => $('#transferDlg').close();
$('#transferDlg').addEventListener('close', () => { ++transferRequest; clearInterval(transferTimer); transferTimer = null; clearTransferQr(); });

// ---------- my bookings ----------
const paidTag = (r) => (r.status === 'confirmed' || (r.status === 'cancelled' && r.confirmed_at)) && Number(r.paid_amount ?? (r.paid ? r.total_price : 0)) >= Number(r.invoice_total ?? r.total_price) && r.paid
  ? '<span class="paid-tag">Đã thanh toán</span>' : '';
const paymentTag = (r) => paidTag(r) || (r.status === 'confirmed' && r.payment_method === 'transfer' && !r.paid
  ? '<span class="awaiting-tag">Chờ xác nhận</span>' : '<span class="unpaid-tag">Chưa thanh toán</span>');
const bookingDateLabel = (iso) => `<b>${fmtD(iso)}</b>`;
let renderedTodayDay = '';
async function loadMine() {
  if(state.user?.role==='staff' && !can('bookingView')) return;
  if (!state.user) return;
  const authToken = state.token;
  const requestedDay = todayStr();
  const rows = await api('/bookings/mine');
  if (!state.user || state.token !== authToken) return;
  if (todayStr() !== requestedDay) return loadMine();
  const manager = ['admin', 'staff'].includes(state.user.role);
  const day = requestedDay;
  const bookings = rows.filter((r) => (r.status === 'confirmed' || (r.status === 'cancelled' && r.confirmed_at)) &&
    new Date(r.starts_at).toLocaleDateString('sv-SE', { timeZone: TZ }) === day)
    .sort((a, b) => +new Date(b.confirmed_at || b.created_at) - +new Date(a.confirmed_at || a.created_at) || Number(b.id) - Number(a.id));
  const bookingCard = (r) => {
    const payment = !manager && r.status === 'confirmed' && r.payment_method === 'transfer' && !r.paid;
    const actions = payment ? `<button type="button" class="booking-row-payment" data-payment="${r.id}">Thanh toán ngay</button>` : '';
    const duration = durationText(Math.round((new Date(r.ends_at) - new Date(r.starts_at)) / 60000));
    const number = manager ? `<span class="today-order">#${r.id}</span>` : '';
    const player = manager ? `<span class="today-person"><b>${esc(r.player_name || 'Người chơi')}</b><small>${esc(r.player_phone || 'Chưa có số điện thoại')}</small></span>` : '';
    const detailLabel = manager ? `booking #${r.id} của ${esc(r.player_name || 'người chơi')}` : `sân ${esc(r.court_name)} lúc ${fmtT(r.starts_at)}`;
    const status = `${paymentTag(r)}${actions}`;
    const cancelled = r.status === 'cancelled' ? '<span class="history-status cancelled today-cancelled">Đã hủy</span>' : '';
    return `<article class="today-row booking-row${manager ? '' : ' today-row-user'}">${number}<b class="today-court">${esc(r.court_name)}</b><span class="today-time"><b>${fmtT(r.starts_at)} – ${fmtT(r.ends_at)}</b><small>${duration}</small></span>${player}<span class="today-value"><strong>${money(r.invoice_total ?? r.total_price)}</strong><span class="today-status">${status}${cancelled}</span></span><button type="button" class="booking-row-open" data-open-upcoming="${r.id}" aria-label="Xem chi tiết ${detailLabel}"></button></article>`;
  };
  $('#todayDate').textContent = fmtD(day + 'T00:00:00+07:00');
  $('#todayCount').textContent = `${bookings.length} booking`;
  $('#todayHead').innerHTML = manager
    ? '<span>STT</span><span>Sân</span><span>Thời gian</span><span>Người chơi</span><span>Giá trị / Thanh toán</span>'
    : '<span>Sân</span><span>Thời gian</span><span>Giá trị / Thanh toán</span>';
  $('#todayHead').classList.toggle('today-columns-user', !manager);
  const rail = $('#upcoming'), previousScroll = renderedTodayDay === day ? rail.scrollTop : 0;
  rail.innerHTML = bookings.map(bookingCard).join('') || '<p class="upcoming-empty">Hôm nay chưa có booking. Xem “Toàn bộ booking” để tìm lịch ngày khác.</p>';
  rail.classList.toggle('has-more', bookings.length > 6);
  rail.classList.toggle('today-rail-user', !manager);
  $('#todayHint').hidden = bookings.length <= 6;
  rail.scrollTop = previousScroll;
  renderedTodayDay = day;
  if ($('#historyDlg').open) loadHistory(historyPage);
}
setInterval(() => {
  if (state.user && renderedTodayDay && renderedTodayDay !== todayStr())
    loadMine().catch((err) => toast(err.message, true));
}, 60000);
$('#upcoming').addEventListener('click', async (e) => {
  const payment = e.target.closest('[data-payment]');
  if (payment) { openTransferPayment(payment.dataset.payment); return; }
  const row = e.target.closest('[data-open-upcoming]');
  if (row) ['admin', 'staff'].includes(state.user?.role)
    ? openBookingExtras(row.dataset.openUpcoming) : openHistoryBill(row.dataset.openUpcoming);
});
// Toàn bộ booking phân trang: bộ lọc chỉ dành cho quản trị viên.
let historyPage = 1, historyRequest = 0, historySearchTimer, historyBill = null, historyBillRequest = 0;
const historyDateTime = (iso) => iso ? `${fmtD(iso)} · ${fmtT(iso)}` : '—';
async function loadHistory(page = 1) {
  if (!$('#historyDlg').open || !state.user) return;
  const request = ++historyRequest, authToken = state.token;
  const manager = ['admin', 'staff'].includes(state.user.role);
  const query = manager ? new URLSearchParams(new FormData($('#historyFilters'))) : new URLSearchParams();
  query.set('page', page);
  query.set('limit', 20);
  $('#historyResults').innerHTML = '<p class="history-empty">Đang tải booking…</p>';
  $('#historyResults').setAttribute('aria-busy', 'true');
  $('#historyPrev').disabled = $('#historyNext').disabled = true;
  try {
    const data = await api(`/bookings/history?${query}`);
    if (request !== historyRequest || !$('#historyDlg').open || authToken !== state.token) return;
    const { total, upcoming, completed, cancelled, revenue } = data.summary;
    const lastPage = Math.max(1, Math.ceil(total / data.limit));
    if (page > lastPage) { loadHistory(lastPage); return; }
    historyPage = page;
    $('#historyStats').innerHTML = `<div class="history-stat"><small>Tổng booking</small><b>${total}</b></div><div class="history-stat"><small>Chưa kết thúc</small><b>${upcoming}</b></div><div class="history-stat"><small>Đã chơi</small><b>${completed}</b></div><div class="history-stat"><small>Đã hủy</small><b>${cancelled}</b></div>${state.user?.role==='staff'?'':`<div class="history-stat accent"><small>Giá trị đã chơi</small><b>${money(revenue)}</b></div>`}`;
    $('#historyPageInfo').textContent = total ? `${(page - 1) * data.limit + 1}–${Math.min(page * data.limit, total)} / ${total}` : '0 kết quả';
    $('#historyPager').textContent = `Trang ${page} / ${lastPage}`;
    $('#historyPrev').disabled = page <= 1;
    $('#historyNext').disabled = page >= lastPage;
    const head = `<div class="history-table-head${manager ? '' : ' history-table-head-user'}" aria-hidden="true">${manager ? '<span>STT</span>' : ''}<span>Sân</span><span>Thời gian</span>${manager ? '<span>Người chơi</span>' : ''}<span>Giá trị</span></div>`;
    const list = data.rows.map((b) => {
      const identity = manager ? `<div class="history-order"><b>#${b.id}</b></div>` : '';
      const player = manager ? `<div class="history-person"><b>${esc(b.player_name)}</b><small>${esc(b.player_phone)}${b.user_email ? ' · ' + esc(b.user_email) : ''}</small></div>` : '';
      const detailLabel = manager ? `booking #${b.id} của ${esc(b.player_name)}` : `sân ${esc(b.court_name)} lúc ${fmtT(b.starts_at)}`;
      const cancelled = b.status === 'cancelled' ? '<small class="history-status cancelled history-cancelled">Đã hủy</small>' : '';
      return `<article class="history-row booking-row${manager ? '' : ' history-row-user'}${paidTag(b) ? ' is-paid' : ''}">${identity}<div class="history-court"><b>${esc(b.court_name)}</b></div><div class="history-when">${bookingDateLabel(b.starts_at)}<small>${fmtT(b.starts_at)} - ${fmtT(b.ends_at)} (${durationText(Math.round((new Date(b.ends_at) - new Date(b.starts_at)) / 60000))})</small></div>${player}<div class="booking-row-price"><strong>${money(b.invoice_total ?? b.total_price)}</strong>${paymentTag(b)}${cancelled}</div><button type="button" class="booking-row-open" data-history-detail="${b.id}" aria-label="Xem chi tiết ${detailLabel}"></button></article>`;
    }).join('');
    $('#historyResults').innerHTML = data.rows.length ? head + list : `<div class="history-empty">${manager ? 'Không tìm thấy booking phù hợp. Hãy thử xóa bộ lọc.' : 'Bạn chưa có booking nào.'}</div>`;
    $('#historyScroll').scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  } catch (err) {
    if (request !== historyRequest || !$('#historyDlg').open || authToken !== state.token) return;
    $('#historyResults').innerHTML = `<div class="history-empty">Không tải được lịch sử: ${esc(err.message)}</div>`;
  } finally {
    if (request === historyRequest) $('#historyResults').removeAttribute('aria-busy');
  }
}
$('#historyMore').onclick = () => {
  const manager = ['admin', 'staff'].includes(state.user?.role);
  $('#historyDlg').classList.toggle('user-history', !manager);
  $('#historyFilters').hidden = !manager;
  $('#historyStats').hidden = !manager;
  $('#historyDescription').textContent = manager ? 'Tìm booking sắp tới, đã chơi hoặc đã hủy theo ngày.' : 'Lịch sắp tới, đã chơi và đã hủy của bạn, mới nhất trước.';
  $('#historyDlg').showModal(); loadHistory(1);
};
$('#historyClose').onclick = () => $('#historyDlg').close();
$('#historyDlg').addEventListener('close', () => { ++historyRequest; clearTimeout(historySearchTimer); });
$('#historyFilters').addEventListener('input', () => {
  ++historyRequest; clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(() => loadHistory(1), 280);
});
$('#historyFilters').addEventListener('submit', (e) => {
  e.preventDefault(); clearTimeout(historySearchTimer); loadHistory(1);
});
$('#historyReset').onclick = () => { $('#historyFilters').reset(); clearTimeout(historySearchTimer); loadHistory(1); };
$('#historyPrev').onclick = () => loadHistory(historyPage - 1);
$('#historyNext').onclick = () => loadHistory(historyPage + 1);
$('#historyResults').addEventListener('click', (e) => {
  const b = e.target.closest('[data-history-detail]');
  if (b) openHistoryBill(b.dataset.historyDetail);
});
async function openHistoryBill(id) {
  const request = ++historyBillRequest, authToken = state.token;
  historyBill = null;
  $('#historyBillTitle').textContent = `Hóa đơn #${id}`;
  $('#historyBillContent').innerHTML = '<p class="mute">Đang tải chi tiết…</p>';
  $('#historyBillPrint').hidden = true;
  $('#historyBillSettle').hidden = true;
  $('#historyBillCancel').hidden = true;
  $('#historyBillErr').textContent = '';
  if (!$('#historyBillDlg').open) $('#historyBillDlg').showModal();
  try {
    const bill = await api(`/bookings/${id}/invoice`);
    if (request !== historyBillRequest || !$('#historyBillDlg').open || authToken !== state.token) return;
    historyBill = bill;
    const b = bill.booking, cancelled = b.status === 'cancelled';
    $('#historyBillTitle').textContent = `Booking #${b.id} · ${b.court_name}`;
    const field = (label, value) => `<div><small>${label}</small><b>${esc(value || '—')}</b></div>`;
    const row = (label, qty, unit, paid) => `<div class="history-bill-item"><div><b>${esc(label)}</b><small>${qty} × ${money(unit)} · ${paid ? 'Đã thu' : 'Chưa thu'}</small></div><strong>${money(qty * unit)}</strong></div>`;
    $('#historyBillContent').innerHTML = `${paymentTag({ ...b, invoice_total: bill.total, paid_amount: bill.paidAmount })}${cancelled ? '<span class="history-status cancelled">Đã hủy</span>' : ''}<div class="history-bill-meta">${field('Người chơi', b.player_name)}${field('Số điện thoại', b.player_phone)}${state.user?.role==='staff'?'':field('Email tài khoản', b.user_email)}${field('Sân', b.court_name)}${field('Thời gian chơi', playTimeText(b))}${field('Thời điểm tạo booking', bookingTimeText(b))}${field('Phương thức thanh toán', b.payment_method === 'transfer' ? 'Chuyển khoản' : 'Tại sân')}${b.discount_percent ? field('Ưu đãi thành viên', `${b.discount_percent}% tiền sân · giá chuẩn ${money(b.standard_price)}`) : ''}${cancelled ? field('Hủy lúc', historyDateTime(b.cancelled_at)) : ''}</div><div class="history-bill-items"><h4>Các khoản trong hóa đơn</h4>${row(b.discount_percent ? `Tiền sân · ưu đãi ${b.discount_percent}%` : 'Tiền sân', 1, bill.base, b.paid)}${bill.addons.map((a) => row(a.label, a.quantity, a.unit_price, a.paid)).join('')}</div><div class="history-bill-summary">${state.user?.role === 'admin' && b.status === 'confirmed' ? '<button type="button" class="ghost" data-history-discount>Chỉnh giảm giá</button>' : ''}${tariffLines(b)}${bill.discount ? `<div class="history-bill-total"><span>Tạm tính</span><b>${money(bill.subtotal)}</b></div><div class="history-bill-total discount-saving"><span>Giảm giá</span><b>−${money(bill.discount)}</b></div>` : ''}<div class="history-bill-total grand"><span>Tổng giá trị</span><b>${money(bill.total)}</b></div><div class="history-bill-total"><span>Đã thu theo ghi nhận</span><b>${money(bill.paidAmount)}</b></div>${cancelled ? '' : `<div class="history-bill-total"><span>Còn thu</span><b>${money(bill.due)}</b></div>`}</div>${cancelled ? '<p class="history-bill-note">Booking đã hủy. Các khoản trên là dữ liệu đã ghi nhận; hóa đơn không thể hiện khoản hoàn tiền.</p>' : ''}`;
    $('#historyBillPrint').hidden = cancelled || !['admin', 'staff'].includes(state.user?.role);
    const transferExpired = b.payment_method === 'transfer' && !b.paid &&
      !!b.confirmed_at && +new Date(b.confirmed_at) + 600_000 <= Date.now();
    const canSettle = canCollect(b) && (!cancelled || (state.user?.role==='admin' && !!b.confirmed_at)) && !transferExpired;
    $('#historyBillSettle').hidden = !canSettle;
    $('#historyBillSettle').disabled = bill.due <= 0;
    $('#historyBillSettle').textContent = bill.due <= 0 ? '✓ Đã thu tiền' : 'Xác nhận đã thu tiền';
    const ownFuture = state.user?.role === 'user' && String(b.user_id) === String(state.user.id) && +new Date(b.starts_at) > Date.now();
    $('#historyBillCancel').hidden = b.status !== 'confirmed' || (!can('cancelUnpaid') && !ownFuture || (state.user?.role==='staff' && (b.paid || bill.addons.some(a=>a.paid))));
  } catch (err) {
    if (request === historyBillRequest && $('#historyBillDlg').open && authToken === state.token)
      $('#historyBillContent').innerHTML = `<p class="history-empty">Không tải được hóa đơn: ${esc(err.message)}</p>`;
  }
}
$('#historyBillContent').addEventListener('click', e => { if (e.target.closest('[data-history-discount]') && historyBill && state.user?.role === 'admin') openBookingExtras(historyBill.booking.id); });
$('#historyBillSettle').onclick = async () => {
  const bill = historyBill, button = $('#historyBillSettle');
  if (!bill || button.hidden || button.disabled || bill.due <= 0 || !['admin', 'staff'].includes(state.user?.role)) return;
  button.disabled = true;
  $('#historyBillErr').textContent = '';
  try {
    await api(`/admin/bookings/${bill.booking.id}/settle`, { method: 'POST' });
    await openHistoryBill(bill.booking.id);
    loadMine().catch((err) => { $('#historyBillErr').textContent = err.message; });
    toast('Đã ghi nhận thu đủ tiền booking');
  } catch (err) { $('#historyBillErr').textContent = err.message; button.disabled = false; }
};
$('#historyBillCancel').onclick = async () => {
  const bill = historyBill, button = $('#historyBillCancel');
  const b = bill?.booking;
  const ownFuture = state.user?.role === 'user' && String(b?.user_id) === String(state.user.id) && +new Date(b?.starts_at) > Date.now();
  if (b?.status !== 'confirmed' || (!can('cancelUnpaid') && !ownFuture || (state.user?.role==='staff' && (b.paid || bill.addons.some(a=>a.paid)))) || button.hidden || button.disabled) return;
  if (!await confirmBookingCancellation(state.user.role === 'admin' && +new Date(b.starts_at) <= Date.now()
    ? 'Booking đã hoàn thành sẽ được đánh dấu đã hủy trong lịch sử. Số tiền đã thu không tự hoàn lại.'
    : `Bạn có chắc muốn hủy booking ${b.court_name}? Thao tác này sẽ được lưu trong lịch sử.`)) return;
  button.disabled = true;
  $('#historyBillErr').textContent = '';
  try {
    await api(`/bookings/${bill.booking.id}/cancel`, { method: 'PATCH' });
    await openHistoryBill(bill.booking.id);
    loadMine().catch((err) => { $('#historyBillErr').textContent = err.message; });
    loadRevenue().catch((err) => toast(err.message, true));
    toast('Đã hủy booking trong lịch sử');
  } catch (err) { $('#historyBillErr').textContent = err.message; }
  finally { button.disabled = false; }
};
$('#historyBillClose').onclick = () => $('#historyBillDlg').close();
$('#historyBillDlg').addEventListener('close', () => { ++historyBillRequest; historyBill = null; });

// ---------- admin ----------
async function loadAdmin() {
  if(!can('bookingView')) { if(can('revenueView')) await loadRevenue(); return; }
  const o = await api('/admin/overview');
  const st = [[o.total, 'Sân'], [o.bookingsToday, 'Lượt đặt hôm nay'], [o.playing, 'Đang chơi'], [o.available, 'Đang trống'], [o.utilization + '%', 'Tỷ lệ sử dụng hôm nay'], [o.cancelled, 'Đã hủy (7 ngày)'], [o.new_users, 'Người dùng mới (7 ngày)']];
  $('#stats').innerHTML = st.map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
  renderCourtList();
  await loadRevenue();
}

async function loadPaymentSettings() {
  const token = state.token, request = ++paymentQrRequest;
  const settings = await api('/admin/payment-settings');
  if (state.user?.role !== 'admin' || state.token !== token || request !== paymentQrRequest) return;
  $('#paymentSettingsSummary').textContent = settings
    ? `${settings.bank_name} · ${settings.account_no} · ${settings.account_name}`
    : 'Chưa thiết lập tài khoản nhận tiền';
  $('#paymentQrErr').textContent = '';
  $('#paymentQrUpload').disabled = paymentQrUploading || !$('#paymentQrFile').files?.length;
  $('#paymentQrRemove').hidden = !settings?.has_qr;
  $('#paymentQrUpload').textContent = settings?.has_qr ? 'Thay ảnh QR' : 'Tải ảnh QR lên';
  $('#paymentQrEmpty').hidden = !!settings?.has_qr;
  $('#paymentQrStatus').hidden = !settings?.has_qr;
  clearPaymentQrPreview();
  const form = $('#paymentSettingsForm');
  if (!settings) {
    for (const name of ['bankBin', 'bankName', 'accountNo', 'accountName']) form.elements[name].value = '';
    return;
  }
  form.elements.bankBin.value = settings.bank_bin;
  form.elements.bankName.value = settings.bank_name;
  form.elements.accountNo.value = settings.account_no;
  form.elements.accountName.value = settings.account_name;
  if (settings.has_qr && !$('#paymentEditor').hidden) {
    try {
      const url = await authenticatedImage('/api/admin/payment-settings/qr');
      if (state.user?.role !== 'admin' || state.token !== token || request !== paymentQrRequest) { URL.revokeObjectURL(url); return; }
      paymentQrPreviewUrl = url;
      $('#paymentQrPreview').src = url;
      $('#paymentQrPreview').hidden = false;
    } catch (err) {
      if (request === paymentQrRequest) {
        $('#paymentQrEmpty').hidden = false;
        $('#paymentQrStatus').hidden = true;
        $('#paymentQrErr').textContent = err.message;
      }
    }
  }
}
let paymentQrPreviewUrl = null, paymentQrUploading = false, paymentQrRequest = 0;
function lockPaymentEditor() {
  paymentEditToken = '';
  $('#paymentEditor').hidden = true;
  $('#paymentQrFile').value = '';
  $('#paymentQrFilename').textContent = 'Chưa chọn ảnh · PNG, JPEG, WebP';
  ++paymentQrRequest;
  clearPaymentQrPreview();
}
const paymentEditHeaders = () => ({ 'X-Payment-Edit-Token': paymentEditToken });
function handlePaymentEditError(err) {
  if (err.status === 403) { lockPaymentEditor(); toast('Phiên chỉnh sửa đã hết hạn. Nhập lại mật khẩu quản trị.', true); }
}
$('#paymentEditBtn').onclick = () => {
  if (state.user?.role !== 'admin') return;
  $('#paymentUnlockHint').textContent = `Nhập mật khẩu của ${state.user.email} để sửa thông tin nhận tiền.`;
  $('#paymentUnlockErr').textContent = '';
  $('#paymentUnlockPassword').value = '';
  $('#paymentUnlockDlg').showModal();
  $('#paymentUnlockPassword').focus();
};
$('#paymentUnlockBack').onclick = () => $('#paymentUnlockDlg').close();
$('#paymentUnlockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const sessionToken = state.token, adminId = state.user?.id;
  const button = $('#paymentUnlockSubmit'); button.disabled = true;
  $('#paymentUnlockErr').textContent = '';
  try {
    const data = await api('/admin/payment-settings/unlock', { method: 'POST', body: { password: $('#paymentUnlockPassword').value } });
    if (state.token !== sessionToken || state.user?.role !== 'admin' || state.user.id !== adminId) return;
    paymentEditToken = data.editToken;
    $('#paymentUnlockDlg').close();
    $('#paymentEditor').hidden = false;
    try { await loadPaymentSettings(); }
    catch (err) { $('#paymentSettingsErr').textContent = err.message; }
    $('#paymentSettingsForm [name=bankBin]').focus();
  } catch (err) { $('#paymentUnlockErr').textContent = err.message; }
  finally { $('#paymentUnlockPassword').value = ''; button.disabled = false; }
});
$('#paymentEditorClose').onclick = lockPaymentEditor;
function clearPaymentQrPreview() {
  if (paymentQrPreviewUrl) URL.revokeObjectURL(paymentQrPreviewUrl);
  paymentQrPreviewUrl = null;
  $('#paymentQrPreview').removeAttribute('src');
  $('#paymentQrPreview').hidden = true;
}
$('#paymentSettingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.user?.role !== 'admin' || !paymentEditToken || $('#paymentEditor').hidden) return;
  const button = e.target.querySelector('button[type="submit"]');
  const data = Object.fromEntries(new FormData(e.target));
  button.disabled = true;
  $('#paymentSettingsErr').textContent = '';
  try {
    await api('/admin/payment-settings', { method: 'PUT', body: data, headers: paymentEditHeaders() });
    await loadPaymentSettings();
    toast('Đã lưu tài khoản nhận chuyển khoản');
  } catch (err) { $('#paymentSettingsErr').textContent = err.message; handlePaymentEditError(err); }
  finally { button.disabled = false; }
});
$('#paymentQrFile').onchange = () => {
  const file = $('#paymentQrFile').files?.[0];
  $('#paymentQrFilename').textContent = file ? file.name : 'Chưa chọn ảnh · PNG, JPEG, WebP';
  $('#paymentQrUpload').textContent = $('#paymentQrRemove').hidden ? 'Tải ảnh QR lên' : 'Thay ảnh QR';
  $('#paymentQrUpload').disabled = !file || paymentQrUploading;
  $('#paymentQrErr').textContent = '';
};
$('#paymentQrUpload').onclick = async () => {
  if (state.user?.role !== 'admin' || !paymentEditToken || $('#paymentEditor').hidden || paymentQrUploading) return;
  const file = $('#paymentQrFile').files?.[0], button = $('#paymentQrUpload');
  $('#paymentQrErr').textContent = '';
  const inferredMime = /\.png$/i.test(file?.name || '') ? 'image/png' : /\.jpe?g$/i.test(file?.name || '') ? 'image/jpeg' : /\.webp$/i.test(file?.name || '') ? 'image/webp' : '';
  const mime = file?.type || inferredMime;
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(mime) || file.size > 5 * 1024 * 1024 || file.size === 0) {
    $('#paymentQrErr').textContent = 'Chọn ảnh PNG, JPEG hoặc WebP tối đa 5 MB.';
    return;
  }
  const form = $('#paymentSettingsForm');
  if (!form.reportValidity()) { $('#paymentQrErr').textContent = 'Điền đầy đủ tài khoản nhận tiền trước khi tải ảnh QR.'; return; }
  paymentQrUploading = true;
  button.disabled = $('#paymentQrRemove').disabled = true;
  try {
    // Lưu cùng thông tin tài khoản đang điền, kể cả lần đầu thiết lập.
    await api('/admin/payment-settings', { method: 'PUT', body: Object.fromEntries(new FormData(form)), headers: paymentEditHeaders() });
    const response = await fetch('/api/admin/payment-settings/qr', {
      method: 'PUT', headers: { Authorization: 'Bearer ' + state.token, 'X-Payment-Edit-Token': paymentEditToken, 'Content-Type': mime }, body: file,
    });
    if (!response.ok) { const data = await response.json().catch(() => ({})); const err = new Error(data.error || 'Không tải được ảnh QR'); err.status = response.status; throw err; }
    $('#paymentQrFile').value = '';
    $('#paymentQrFilename').textContent = 'Chưa chọn ảnh · PNG, JPEG, WebP';
    await loadPaymentSettings();
    toast('Đã lưu ảnh QR nhận chuyển khoản');
  } catch (err) { $('#paymentQrErr').textContent = err.message; handlePaymentEditError(err); }
  finally {
    paymentQrUploading = false;
    button.disabled = !$('#paymentQrFile').files?.length;
    $('#paymentQrRemove').disabled = false;
    button.textContent = $('#paymentQrRemove').hidden ? 'Tải ảnh QR lên' : 'Thay ảnh QR';
  }
};
$('#paymentQrRemove').onclick = async () => {
  if (state.user?.role !== 'admin' || !paymentEditToken || $('#paymentEditor').hidden || paymentQrUploading || !confirm('Gỡ ảnh QR đã tải lên và dùng lại mã VietQR tự tạo?')) return;
  const button = $('#paymentQrRemove'); button.disabled = true;
  $('#paymentQrErr').textContent = '';
  try {
    await api('/admin/payment-settings/qr', { method: 'DELETE', headers: paymentEditHeaders() });
    await loadPaymentSettings();
    $('#paymentQrUpload').textContent = 'Tải ảnh QR lên';
    toast('Đã gỡ ảnh QR');
  } catch (err) { $('#paymentQrErr').textContent = err.message; handlePaymentEditError(err); }
  finally { button.disabled = false; }
};

// ---- báo cáo doanh thu theo khoảng ngày ----
let revFrom = addDays(todayStr(), -6), revTo = todayStr();
let revStart = revFrom, revEnd = revTo, revMonth = todayStr().slice(0, 7), revLoadSeq = 0;
const revDate = (day) => { const [year, month, date] = day.split('-'); return `${date}/${month}/${year.slice(2)}`; };
function setRevenueCalendar(open) {
  $('#revCalendar').hidden = !open;
  $('#revRangeToggle').setAttribute('aria-expanded', String(open));
  if (open) { revStart = revFrom; revEnd = revTo; revMonth = revTo.slice(0, 7); renderRevenueDays(); }
}
function renderRevenueDays() {
  const [year, month] = revMonth.split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const today = todayStr(), oldest = addDays(today, -365);
  $('#revMonth').textContent = first.toLocaleDateString('vi-VN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  $('#revPrev').disabled = revMonth <= oldest.slice(0, 7);
  $('#revNext').disabled = revMonth >= today.slice(0, 7);
  let cells = Array.from({ length: (first.getUTCDay() + 6) % 7 }, () => '<span aria-hidden="true"></span>');
  for (let n = 1; n <= count; n++) {
    const day = `${revMonth}-${String(n).padStart(2, '0')}`;
    const allowed = day >= oldest && day <= today;
    const selected = day === revStart || day === revEnd;
    cells.push(`<button type="button" data-rev-day="${day}" class="rev-day${selected ? ' selected' : ''}${revStart && revEnd && day > revStart && day < revEnd ? ' between' : ''}${day === today ? ' today' : ''}" ${allowed ? '' : 'disabled'} aria-label="${revDate(day)}" aria-pressed="${selected}">${n}</button>`);
  }
  $('#revDays').innerHTML = cells.join('');
  $('#revSelection').textContent = !revStart ? 'Chọn ngày bắt đầu' : revEnd ? `${revDate(revStart)} – ${revDate(revEnd)}` : `${revDate(revStart)} → Chọn ngày kết thúc`;
  $('#revApply').disabled = !revStart || !revEnd;
}
$('#revRangeToggle').onclick = () => setRevenueCalendar($('#revCalendar').hidden);
$('#revPrev').onclick = () => { revMonth = shiftMonth(revMonth, -1); renderRevenueDays(); };
$('#revNext').onclick = () => { revMonth = shiftMonth(revMonth, 1); renderRevenueDays(); };
$('#revDays').addEventListener('click', (e) => {
  const day = e.target.closest('[data-rev-day]');
  if (!day || day.disabled) return;
  if (!revStart || revEnd || day.dataset.revDay < revStart) { revStart = day.dataset.revDay; revEnd = null; }
  else revEnd = day.dataset.revDay;
  renderRevenueDays();
});
document.querySelectorAll('[data-rev-preset]').forEach((button) => button.addEventListener('click', async () => {
  revEnd = todayStr(); revStart = addDays(revEnd, 1 - Number(button.dataset.revPreset));
  revMonth = revEnd.slice(0, 7); renderRevenueDays();
  $('#revApply').click();
}));
$('#revApply').onclick = async () => {
  if (!revStart || !revEnd) return;
  const button = $('#revApply'); button.disabled = true;
  $('#revError').hidden = true;
  try { await loadRevenue(revStart, revEnd); setRevenueCalendar(false); }
  catch (err) { $('#revError').textContent = err.message; $('#revError').hidden = false; }
  finally { button.disabled = false; }
};
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#revCalendar').hidden) setRevenueCalendar(false); });
async function loadRevenue(from = revFrom, to = revTo) {
  if(!can('revenueView')) return;
  if(state.user?.role==='staff') from=to=todayStr();
  const request = ++revLoadSeq;
  const r = await api('/admin/revenue?' + new URLSearchParams({ from, to }));
  if (request !== revLoadSeq) return;
  revFrom = from; revTo = to;
  $('#revRangeLabel').textContent = `${revDate(from)} – ${revDate(to)}`;
  $('#revError').hidden = true;
  $('#revTotal').textContent = money(r.total);
  const mode = r.rows.length > 90 ? 'month' : r.rows.length > 31 ? 'week' : 'day';
  const groups = [];
  for (const day of r.rows) {
    const last = groups.at(-1);
    if (mode === 'month' && last?.key === day.date.slice(0, 7) || mode === 'week' && last?.days < 7) {
      last.to = day.date; last.days++; last.revenue += day.revenue; last.bookings += day.bookings;
    } else groups.push({ key: day.date.slice(0, 7), from: day.date, to: day.date, days: 1, revenue: day.revenue, bookings: day.bookings });
  }
  const max = Math.max(1, ...groups.map((d) => d.revenue));
  $('#revChart').style.minWidth = groups.length > 10 ? `${groups.length * 65}px` : '100%';
  $('#revChart').innerHTML = groups.map((d) => {
    const label = mode === 'month' ? d.key.slice(5) + '/' + d.key.slice(2, 4) : mode === 'week' ? `${revDate(d.from).slice(0, 5)}–${revDate(d.to).slice(0, 5)}` : revDate(d.from).slice(0, 5);
    return `<div class="bar" title="${label} · ${d.bookings} booking · ${money(d.revenue)}"><span>${d.revenue ? Math.round(d.revenue / 1000) + 'K' : ''}</span><i style="height:${Math.max(2, d.revenue / max * 78)}%"></i><span>${label}</span></div>`;
  }).join('');
  $('#revChartHint').textContent = (mode === 'month' ? 'Gộp theo tháng' : mode === 'week' ? 'Gộp theo từng 7 ngày' : 'Theo ngày') + ' · Booking đã chơi xong';
}

// ---- quản lý sân: thêm / chỉnh sửa / xóa ----
function renderCourtList() {
  $('#courtList').innerHTML = state.courts.map((c) => `
    <div class="court-row">
      <div><b>${esc(c.name)}</b> <span>Giá theo khung giờ · ${c.open_time.slice(0, 5)}–${c.close_time.slice(0, 5)}</span>${c.under_maintenance ? '<small class="court-maintenance-badge">Đang bảo trì</small>' : ''}</div>
      <button data-edit-court="${c.id}" type="button">Chỉnh sửa</button>
    </div>`).join('') || '<p class="mute">Chưa có sân nào.</p>';
}
function setCourtAddOpen(open) {
  $('#courtForm').hidden = !open;
  $('#courtAddToggle').setAttribute('aria-expanded', String(open));
  if (open) $('#courtForm [name=name]').focus();
  else $('#courtErr').textContent = '';
}
$('#courtAddToggle').onclick = () => setCourtAddOpen($('#courtForm').hidden);
$('#courtAddClose').onclick = () => setCourtAddOpen(false);
$('#courtForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  $('#courtErr').textContent = '';
  try {
    await api('/admin/courts', { method: 'POST', body: { name: f.name, pricePerHour: +f.pricePerHour, openTime: f.openTime, closeTime: f.closeTime } });
    toast('Đã thêm sân mới'); e.target.reset();
    $('#courtForm [name=openTime]').value = '06:00'; $('#courtForm [name=closeTime]').value = '23:00';
    setCourtAddOpen(false);
  } catch (err) { $('#courtErr').textContent = err.message; }
});
$('#courtList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-edit-court]'); if (!b) return;
  const c = state.courts.find((court) => court.id === +b.dataset.editCourt);
  if (!c) return;
  const form = $('#courtEditForm');
  for (const [name, value] of Object.entries({ id: c.id, name: c.name,
    pricePerHour: c.price_per_hour, openTime: c.open_time.slice(0, 5), closeTime: c.close_time.slice(0, 5) }))
    form.querySelector(`[name="${name}"]`).value = value;
  form.elements.underMaintenance.checked = !!c.under_maintenance;
  $('#courtEditErr').textContent = '';
  $('#courtEditDlg').showModal();
});
$('#courtEditCancel').onclick = () => $('#courtEditDlg').close();
$('#courtEditForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  $('#courtEditErr').textContent = '';
  try {
    const updated = await api(`/admin/courts/${f.id}`, { method: 'PATCH', body: {
      name: f.name, pricePerHour: +f.pricePerHour,
      openTime: f.openTime, closeTime: f.closeTime,
    } });
    const maintenance = $('#courtEditForm').elements.underMaintenance.checked;
    if (maintenance !== !!updated.under_maintenance) {
      await api(`/admin/courts/${f.id}/maintenance`, { method: 'PATCH', body: { value: maintenance } });
    }
    state.courts = state.courts.map((c) => c.id === updated.id ? { ...c, ...updated, under_maintenance: maintenance } : c);
    renderCourtList(); renderBkCourts(); renderAsCourts();
    loadAdminSchedule();
    $('#courtEditDlg').close(); toast('Đã cập nhật sân');
  } catch (err) { $('#courtEditErr').textContent = err.message; }
});
$('#courtEditDelete').onclick = async () => {
  const id = $('#courtEditForm').querySelector('[name=id]').value;
  if (!confirm('Xóa sân này? Chỉ xóa được nếu sân chưa có booking nào.')) return;
  try {
    await api(`/admin/courts/${id}`, { method: 'DELETE' });
    state.courts = state.courts.filter((c) => String(c.id) !== id);
    renderCourtList(); renderBkCourts(); renderAsCourts();
    loadAdminSchedule();
    $('#courtEditDlg').close(); toast('Đã xóa sân');
  } catch (err) { $('#courtEditErr').textContent = err.message; }
};

// ---- thông báo booking mới + lịch sân ----
let bookingAudioContext = null;
function unlockBookingAudio() {
  if (!bookingAudioContext) {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;
    try { bookingAudioContext = new AudioContextCtor(); } catch { return; }
  }
  if (bookingAudioContext.state === 'suspended')
    Promise.resolve(bookingAudioContext.resume()).catch(() => {});
}
for (const type of ['pointerdown', 'touchstart', 'keydown', 'click'])
  document.addEventListener(type, unlockBookingAudio, { passive: true });
function playBookingAlert() {
  if (!bookingAudioContext) unlockBookingAudio();
  if (!bookingAudioContext) return;
  const chime = () => {
    if (bookingAudioContext.state !== 'running') return;
    const now = bookingAudioContext.currentTime + .02;
    for (const [frequency, offset] of [[659.25, 0], [880, .16]]) {
      const oscillator = bookingAudioContext.createOscillator();
      const volume = bookingAudioContext.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, now + offset);
      volume.gain.setValueAtTime(.0001, now + offset);
      volume.gain.exponentialRampToValueAtTime(.055, now + offset + .018);
      volume.gain.exponentialRampToValueAtTime(.0001, now + offset + .14);
      oscillator.connect(volume); volume.connect(bookingAudioContext.destination);
      oscillator.start(now + offset); oscillator.stop(now + offset + .15);
    }
  };
  if (bookingAudioContext.state === 'running') chime();
  else Promise.resolve(bookingAudioContext.resume()).then(chime).catch(() => {});
}
function setNotifDot() {
  const dot = $('#admNotifDot');
  const manager = ['admin', 'staff'].includes(state.user?.role);
  dot.hidden = !manager || state.adm.unread === 0;
  dot.textContent = state.adm.unread > 9 ? '9+' : state.adm.unread;
  $('#nav-mine').setAttribute('aria-label', manager && state.adm.unread
    ? `Lịch đặt sân, ${state.adm.unread} booking mới` : manager ? 'Lịch đặt sân' : 'Lịch của tôi');
}
function onAdminNewBooking(b) {
  if (!can('bookingView')) return;
  if (b.id != null) {
    const id = String(b.id);
    if (state.adm.newIds.has(id)) return;
    state.adm.newIds.add(id);
    if (state.adm.newIds.size > 200) state.adm.newIds.delete(state.adm.newIds.values().next().value);
  }
  state.adm.unread++; setNotifDot();
  playBookingAlert();
  toast(`Có booking mới #${b.id}. Mở lịch đặt sân để xem chi tiết.`);
  loadAdminSchedule(); loadAdmin();
}
function vnDayOf(iso) { return new Date(new Date(iso).getTime() + 7 * 3600e3).toISOString().slice(0, 10); }

$('#nav-mine').addEventListener('click', () => {
  if (!['admin', 'staff'].includes(state.user?.role)) return;
  state.adm.unread = 0; setNotifDot();
  loadMine().catch((e) => toast(e.message, true));
});
$('#nav-admin').addEventListener('click', () => {
  loadAdminSchedule();
});

let admScheduleData = null;
let scheduleRequest = 0;

async function loadAdminSchedule() {
  if ($('#booking').hidden) return;
  const request = ++scheduleRequest;
  const date = state.bk.date, manager = can('bookingView');
  $('#courtSchedule').setAttribute('aria-busy', 'true');
  try {
    const data = await api(`${manager ? '/admin/schedule' : '/schedule'}?date=${encodeURIComponent(date)}`);
    if (request !== scheduleRequest || date !== state.bk.date || manager !== can('bookingView')) return;
    if (!state.courts.length && data.courts?.length) state.courts = data.courts.map(c => ({ ...c, status: 'AVAILABLE' }));
    admScheduleData = data;
    renderCourtSchedule(data);
  } catch (err) {
    if (request !== scheduleRequest) return;
    $('#courtSchedule').innerHTML = `<div class="schedule-error">Không tải được lịch sân: ${esc(err.message)}</div>`;
  } finally {
    if (request === scheduleRequest) $('#courtSchedule').removeAttribute('aria-busy');
  }
}

function scheduleMinLabel(m) { return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }
function scheduleBookingAt(bookings, s, e) {
  return bookings.find(x => s < +new Date(x.ends_at) && e > +new Date(x.starts_at));
}
function renderSelectionBar() {
  const manager = ['admin', 'staff'].includes(state.user?.role);
  const selection = manager ? asState : state.bk;
  const range = manager ? asSelectedRange() : selectedRange();
  const court = state.courts.find(c => c.id === selection.courtId);
  $('#selectionBar').hidden = !court || !range;
  if (court && range) $('#selectionText').textContent = `${court.name} · ${fmtMin(range.start)}–${fmtMin(range.end)} · ${durationText(range.dur)}`;
}
$('#selectionContinue').addEventListener('click', () => {
  if (!state.user) { toast('Đăng nhập để đặt sân', true); openAuth(); return; }
  goto(['admin', 'staff'].includes(state.user.role) ? '#asSummary' : '#summary');
});
function toggleScheduleSelection(current, m) {
  const selected = [...current].sort((a, b) => a - b);
  if (!selected.length) return [m];
  if (selected.includes(m)) return m === selected[0] || m === selected.at(-1) ? selected.filter(x => x !== m) : selected;
  if ((m === selected[0] - 30 || m === selected.at(-1) + 30) && selected.length < 6) return [...selected, m];
  return [m];
}

function renderCourtSchedule(data) {
  const viewport = $('#scheduleViewport');
  const scrollLeft = viewport.scrollLeft, scrollTop = viewport.scrollTop;
  const courts = data?.courts || [];
  const bookings = data?.bookings || [];
  if (!courts.length) {
    $('#courtSchedule').innerHTML = '<div class="schedule-error">Chưa có sân nào.</div>'; return;
  }

  const html = courts.map((court) => {
    const minStart = hm(String(court.open_time).slice(0,5));
    const maxEnd = hm(String(court.close_time).slice(0,5));
    const courtBookings = bookings.filter(b => b.court_id === court.id);
    const maintenance = !!court.under_maintenance;
    const slots = [];

    for (let m = minStart; m < maxEnd; m += 30) {
      const s = +toDate(data.date, m), e = s + 30 * 60000;
      const booking = scheduleBookingAt(courtBookings, s, e);
      const manager = ['admin', 'staff'].includes(state.user?.role);
      const selection = manager ? asState : state.bk;
      const selected = selection.date === data.date && selection.courtId === court.id && selection.selected.includes(m);
      const ownHold = selected && !manager && booking?.status === 'pending' && !!state.bk.holdId;
      // Một ca chỉ có thể thao tác khi giờ bắt đầu chưa trôi qua.
      // Slot quá giờ luôn chuyển xám và khóa click, kể cả trước đó có booking.
      const past = s < Date.now();
      const fixed = !!(booking?.schedule_rule_id || booking?.is_fixed);
      const cls = past ? 'past' : maintenance ? 'maintenance' : selected && (!booking || ownHold) ? 'selected' : booking ? (fixed ? 'fixed' : 'booked') : 'free';
      const status = past ? 'Đã qua' : maintenance ? 'Bảo trì' : selected && (!booking || ownHold) ? 'Đang chọn' : booking ? (fixed ? 'Cố định' : booking.status === 'pending' ? 'Đang giữ' : 'Đã đặt') : 'Trống';
      const disabled = past || maintenance || (booking && !booking.id && !ownHold) || (state.user?.role==='staff' && !booking && !can('bookingCreate'));
      slots.push(
        `<button type="button" class="court-slot ${cls}" data-schedule-court="${court.id}" data-schedule-min="${m}" ${disabled ? 'disabled' : ''} aria-pressed="${selected}" aria-label="${esc(court.name)} ${scheduleMinLabel(m)} ${status.toLowerCase()}">` +
          `<span class="court-slot-time">${scheduleMinLabel(m)}</span>` +
        `</button>`
      );
    }

    return `<section class="schedule-column" aria-label="${esc(court.name)}">` +
      `<header class="schedule-column-head"><b>${esc(court.name)}</b></header>` +
      `<div class="schedule-column-slots">${slots.join('')}</div>` +
    `</section>`;
  }).join('');

  $('#courtSchedule').innerHTML = html;
  viewport.scrollLeft = scrollLeft;
  viewport.scrollTop = scrollTop;
}

function schedulePaymentText(v) { return v === 'transfer' ? 'Chuyển khoản' : 'Thanh toán tại sân'; }
function scheduleStatusText(v) { return v === 'pending' ? 'Đang giữ chỗ' : v === 'confirmed' ? 'Đã xác nhận' : v || '—'; }

const scheduleSheet = {
  selected: null,
  open(item) {
    this.selected = item;
    const booking = item.booking;
    $('#scheduleSheet').classList.toggle('booking-popup', !!booking);
    if (booking) {
      $('#scheduleSheetTitle').textContent = `${item.courtName} · Booking #${booking.id}`;
      $('#scheduleSheetMeta').textContent = `${fmtD(booking.starts_at)} · ${fmtT(booking.starts_at)}–${fmtT(booking.ends_at)}`;
      const paidText = Number(booking.paid_amount ?? 0) >= Number(booking.invoice_total ?? booking.total_price) && booking.paid ? 'Đã thanh toán' : booking.payment_method === 'transfer' && !booking.paid ? 'Chờ xác nhận' : 'Chưa thanh toán';
      $('#scheduleSheetInfo').innerHTML =
        `<div class="booking-detail-grid">` +
          `<div><span>Người chơi</span><b>${esc(booking.player_name || 'Khách đặt sân')}</b></div>` +
          `<div><span>Số điện thoại</span><b>${esc(booking.player_phone || '—')}</b></div>` +
          `<div><span>Email tài khoản</span><b>${esc(booking.user_email || '—')}</b></div>` +
          `<div><span>Trạng thái</span><b>${booking.schedule_rule_id ? 'Cố định · ' : ''}${esc(scheduleStatusText(booking.status))}</b></div>` +
          `<div><span>Thời điểm tạo booking</span><b>${bookingTimeText(booking)}</b></div>` +
          `<div><span>Thanh toán</span><b>${esc(schedulePaymentText(booking.payment_method))}</b></div>` +
          `<div><span>Tình trạng tiền</span><b>${esc(paidText)}</b></div>` +
          `<div><span>Tổng tiền</span><b>${money(Number(booking.invoice_total ?? booking.total_price ?? 0))}</b></div>` +
          `<div><span>Thời lượng</span><b>${Math.round((new Date(booking.ends_at) - new Date(booking.starts_at)) / 60000)} phút</b></div>` +
        `</div>${paidTag(booking)}`;
    } else {
      $('#scheduleSheetTitle').textContent = `${item.courtName} · ${item.time}`;
      $('#scheduleSheetMeta').textContent = `${fmtD(item.date + 'T00:00:00+07:00')} · ${item.time}–${scheduleMinLabel(item.min + 30)}`;
      $('#scheduleSheetInfo').innerHTML = `<b>Khung giờ còn trống</b><span>Ca 30 phút · ${money(previewPrice(item.date, item.min, item.min + 30, state.user?.memberType)?.total || 0)}</span>`;
    }
    const action = $('#scheduleSheetAction');
    action.textContent = booking ? (booking.status === 'confirmed' ? 'Chi tiết' : 'Đóng') : ['admin', 'staff'].includes(state.user?.role) ? 'Gán lịch' : 'Chọn ca này';
    action.disabled = false;
    $('#scheduleSheetBackdrop').hidden = false;
    $('#scheduleSheet').hidden = false;
    requestAnimationFrame(() => { $('#scheduleSheetBackdrop').classList.add('show'); $('#scheduleSheet').classList.add('show'); });
  },
  close() {
    $('#scheduleSheetBackdrop').classList.remove('show'); $('#scheduleSheet').classList.remove('show');
    setTimeout(() => {
      $('#scheduleSheetBackdrop').hidden = true; $('#scheduleSheet').hidden = true;
      $('#scheduleSheet').classList.remove('booking-popup');
    }, 180);
    this.selected = null;
  }
};

async function openScheduleCell(courtId, m) {
  const data = admScheduleData; if (!data) return;
  const court = (data.courts || []).find(c => c.id === courtId); if (!court) return;
  const bookings = (data.bookings || []).filter(b => b.court_id === courtId);
  const s = +toDate(data.date, m), e = s + 30 * 60000;
  const booking = scheduleBookingAt(bookings, s, e);
  const manager = ['admin', 'staff'].includes(state.user?.role);
  const ownHold = !manager && state.bk.courtId === courtId && state.bk.selected.includes(m) && booking?.status === 'pending' && !!state.bk.holdId;
  if (booking && !ownHold) {
    if (manager && booking.id) scheduleSheet.open({ court, courtName: court.name, date: data.date, min: m, time: scheduleMinLabel(m), booking });
    return;
  }
  if (court.under_maintenance || s < Date.now() || state.bk.date !== data.date) return;
  if (manager) {
    if (!can('bookingCreate')) return;
    if (asState.courtId !== courtId) {
      asState.courtId = courtId; asState.date = data.date; asState.selected = [];
      await loadAsBooked();
      if (asState.courtId !== courtId || state.bk.date !== data.date) return;
    }
    if (asState.booked.some(x => s < x.end && e > x.start)) return loadAdminSchedule();
    asState.selected = toggleScheduleSelection(asState.selected, m);
    renderAssignStages(); renderAsSummary();
  } else {
    if (state.bk.courtId !== courtId) {
      await selectCourt(courtId);
      if (state.bk.courtId !== courtId || state.bk.date !== data.date) return;
    }
    if (state.bk.booked.some(x => s < x.end && e > x.start)) return loadAdminSchedule();
    state.bk.selected = toggleScheduleSelection(state.bk.selected, m);
    renderSlots(); renderBookingStages(); renderSummary();
    if (state.user) scheduleHold();
  }
  renderCourtSchedule(data);
}

// Trên màn hình chạm, giữ cuộn gốc của trình duyệt để có quán tính và cuộn hai chiều.
// Chuột và bút vẫn kéo được lịch như một bảng độc lập.
let scheduleDragSuppressUntil = 0;
(function initScheduleViewportDrag() {
  const viewport = $('#scheduleViewport'); if (!viewport) return;
  let drag = null;
  const finish = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    if (drag.moved) scheduleDragSuppressUntil = performance.now() + 220;
    try { if (viewport.hasPointerCapture?.(drag.id)) viewport.releasePointerCapture(drag.id); } catch {}
    viewport.classList.remove('is-dragging');
    drag = null;
  };
  viewport.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!e.target.closest('.schedule-columns')) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: viewport.scrollLeft, top: viewport.scrollTop, moved: false };
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    try { viewport.setPointerCapture(e.pointerId); } catch {}
    viewport.classList.add('is-dragging');
    viewport.scrollLeft = drag.left - dx;
    viewport.scrollTop = drag.top - dy;
    e.preventDefault();
  }, { passive: false });
  viewport.addEventListener('pointerup', finish);
  viewport.addEventListener('pointercancel', finish);
  viewport.addEventListener('lostpointercapture', finish);
  // Cuộn gốc cho quán tính; khi viewport chạm mép, trang tiếp tục cuộn bình thường.
  viewport.addEventListener('wheel', (e) => {
    const x = e.deltaX, y = e.deltaY;
    const canX = x && (x < 0 ? viewport.scrollLeft > 0 : viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 1);
    const canY = y && (y < 0 ? viewport.scrollTop > 0 : viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1);
    if (canX || canY) e.stopPropagation();
  }, { passive: true });
})();

$('#courtSchedule').addEventListener('click', (e) => {
  if (performance.now() < scheduleDragSuppressUntil) { e.preventDefault(); return; }
  const b = e.target.closest('[data-schedule-court]'); if (!b || b.disabled) return;
  openScheduleCell(+b.dataset.scheduleCourt, +b.dataset.scheduleMin).catch(err => toast(err.message, true));
});
$('#scheduleSheetClose').addEventListener('click', () => scheduleSheet.close());
$('#scheduleSheetBackdrop').addEventListener('click', () => scheduleSheet.close());
$('#scheduleSheetAction').addEventListener('click', () => {
  const item = scheduleSheet.selected; if (!item) return;
  const manager = ['admin', 'staff'].includes(state.user?.role);
  if (item.booking) {
    const booking = item.booking;
    scheduleSheet.close();
    if (manager && booking.status === 'confirmed') openBookingExtras(booking.id);
    return;
  }
  scheduleSheet.close();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#scheduleSheet').hidden) scheduleSheet.close(); });

// Quản lý các khoản phát sinh và in hóa đơn cho booking đã xác nhận.
let extrasBookingId = null, extrasBill = null;
async function openBookingExtras(id) {
  if (!can('bookingView')) return;
  extrasBookingId = String(id); extrasBill = null;
  $('#extrasErr').textContent = '';
  $('#extrasBookingCode').textContent = `BOOKING #${id}`;
  $('#extrasTitle').textContent = 'Chi tiết booking';
  $('#extrasMeta').textContent = '';
  $('#extrasPlacedAt').textContent = '';
  $('#extrasPaidTag').hidden = true;
  $('#extrasLines').innerHTML = '<p class="mute">Đang tải booking…</p>';
  $('#extrasTotals').innerHTML = '';
  $('#extrasExtendSection').hidden = true;
  $('#extrasExtendSection').open = false;
  $('#extrasDiscountSection').hidden = true;
  $('#extrasProductForm').reset();
  syncExtrasService();
  $('#extrasProductForm').querySelector('button[type="submit"]').disabled = true;
  $('#extrasPrint').disabled = true;
  $('#extrasSettle').disabled = true;
  $('#extrasSettle').classList.remove('is-paid');
  $('#extrasSettle').textContent = 'Thanh toán';
  $('#extrasCancel').hidden = true;
  $('#bookingExtrasDlg').showModal();
  try { await reloadBookingExtras(); }
  catch (err) { $('#extrasErr').textContent = err.message; }
}
async function reloadBookingExtras() {
  const id = extrasBookingId;
  const bill = await api(`/admin/bookings/${id}/bill`);
  if (id !== extrasBookingId) return;
  extrasBill = bill;
  const b = bill.booking;
  const transferExpired = b.payment_method === 'transfer' && !b.paid &&
    !!b.confirmed_at && +new Date(b.confirmed_at) + 600_000 <= Date.now();
  const shortDate = (value) => new Date(value).toLocaleDateString('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', year: '2-digit' });
  const placedAt = b.confirmed_at || b.created_at;
  $('#extrasBookingCode').textContent = `BOOKING #${b.id}`;
  $('#extrasTitle').textContent = `${b.court_name} · ${playTimeText(b)}`;
  $('#extrasMeta').textContent = `${b.player_name} · ${b.player_phone}`;
  $('#extrasPlacedAt').textContent = placedAt ? `${fmtT(placedAt)} · ${shortDate(placedAt)}` : '';
  $('#extrasPaidTag').hidden = b.status !== 'confirmed' || bill.due > 0;
  const anyPaid=b.paid || bill.addons.some(a=>a.paid);
  const collect=canCollect(b);
  renderBookingEdit(b,bill);
  $('.extras-services').hidden=!can('addonManage');
  $('#extrasExtendSection').hidden = !can('bookingEdit') || anyPaid || b.status !== 'confirmed' || +new Date(b.ends_at) <= Date.now();
  $('#extrasProductForm').querySelector('button[type="submit"]').disabled = b.status !== 'confirmed';
  $('#extrasPrint').disabled = b.status !== 'confirmed';
  $('#extrasSettle').disabled = !collect || b.status !== 'confirmed' || bill.due <= 0 || transferExpired;
  $('#extrasSettle').classList.toggle('is-paid', b.status === 'confirmed' && bill.due <= 0);
  $('#extrasSettle').textContent = bill.due <= 0 ? '✓ Đã thu tiền' : 'Thanh toán';
  $('#extrasCancel').hidden = !can('cancelUnpaid') || (state.user?.role==='staff' && anyPaid) || b.status !== 'confirmed';
  const basePaid = `<label class="extras-paid-option"><input type="checkbox" data-base-paid aria-label="Đã thu tiền sân" ${b.paid ? 'checked' : ''} ${!collect || (state.user?.role==='staff' && b.paid) || transferExpired || b.status !== 'confirmed' ? 'disabled' : ''}> Đã thu</label>`;
  const cancelCourt = !$('#extrasCancel').hidden
    ? '<button class="extras-remove" type="button" data-booking-cancel aria-label="Hủy booking" title="Hủy booking">×</button>' : '';
  $('#extrasLines').innerHTML = `<div class="extras-line"><div class="extras-line-info"><b>Tiền sân</b><small>${fmtT(b.starts_at)}–${fmtT(b.ends_at)} · ${tariffDescription(b)}</small></div><div class="extras-line-payment"><strong title="Sau giảm: ${money(bill.baseNet ?? bill.base)}">${money(bill.base)}</strong>${basePaid}</div>${cancelCourt}</div>` +
    bill.addons.map((a) => `<div class="extras-line"><div class="extras-line-info"><b>${esc(a.label)}</b><small>${a.quantity} × ${money(a.unit_price)}${a.kind === 'extra_time' ? ' · Gia hạn' : ''}</small></div><div class="extras-line-payment"><strong title="Sau giảm: ${money(a.net ?? a.quantity * a.unit_price)}">${money(a.quantity * a.unit_price)}</strong><label class="extras-paid-option"><input type="checkbox" data-addon-paid="${a.id}" aria-label="Đã thu ${esc(a.label)}" ${a.paid ? 'checked' : ''} ${!collect || (state.user?.role==='staff' && a.paid) || transferExpired || b.status !== 'confirmed' ? 'disabled' : ''}> Đã thu</label></div>${can('addonManage') && !(state.user?.role==='staff' && a.paid) && a.kind === 'product' && b.status === 'confirmed' ? `<button class="extras-remove" type="button" data-addon-remove="${a.id}" aria-label="Xóa ${esc(a.label)}" title="Xóa dịch vụ">×</button>` : ''}</div>`).join('');
  $('#extrasTotals').innerHTML = `<span class="discount-saving">Giảm giá <b>${bill.discount ? '−' : ''}${money(bill.discount || 0)}</b></span>${bill.paidAmount > 0 ? `<span class="extras-collected">Đã thu <b>${money(bill.paidAmount)}</b></span>` : ''}<span class="extras-due">Còn thu <b>${money(bill.due)}</b></span>${tariffLines(b)}`;
  $('#extrasDiscountSection').hidden = !can('discount') || b.status !== 'confirmed';
  const df = $('#extrasDiscountForm');
  df.elements.type.value = b.invoice_discount_type || 'amount';
  df.elements.value.value = b.invoice_discount_value || 0;
  const locked = b.paid || bill.addons.some(a=>a.paid) || transferExpired;
  [...df.elements].forEach(el=>el.disabled=locked);
  $('#extrasDiscountNote').textContent = transferExpired ? 'Không thể sửa giảm giá khi chuyển khoản đã quá hạn.' : 'Bỏ xác nhận các khoản đã thu trước khi sửa giảm giá.';
  $('#extrasDiscountNote').hidden = !locked;
  previewInvoiceDiscount();
}
function refreshBookingViews() {
  loadMine().catch((e) => toast(e.message, true));
  loadAdminSchedule().catch((e) => toast(e.message, true));
  loadRevenue().catch((e) => toast(e.message, true));
}
$('#extrasClose').onclick = () => $('#bookingExtrasDlg').close();
$('#bookingExtrasDlg').addEventListener('click', (e) => {
  const dlg = e.currentTarget, bounds = dlg.getBoundingClientRect();
  if (e.target === dlg && (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom)) dlg.close();
});
$('#bookingExtrasDlg').addEventListener('close', () => {
  if (!$('#bookingExtrasDlg').open) { extrasBookingId = null; extrasBill = null; }
});
$('#extrasSettle').onclick = async () => {
  if (!['admin', 'staff'].includes(state.user?.role) || extrasBill?.booking?.status !== 'confirmed' || !extrasBookingId || extrasBill.due <= 0) return;
  const id = extrasBookingId, button = $('#extrasSettle');
  button.disabled = true;
  $('#extrasErr').textContent = '';
  try {
    await api(`/admin/bookings/${id}/settle`, { method: 'POST' });
    if (id === extrasBookingId) await reloadBookingExtras();
    refreshBookingViews();
    toast('Đã ghi nhận thu đủ tiền booking');
  } catch (err) { $('#extrasErr').textContent = err.message; }
  finally { button.disabled = !canCollect(extrasBill?.booking) || !extrasBill || extrasBill.booking.status !== 'confirmed' || extrasBill.due <= 0; }
};
$('#extrasCancel').onclick = async () => {
  if (!can('cancelUnpaid') || extrasBill?.booking?.status !== 'confirmed' || !extrasBookingId) return;
  if (!await confirmBookingCancellation('Booking sẽ được đánh dấu đã hủy trong lịch sử. Số tiền đã thu không tự hoàn lại.')) return;
  const id = extrasBookingId, button = $('#extrasCancel');
  button.disabled = true;
  $('#extrasErr').textContent = '';
  try {
    await api(`/bookings/${id}/cancel`, { method: 'PATCH' });
    $('#bookingExtrasDlg').close();
    toast('Đã hủy lịch');
    refreshBookingViews();
  } catch (err) { $('#extrasErr').textContent = err.message; }
  finally { button.disabled = false; }
};
function syncExtrasService() {
  const custom = $('#extrasPreset').value === 'other';
  const input = $('#extrasProductForm').elements.label;
  $('#extrasCustomService').hidden = !custom;
  input.disabled = !custom;
  input.required = custom;
  if (!custom) input.value = $('#extrasPreset').value;
}
$('#extrasPreset').onchange = () => {
  if ($('#extrasPreset').value === 'other') $('#extrasProductForm').elements.label.value = '';
  syncExtrasService();
  if ($('#extrasPreset').value === 'other') $('#extrasProductForm').elements.label.focus();
};
$('#extrasProductForm').addEventListener('click', (e) => {
  const button = e.target.closest('[data-extras-quantity]');
  if (!button) return;
  const input = $('#extrasProductForm').elements.quantity;
  input.value = String(Math.min(100, Math.max(1, (Number.parseInt(input.value, 10) || 1) + Number(button.dataset.extrasQuantity))));
});
$('#extrasExtendForm').addEventListener('submit', async (e) => {
  e.preventDefault(); if (!extrasBookingId) return;
  const btn = e.target.querySelector('button[type="submit"]'); btn.disabled = true;
  $('#extrasErr').textContent = '';
  try {
    await api(`/admin/bookings/${extrasBookingId}/extend`, { method: 'POST', body: { minutes: +e.target.elements.minutes.value } });
    await reloadBookingExtras(); refreshBookingViews(); toast('Đã gia hạn booking');
  } catch (err) { $('#extrasErr').textContent = err.message; }
  finally { btn.disabled = false; }
});
$('#extrasProductForm').addEventListener('submit', async (e) => {
  e.preventDefault(); if (!extrasBookingId) return;
  const btn = e.target.querySelector('button[type="submit"]'); btn.disabled = true;
  $('#extrasErr').textContent = '';
  const f = new FormData(e.target);
  try {
    await api(`/admin/bookings/${extrasBookingId}/addons`, { method: 'POST', body: {
      label: String($('#extrasPreset').value === 'other' ? f.get('label') || '' : $('#extrasPreset').value).trim(), quantity: +f.get('quantity'),
      unitPrice: +f.get('unitPrice'),
    } });
    e.target.reset(); e.target.querySelector('[name="quantity"]').value = '1';
    syncExtrasService();
    await reloadBookingExtras(); refreshBookingViews(); toast('Đã thêm dịch vụ');
  } catch (err) { $('#extrasErr').textContent = err.message; }
  finally { btn.disabled = false; }
});
$('#extrasLines').addEventListener('change', async (e) => {
  const base = e.target.closest('[data-base-paid]'), addon = e.target.closest('[data-addon-paid]');
  if (!base && !addon) return;
  const id = extrasBookingId, paid = e.target.checked;
  e.target.disabled = true; $('#extrasErr').textContent = '';
  try {
    if (base) await api(`/admin/bookings/${id}/paid`, { method: 'PATCH', body: { paid } });
    else await api(`/admin/bookings/${id}/addons/${addon.dataset.addonPaid}/paid`, { method: 'PATCH', body: { paid } });
    await reloadBookingExtras(); refreshBookingViews();
  } catch (err) { e.target.checked = !paid; $('#extrasErr').textContent = err.message; }
  finally { if(extrasBookingId) await reloadBookingExtras(); }
});
$('#extrasLines').addEventListener('click', async (e) => {
  if (e.target.closest('[data-booking-cancel]')) return $('#extrasCancel').click();
  const b = e.target.closest('[data-addon-remove]');
  if (!b) return;
  $('#extrasErr').textContent = '';
  try {
    await api(`/admin/bookings/${extrasBookingId}/addons/${b.dataset.addonRemove}`, { method: 'DELETE' });
    await reloadBookingExtras(); refreshBookingViews();
  } catch (err) { $('#extrasErr').textContent = err.message; }
});
function printBookingBill(bill) {
  if (!bill || bill.booking.status !== 'confirmed') return;
  const win = window.open('', '_blank');
  if (!win) return toast('Trình duyệt đang chặn cửa sổ hóa đơn', true);
  win.opener = null;
  const b = bill.booking;
  const dateTime = (iso) => `${new Date(iso).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: TZ })} ${fmtT(iso)}`;
  const rows = `<tr><td>${b.discount_percent ? `Tiền sân · ưu đãi ${b.discount_percent}%` : 'Tiền sân'}</td><td>1</td><td>${money(bill.base)}</td><td>${money(bill.base)}</td></tr>` +
    bill.addons.map((a) => `<tr><td>${esc(a.label)}</td><td>${a.quantity}</td><td>${money(a.unit_price)}</td><td>${money(a.quantity * a.unit_price)}</td></tr>`).join('');
  win.document.open();
  win.document.write(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Hóa đơn booking #${b.id}</title><style>
    body{font:15px/1.5 Arial,sans-serif;color:#18222b;max-width:800px;margin:36px auto;padding:0 24px}h1{font-size:26px;margin:0}h2{font-size:18px;margin:0 0 12px}small{color:#66717b}.head{display:flex;justify-content:space-between;border-bottom:2px solid #18222b;padding-bottom:18px;margin-bottom:18px}.meta{display:grid;grid-template-columns:1fr 1fr;gap:8px 20px;margin:18px 0 25px}table{width:100%;border-collapse:collapse}th,td{padding:10px 8px;border-bottom:1px solid #d9dee2;text-align:left}th:nth-child(n+2),td:nth-child(n+2){text-align:right}.totals{margin:20px 0 0 auto;width:min(320px,100%)}.totals p{display:flex;justify-content:space-between;margin:8px 0}.totals .grand{font-size:19px;font-weight:bold;border-top:2px solid #18222b;padding-top:10px}.toolbar{margin-top:30px;padding:12px 18px;background:#18222b;color:#fff;border:0;border-radius:8px;cursor:pointer}@media print{body{margin:0;max-width:none}.toolbar{display:none}}
    </style></head><body><div class="head"><div><h1>COURTLY</h1><small>Hóa đơn dịch vụ đặt sân</small></div><div><b>Booking #${b.id}</b><br><small>Ngày lập: ${dateTime(new Date())}</small></div></div>
    <div class="meta"><div><b>Khách hàng</b><br>${esc(b.player_name)}</div><div><b>Số điện thoại</b><br>${esc(b.player_phone)}</div><div><b>Email</b><br>${esc(b.user_email || '—')}</div><div><b>Sân</b><br>${esc(b.court_name)}</div><div><b>Thời gian chơi</b><br>${dateTime(b.starts_at)} – ${dateTime(b.ends_at)}</div><div><b>Thanh toán</b><br>${b.payment_method === 'transfer' ? 'Chuyển khoản' : 'Tại sân'}</div></div>
    <h2>Chi tiết thanh toán</h2><table><thead><tr><th>Hạng mục</th><th>SL</th><th>Đơn giá</th><th>Thành tiền</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="totals">${bill.discount ? `<p><span>Tạm tính</span><span>${money(bill.subtotal)}</span></p><p><span>Giảm giá</span><span>−${money(bill.discount)}</span></p>` : ''}<p class="grand"><span>Tổng cộng</span><span>${money(bill.total)}</span></p><p><span>Đã thu</span><span>${money(bill.paidAmount)}</span></p><p><span>Còn thu</span><span>${money(bill.due)}</span></p></div>
    <button class="toolbar" onclick="window.print()">In / Lưu PDF</button></body></html>`);
  win.document.close();
  win.focus();
}
$('#extrasPrint').onclick = () => printBookingBill(extrasBill);
$('#historyBillPrint').onclick = () => { if (['admin', 'staff'].includes(state.user?.role)) printBookingBill(historyBill); };

// ---------- admin: GÁN LỊCH CHO NGƯỜI CHƠI ----------

const asState = {
  date: todayStr(), dateChosen: true, courtId: null, selected: [], booked: [],
  player: null, // người chơi được chọn từ autocomplete tên
};

// Giờ trống thay đổi theo thời gian thực ngay cả khi trang được giữ mở qua nhiều ca.
let slotClockDay = todayStr();
let scheduleClockMinute = Math.floor(Date.now() / 60000);
function refreshSlotClock() {
  const day = todayStr();
  if (day !== slotClockDay) {
    slotClockDay = day;
    if (state.bk.date < day) {
      releaseHold(); state.bk.date = day; state.bk.dateChosen = true; state.bk.courtId = null; state.bk.selected = [];
      renderBookingStages();
    }
    if (asState.date < day) {
      asState.date = day; asState.dateChosen = true; asState.courtId = null; asState.selected = [];
      renderAssignStages();
    }
    calendarMonth = monthKey(day);
    renderDates(); renderAsDates(); loadAdminSchedule().catch(() => {});
  }
  if (state.bk.courtId && state.bk.date === day) renderSlots();
  if (asState.courtId && asState.date === day) renderAsSlots();
  const minute = Math.floor(Date.now() / 60000);
  if (minute !== scheduleClockMinute) {
    scheduleClockMinute = minute;
    if (state.bk.date === day) loadAdminSchedule().catch(() => {});
  }
}
setInterval(refreshSlotClock, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSlotClock(); });
window.addEventListener('focus', refreshSlotClock);

async function loadAssign() {
  if (!state.courts.length) {
    try { state.courts = await api('/courts'); }
    catch (err) { toast('Không tải được danh sách sân: ' + err.message, true); return; }
  }
  renderAsDates();
  const selectedCourt = state.courts.find((c) => c.id === asState.courtId && !c.under_maintenance);
  if (!selectedCourt) {
    asState.courtId = null;
    asState.selected = [];
  }
  renderAssignStages();
  renderAsCourts();
  if (asState.courtId) loadAsBooked();
}

function renderAsDates() {
  $('#asDateChoice').textContent = asState.dateChosen ? `Đã chọn: ${fmtD(asState.date + 'T00:00:00+07:00')}` : 'Chưa chọn ngày chơi.';
}
function renderAssignStages() {
  $('#asCourtStage').hidden = true;
  $('#asTimeStage').hidden = true;
  $('#asSummary').hidden = !['admin', 'staff'].includes(state.user?.role) || !asState.selected.length;
  renderSelectionBar();
}
function renderAsCourts() {
  $('#asCourts').innerHTML = state.courts.map((c) =>
    `<button class="chip ${c.id === asState.courtId ? 'sel' : ''}" data-asc="${c.id}" ${c.under_maintenance ? 'disabled' : ''}>${esc(c.name)}<small>${c.price_per_hour / 1000}K/giờ</small></button>`
  ).join('') || '<p class="mute">Đang tải danh sách sân…</p>';
}
$('#asCourts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-asc]'); if (!b) return;
  asState.courtId = +b.dataset.asc; asState.dateChosen = true; asState.selected = []; asState.booked = [];
  $('#asSlots').innerHTML = '<p class="mute">Đang tải khung giờ…</p>';
  renderAsCourts(); renderAssignStages(); loadAsBooked();
  if (matchMedia('(max-width:999px)').matches) setTimeout(() => goto('#asSlots'), 180);
});
async function loadAsBooked() {
  if (!asState.courtId) { asState.booked = []; renderAsSlots(); return; }
  const courtId = asState.courtId, date = asState.date;
  try {
    const rows = await api(`/courts/${courtId}/booked?date=${date}`);
    if (courtId !== asState.courtId || date !== asState.date) return;
    asState.booked = rows.map((x) => ({ start: +new Date(x.starts_at), end: +new Date(x.ends_at), status: x.status }));
  } catch (err) {
    if (courtId !== asState.courtId || date !== asState.date) return;
    toast('Không tải được giờ trống: ' + err.message, true);
    asState.selected = []; asState.booked = [];
    $('#asSlots').innerHTML = '<p class="mute">Không tải được lịch sân. Vui lòng chọn lại sân hoặc ngày để thử lại.</p>';
    $('#asDurationTotal').hidden = true; renderAsSummary(); $('#asSubmit').disabled = true;
    return;
  }
  renderAsSlots();
}
function asSelectedRange() {
  const s = [...asState.selected].sort((a, z) => a - z);
  if (!s.length) return null;
  return { start: s[0], end: s[s.length - 1] + 30, dur: s.length * 30 };
}
function renderAsSlots() {
  const c = state.courts.find((x) => x.id === asState.courtId);
  const box = $('#asSlots');
  if (!c) { box.innerHTML = '<p class="mute">Chọn sân để xem giờ trống.</p>'; renderAsSummary(); return; }
  if (c.under_maintenance) {
    asState.selected = [];
    box.innerHTML = '<p class="mute">Sân đang bảo trì, vui lòng chọn sân khác.</p>';
    $('#asDurationTotal').hidden = true;
    renderAsSummary();
    return;
  }
  const out = [];
  const available = new Set();
  for (let m = hm(c.open_time); m < hm(c.close_time); m += 30) {
    const s = +toDate(asState.date, m), e = s + 30 * 60000;
    const heldByCustomer = asState.booked.some((x) => x.status === 'pending' && s < x.end && e > x.start);
    const confirmed = asState.booked.some((x) => x.status === 'confirmed' && s < x.end && e > x.start);
    // Gán lịch chỉ hiển thị các ca có thể chọn. Ca đã qua, đã book hoặc đang được khách giữ đều bị ẩn.
    if (s < Date.now() || confirmed || heldByCustomer) continue;
    available.add(m);
    const selected = asState.selected.includes(m);
    out.push(`<button class="${['slot', selected ? 'sel' : ''].filter(Boolean).join(' ')}" data-asm="${m}" aria-pressed="${selected}">${fmtMin(m)}</button>`);
  }
  if (asState.selected.some((m) => !available.has(m))) asState.selected = [];
  renderAssignStages();
  box.innerHTML = out.length ? out.join('') : '<p class="mute">Không còn khung giờ trống phù hợp trong ngày này.</p>';
  const range = asSelectedRange();
  $('#asDurationTotal').hidden = !range;
  if (range) $('#asDurationValue').textContent = range.dur >= 60 ? `${Math.floor(range.dur / 60)} giờ${range.dur % 60 ? ` ${range.dur % 60} phút` : ''}` : `${range.dur} phút`;
  renderAsSummary();
}
$('#asSlots').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-asm]'); if (!btn || btn.disabled) return;
  const m = +btn.dataset.asm;
  if (+toDate(asState.date, m) <= Date.now()) { renderAsSlots(); return; }
  const sel = [...asState.selected].sort((a, z) => a - z);
  if (!sel.length) asState.selected = [m];
  else if (sel.includes(m)) {
    const min = Math.min(...sel), max = Math.max(...sel);
    if (m === min || m === max) asState.selected = sel.filter((x) => x !== m);
  } else {
    const min = Math.min(...sel), max = Math.max(...sel);
    if ((m === min - 30 || m === max + 30) && sel.length < 6) asState.selected = [...sel, m];
    else if (m !== min - 30 && m !== max + 30) asState.selected = [m];
  }
  renderAsSlots(); renderAssignStages();
});
function renderAsSummary() {
  const c = state.courts.find((x) => x.id === asState.courtId);
  const range = asSelectedRange();
  const ok = c && range;
  $('#asSubmit').disabled = !ok;
  if (!ok) { $('#asSumText').textContent = 'Chọn ngày, sân và giờ bắt đầu.'; $('#asSumPrice').textContent = '0đ'; $('#asDiscountHint').hidden = true; return; }
  $('#asSumText').textContent = `${c.name} · ${fmtD(asState.date + 'T00:00:00+07:00')} · ${fmtMin(range.start)}–${fmtMin(range.end)}`;
  const knownMember = !!asState.player?.id && asState.player?.member_type === 'fixed';
  const quote = previewPrice(asState.date, range.start, range.end, knownMember ? 'fixed' : 'casual');
  $('#asSumPrice').textContent = quote ? money(quote.total) : 'Đang tải giá…';
  $('#asSubmit').disabled = !quote || !can('bookingCreate');
  $('#asDiscountHint').hidden = false;
  $('#asDiscountHint').textContent = knownMember ? 'Thành viên cố định · giá theo khung giờ' : 'Giá vãng lai dự kiến · hệ thống áp dụng giá cố định nếu SĐT khớp tài khoản cố định.';
}
// Realtime: nếu sân/ngày đang xem có người vừa giữ chỗ/đặt/hủy -> tải lại lưới giờ ngay.
function refreshAsSlotsIfSameCourt(p) { if (p.courtId === asState.courtId) loadAsBooked(); }

$('#assignForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#assignErr').textContent = '';
  const c = state.courts.find((x) => x.id === asState.courtId);
  const range = asSelectedRange();
  if (!c || !range) return ($('#assignErr').textContent = 'Vui lòng chọn ngày, sân và giờ chơi.');
  const playerName = $('#asPlayerName').value.trim();
  const playerPhone = $('#asPlayerPhone').value.trim();
  const paymentMethod = document.querySelector('#assignForm input[name="paymentMethod"]:checked')?.value || 'onsite';
  if (!playerName || !playerPhone) return ($('#assignErr').textContent = 'Vui lòng nhập tên và số điện thoại.');

  $('#asSubmit').disabled = true;
  try {
    const result = await api('/admin/bookings', { method: 'POST', body: {
      courtId: c.id,
      startsAt: toDate(asState.date, range.start).toISOString(),
      endsAt: toDate(asState.date, range.end).toISOString(),
      userId: asState.player?.id || null,
      playerName,
      playerPhone,
      paymentMethod,
    } });
    toast(`Đã gán lịch · ${money(result.totalPrice)}${result.pricing?.memberType === 'fixed' ? ' (giá cố định)' : ''}`);
    asState.selected = [];
    asState.player = null;
    e.target.reset();
    renderAssignStages();
    renderAsPlayerResults([], false);
    await loadAsBooked();
    loadAdminSchedule();
    loadAdmin();
    loadMine();
  } catch (err) {
    $('#assignErr').textContent = err.message;
    await loadAsBooked();
  } finally {
    renderAsSummary();
  }
});

// ---- autocomplete tên người chơi: chọn tên cũ -> tự điền SĐT ----
let asSearchT, asSearchVersion = 0;
function renderAsPlayerResults(rows, show = true) {
  const box = $('#asPlayerResults');
  box._rows = rows;
  if (!show) return;
  box.innerHTML = rows.length
    ? rows.map((p, i) => `<button type="button" data-as-player="${i}"><b>${esc(p.full_name)}</b><span>${esc(p.phone || 'Chưa có SĐT')}${p.member_type === 'fixed' && p.id ? ' · Giá cố định' : ''}</span></button>`).join('')
    : '<p class="pr-empty">Không tìm thấy người chơi đã từng đặt sân.</p>';
  box.hidden = false;
}
async function searchAsPlayers(q) {
  if(!can('customerLookup') || (state.user?.role==='staff' && q.trim().length<2)) { $('#asPlayerResults').hidden=true; return; }
  const version = ++asSearchVersion;
  try {
    const rows = await api('/admin/players?q=' + encodeURIComponent(q));
    if (version === asSearchVersion && $('#asPlayerName').value.trim() === q) renderAsPlayerResults(rows);
  }
  catch (err) { toast(err.message, true); }
}
$('#asPlayerName').addEventListener('input', (e) => {
  asState.player = null;
  clearTimeout(asSearchT);
  const q = e.target.value.trim();
  asSearchT = setTimeout(() => searchAsPlayers(q), 250);
});
$('#asPlayerName').addEventListener('focus', () => searchAsPlayers($('#asPlayerName').value.trim()));
$('#asPlayerPhone').addEventListener('input', () => { asState.player = null; renderAsSummary(); });
$('#asPlayerResults').addEventListener('click', (e) => {
  const b = e.target.closest('[data-as-player]'); if (!b) return;
  const p = ($('#asPlayerResults')._rows || [])[+b.dataset.asPlayer];
  if (!p) return;
  asState.player = p;
  $('#asPlayerName').value = p.full_name || '';
  $('#asPlayerPhone').value = p.phone || '';
  $('#asPlayerResults').hidden = true;
  renderAsSummary();
});
document.addEventListener('click', e => { if (!e.target.closest('.player-autocomplete')) $('#asPlayerResults').hidden = true; });

// ---- trang quản lý tài khoản người chơi: xếp hạng, tìm kiếm, phân nhóm ----
let accView = 'casual', accPage = 1, accRequest = 0, accSearchTimer, accRows = new Map(), accEditing = null;
function setAccCreateOpen(open) {
  $('#accCreatePanel').hidden = !open;
  $('#accCreateToggle').setAttribute('aria-expanded', String(open));
  if (open) $('#accForm').elements.fullName.focus();
  else { $('#accForm').reset(); $('#accErr').textContent = ''; }
}
function openAccountsDialog() {
  if (state.user?.role !== 'admin') return;
  accView = 'casual'; accPage = 1;
  document.querySelectorAll('[data-acc-view]').forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.accView === 'casual');
    tab.setAttribute('aria-selected', String(tab.dataset.accView === 'casual'));
  });
  $('#accSearch').value = '';
  $('#accActionErr').textContent = '';
  setAccCreateOpen(false);
  $('#accountsDlg').showModal();
  loadAccounts(1);
}
const accountAvatar = (u) => avatarUrl({ role: u.role, avatarKey: u.avatar_key });
async function loadAccounts(page = 1) {
  if (!$('#accountsDlg').open || state.user?.role !== 'admin') return;
  const request = ++accRequest, token = state.token;
  const query = new URLSearchParams({ view: accView, q: $('#accSearch').value.trim(), page: String(page) });
  $('#accList').innerHTML = '<p class="mute accounts-loading">Đang tải tài khoản…</p>';
  $('#accList').setAttribute('aria-busy', 'true');
  try {
    const data = await api('/admin/accounts?' + query);
    if (request !== accRequest || !$('#accountsDlg').open || token !== state.token) return;
    const lastPage = Math.max(1, Math.ceil(data.total / data.limit));
    if (page > lastPage) { loadAccounts(lastPage); return; }
    accPage = page;
    $('#accFixedCount').textContent = data.summary.fixed;
    $('#accCasualCount').textContent = data.summary.casual;
    $('#accStaffCount').textContent = data.summary.staff;
    const isStaff = accView === 'staff';
    $('#accResultCount').textContent = `${data.total} ${isStaff ? 'ca trưởng' : 'người chơi'}${query.get('q') ? ' phù hợp' : ''} · sắp theo số lượt đã chơi`;
    accRows = new Map(data.rows.map((u) => [String(u.id), u]));
    $('#accList').innerHTML = data.rows.map((u) => {
      const fixed = u.member_type === 'fixed';
      const group = isStaff ? (u.disabled_at ? 'Ca trưởng · Đã khóa' : 'Ca trưởng') : fixed ? 'Cố định · giá ưu đãi' : 'Vãng lai';
      return `<button type="button" class="account-row" data-account-id="${u.id}" aria-label="Xem thông tin ${esc(u.full_name)}, ${Number(u.recent_30_count) || 0} booking trong 30 ngày, ${group}"><span class="account-identity"><img src="${accountAvatar(u)}" alt="" width="44" height="44"><span><strong>${esc(u.full_name)}</strong><small>${esc(u.phone || 'Chưa có SĐT')}</small></span></span><span class="account-activity"><b>${Number(u.recent_30_count) || 0} booking/30 ngày</b><small class="account-badge${fixed && !isStaff ? ' fixed' : ''}">${group}</small></span><span class="account-row-chevron" aria-hidden="true">›</span></button>`;
    }).join('') || '<p class="mute accounts-loading">Chưa có tài khoản phù hợp. Thử đổi bộ lọc hoặc tạo tài khoản mới.</p>';
    $('#accPageInfo').textContent = `Trang ${page} / ${lastPage}`;
    $('#accPrev').disabled = page <= 1;
    $('#accNext').disabled = page >= lastPage;
  } catch (err) {
    if (request === accRequest && $('#accountsDlg').open && token === state.token)
      $('#accList').innerHTML = `<p class="err accounts-loading">Không tải được tài khoản: ${esc(err.message)}</p>`;
  } finally {
    if (request === accRequest) $('#accList').removeAttribute('aria-busy');
  }
}
$('#accountsClose').onclick = () => $('#accountsDlg').close();
$('#accountsDlg').addEventListener('close', () => { ++accRequest; clearTimeout(accSearchTimer); if ($('#accEditDlg').open) $('#accEditDlg').close(); });
$('#accCreateToggle').onclick = () => setAccCreateOpen($('#accCreatePanel').hidden);
$('#accCreateClose').onclick = () => setAccCreateOpen(false);
document.querySelectorAll('[data-acc-view]').forEach((button) => button.addEventListener('click', () => {
  accView = button.dataset.accView;
  document.querySelectorAll('[data-acc-view]').forEach((tab) => {
    const selected = tab === button;
    tab.classList.toggle('is-active', selected);
    tab.setAttribute('aria-selected', String(selected));
  });
  loadAccounts(1);
}));
$('#accSearch').addEventListener('input', () => {
  ++accRequest; clearTimeout(accSearchTimer);
  accSearchTimer = setTimeout(() => loadAccounts(1), 250);
});
$('#accPrev').onclick = () => loadAccounts(accPage - 1);
$('#accNext').onclick = () => loadAccounts(accPage + 1);
function updateAccountScheduleVisibility() {
  const selected = $('#accEditForm').elements.memberType.value;
  const wantsFixed = accEditing?.role === 'user' && selected === 'fixed';
  $('#accSchedulePending').hidden = !(wantsFixed && accEditing.member_type !== 'fixed');
  $('#fixedSchedulePanel').hidden = !(wantsFixed && accEditing.member_type === 'fixed');
}
$('#accEditForm').elements.memberType.addEventListener('change', updateAccountScheduleVisibility);
$('#accList').addEventListener('click', (e) => {
  const row = e.target.closest('[data-account-id]');
  if (!row || state.user?.role !== 'admin') return;
  const u = accRows.get(row.dataset.accountId);
  if (!u) return;
  accEditing = u;
  const form = $('#accEditForm');
  form.elements.id.value = u.id;
  form.elements.fullName.value = u.full_name;
  form.elements.email.value = u.email;
  form.elements.phone.value = u.phone || '';
  form.elements.memberType.value = u.member_type;
  $('#accEditTitle').textContent = u.full_name;
  $('#accEditMemberRow').hidden = u.role === 'staff';
  $('#accEditMemberNote').hidden = u.role === 'staff';
  $('#accEditErr').textContent = '';
  $('#accEditDlg').showModal();
  $('#staffAccessPanel').hidden=u.role!=='staff';
  if(u.role==='staff') loadStaffAccess(String(u.id));
  if (u.role === 'user' && u.member_type === 'fixed') openFixedSchedule(String(u.id), u.full_name);
  else { fixedScheduleUser = null; ++fixedScheduleRequest; $('#fixedSchedulePanel').hidden = true; resetScheduleEditor(); }
  updateAccountScheduleVisibility();
});
$('#accEditClose').onclick = () => $('#accEditDlg').close();
$('#accEditDlg').addEventListener('close', () => { accEditing = null; fixedScheduleUser = null; ++fixedScheduleRequest; $('#fixedSchedulePanel').hidden = true; $('#accSchedulePending').hidden = true; resetScheduleEditor(); });
$('#accEditForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target, id = form.elements.id.value;
  const previous = accEditing;
  if (!previous) return;
  const button = form.querySelector('[type="submit"]'); button.disabled = true;
  $('#accEditErr').textContent = '';
  try {
    const memberType = previous.role === 'staff' ? previous.member_type : form.elements.memberType.value;
    const updated = await api(`/admin/accounts/${id}`, { method: 'PATCH', body: {
      fullName: form.elements.fullName.value.trim(), email: form.elements.email.value.trim(),
      phone: form.elements.phone.value.trim(), memberType,
    } });
    if (!$('#accEditDlg').open || accEditing?.id !== previous.id) return;
    accEditing = { ...previous, ...updated };
    $('#accEditTitle').textContent = updated.full_name;
    if (previous.role === 'user' && memberType === 'fixed') await openFixedSchedule(id, updated.full_name);
    else { fixedScheduleUser = null; ++fixedScheduleRequest; $('#fixedSchedulePanel').hidden = true; resetScheduleEditor(); }
    updateAccountScheduleVisibility();
    toast('Đã cập nhật tài khoản');
    if (previous.role === 'user' && memberType !== accView) document.querySelector(`[data-acc-view="${memberType}"]`).click();
    else await loadAccounts(accPage);
  } catch (err) { $('#accEditErr').textContent = err.message; }
  finally { button.disabled = false; }
});
let fixedScheduleUser = null, fixedScheduleRequest = 0, fixedScheduleEditing = null, fixedScheduleRows = new Map();
const weekdayLabel = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
const minuteLabel = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
async function openFixedSchedule(id, name) {
  fixedScheduleUser = id;
  $('#fixedSchedulePanel').hidden = false;
  $('#fixedScheduleTitle').textContent = `Lịch cố định · ${name}`;
  $('#fixedScheduleErr').textContent = '';
  $('#fixedScheduleRules').innerHTML = '<p class="mute">Đang tải lịch…</p>';
  fixedScheduleRows = new Map();
  resetScheduleEditor();
  if (!state.courts.length) {
    try { state.courts = await api('/courts'); }
    catch (err) { $('#fixedScheduleErr').textContent = err.message; return; }
  }
  if (fixedScheduleUser !== id || !$('#accEditDlg').open) return;
  $('#fixedScheduleCourt').innerHTML = state.courts.filter((c) => !c.under_maintenance).map((c) => `<option value="${c.id}">${esc(c.name)} · giá theo khung giờ</option>`).join('');
  return loadFixedSchedule();
}
function resetScheduleEditor() {
  fixedScheduleEditing = null;
  $('#fixedScheduleSubmit').textContent = 'Thêm khung giờ';
  $('#fixedScheduleCancelEdit').hidden = true;
  $('#fixedScheduleForm').reset();
}
async function loadFixedSchedule() {
  if (!fixedScheduleUser) return;
  const id = fixedScheduleUser, request = ++fixedScheduleRequest;
  $('#fixedScheduleRules').innerHTML = '<p class="mute">Đang tải lịch…</p>';
  try {
    const rows = await api(`/admin/accounts/${id}/schedule`);
    if (id !== fixedScheduleUser || request !== fixedScheduleRequest) return;
    fixedScheduleRows = new Map(rows.map((r) => [String(r.id), r]));
    $('#fixedScheduleRules').innerHTML = rows.length ? rows.map((r) => `<article class="fixed-schedule-rule"><div><b>${weekdayLabel[r.weekday]} · ${minuteLabel(r.start_min)} - ${minuteLabel(r.end_min)}</b><small>${esc(r.court_name)} · ${durationText(r.end_min - r.start_min)} · giá cố định</small></div><div class="fixed-schedule-actions"><button type="button" class="ghost" data-schedule-edit="${r.id}">Sửa lịch</button><button type="button" class="ghost" data-schedule-remove="${r.id}">Ngừng lặp</button></div></article>`).join('') : '<p class="mute">Chưa có khung giờ hằng tuần. Thêm lịch ở trên.</p>';
  } catch (err) { if (request === fixedScheduleRequest) $('#fixedScheduleErr').textContent = err.message; }
}
$('#fixedScheduleCancelEdit').onclick = resetScheduleEditor;
$('#fixedScheduleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!fixedScheduleUser) return;
  const button = e.target.querySelector('[type="submit"]'); button.disabled = true;
  $('#fixedScheduleErr').textContent = '';
  try {
    const ruleId = fixedScheduleEditing;
    const result = await api(`/admin/accounts/${fixedScheduleUser}/schedule${ruleId ? '/' + ruleId : ''}`, { method: ruleId ? 'PATCH' : 'POST', body: {
      courtId: Number($('#fixedScheduleCourt').value), weekday: Number($('#fixedScheduleWeekday').value),
      start: $('#fixedScheduleStart').value, end: $('#fixedScheduleEnd').value,
    } });
    toast(`${ruleId ? 'Đã sửa' : 'Đã tạo'} lịch cố định · ${result.created} booking mới trong 30 ngày`);
    resetScheduleEditor();
    loadFixedSchedule(); loadMine(); loadAdminSchedule();
  } catch (err) { $('#fixedScheduleErr').textContent = err.message; }
  finally { button.disabled = false; }
});
$('#fixedScheduleRules').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-schedule-edit]');
  if (edit && fixedScheduleUser) {
    const rule = fixedScheduleRows.get(edit.dataset.scheduleEdit);
    if (!rule) return;
    fixedScheduleEditing = String(rule.id);
    $('#fixedScheduleCourt').value = rule.court_id;
    $('#fixedScheduleWeekday').value = rule.weekday;
    $('#fixedScheduleStart').value = minuteLabel(rule.start_min);
    $('#fixedScheduleEnd').value = minuteLabel(rule.end_min);
    $('#fixedScheduleSubmit').textContent = 'Lưu lịch';
    $('#fixedScheduleCancelEdit').hidden = false;
    $('#fixedScheduleCourt').focus({ preventScroll: true });
    $('#fixedScheduleForm').scrollIntoView({ block: 'nearest', behavior: reduce ? 'instant' : 'smooth' });
    return;
  }
  const button = e.target.closest('[data-schedule-remove]');
  if (!button || !fixedScheduleUser || !confirm('Ngừng lặp lịch này? Booking đã tạo vẫn được giữ trong lịch.')) return;
  button.disabled = true; $('#fixedScheduleErr').textContent = '';
  try { await api(`/admin/accounts/${fixedScheduleUser}/schedule/${button.dataset.scheduleRemove}`, { method: 'DELETE' }); if (fixedScheduleEditing === button.dataset.scheduleRemove) resetScheduleEditor(); loadFixedSchedule(); toast('Đã ngừng lặp lịch'); }
  catch (err) { $('#fixedScheduleErr').textContent = err.message; button.disabled = false; }
});
$('#accForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const submit = e.target.querySelector('[type="submit"]');
  submit.disabled = true;
  $('#accErr').textContent = '';
  try {
    await api('/admin/accounts', { method: 'POST', body: f });
    toast('Đã tạo tài khoản ' + (f.role === 'staff' ? 'ca trưởng' : 'người chơi'));
    setAccCreateOpen(false);
    const nextView = f.role === 'staff' ? 'staff' : 'casual';
    document.querySelector(`[data-acc-view="${nextView}"]`).click();
  } catch (err) { $('#accErr').textContent = err.message; }
  finally { submit.disabled = false; }
});

// ---------- realtime ----------
const socket = io();
socket.on('pricing:updated', data => { pricingConfig = data.config; pricingVersion = data.version; renderSummary(); renderAsSummary(); renderBkCourts(); });
socket.on('courts:snapshot', onSnapshot);
const refreshAfterChange = (p) => {
  if (p.courtId === state.bk.courtId) loadBooked();
  if (p.courtId === asState.courtId) loadAsBooked();
  if (state.user) loadMine();
  loadAdminSchedule();
  if (state.user && (state.user.role === 'admin' || state.user.role === 'staff')) loadAdmin();
};
socket.on('booking:created', refreshAfterChange);
socket.on('booking:cancelled', (p) => {
  refreshAfterChange(p);
  if (p.bookingId && String(p.bookingId) === extrasBookingId && $('#bookingExtrasDlg').open)
    reloadBookingExtras().catch(() => {});
  if (p.bookingId && String(p.bookingId) === String(historyBill?.booking?.id) && $('#historyBillDlg').open)
    openHistoryBill(p.bookingId);
});
socket.on('booking:updated', (p) => {
  refreshAfterChange(p);
  if (extrasBookingId && String(p.bookingId) === extrasBookingId)
    reloadBookingExtras().catch((e) => { $('#extrasErr').textContent = e.message; });
});
socket.on('account:membershipUpdated', async (p) => {
  if (state.user?.role === 'admin' && $('#accountsDlg').open) loadAccounts(accPage);
  if (!state.user || String(state.user.id) !== String(p.userId)) return;
  const token = state.token;
  try {
    const updated = await api('/me');
    if (state.token !== token) return;
    state.user = updated;
    renderBkCourts();
    renderSummary();
    if ($('#profileDlg').open) showProfileDetails(updated);
  } catch (err) { toast(err.message, true); }
});
// Ai đó vừa giữ chỗ / hết hạn giữ chỗ -> nếu đúng sân + ngày đang xem thì tải lại danh sách slot bận ngay
// (renderSlots sẽ tự xám các slot 'pending' của người khác với nhãn "Đang giữ").
const refreshSlotsIfSameCourt = (p) => { if (p.courtId === state.bk.courtId) loadBooked(); loadAdminSchedule().catch(() => {}); };
socket.on('slot:held', refreshSlotsIfSameCourt);
socket.on('slot:released', refreshSlotsIfSameCourt);
socket.on('slot:held', refreshAsSlotsIfSameCourt);
socket.on('slot:released', refreshAsSlotsIfSameCourt);
socket.on('admin:newBooking', onAdminNewBooking);

// ---- Bảng giá: modal cuộn tự nhiên, biểu mẫu xếp dọc trên mobile ----
const pricingTime = n => `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
const pricingOptions = (selected, first=300) => Array.from({length:(1440-first)/30+1},(_,i)=>first+i*30)
  .map(n=>`<option value="${n}" ${n===selected?'selected':''}>${pricingTime(n)}</option>`).join('');
document.querySelectorAll('[data-close-hours], #fixedScheduleEnd').forEach(el=>{
  el.innerHTML = Array.from({length:39},(_,i)=>300+i*30).map(n=>`<option value="${pricingTime(n)}" ${n===(el.id==='fixedScheduleEnd'?540:1380)?'selected':''}>${pricingTime(n)}</option>`).join('');
});
function renderPricingDraft() {
  $('#pricingGroups').innerHTML = ['weekday','weekend'].map(group=>`<section class="pricing-group"><h4>${group==='weekday'?'Thứ 2 – Thứ 6':'Cuối tuần · Lễ / Tết'}</h4><div class="pricing-colheads" aria-hidden="true"><span>Khung giờ</span><span>Vãng lai (đ/giờ)</span><span>Cố định (đ/giờ)</span></div>${pricingDraft[group].map((r,i)=>`<div class="pricing-row" data-rate-group="${group}" data-rate-index="${i}"><label class="pricing-period"><span>Khung giờ</span><div><b>${pricingTime(r.start)}</b><span>→</span>${i===pricingDraft[group].length-1?'<b>24:00</b>':`<select data-rate-end aria-label="Kết thúc khung ${i+1}, ${group==='weekday'?'ngày thường':'cuối tuần'}">${pricingOptions(r.end,r.start+30)}</select>`}</div></label><label><span>Vãng lai (đ/giờ)</span><input data-rate="casual" type="number" inputmode="numeric" min="1000" max="10000000" step="1" required value="${r.casual}"></label><label><span>Cố định (đ/giờ)</span><input data-rate="fixed" type="number" inputmode="numeric" min="1000" max="10000000" step="1" required value="${r.fixed}"></label></div>`).join('')}</section>`).join('');
  $('#pricingHolidays').innerHTML = pricingDraft.holidays.map(day=>`<button type="button" class="holiday-chip" data-remove-holiday="${day}" aria-label="Bỏ ngày lễ ${day}">${day.slice(8)}/${day.slice(5,7)}/${day.slice(2,4)} <span aria-hidden="true">×</span></button>`).join('') || '<span class="mute small">Chưa thêm ngày lễ/Tết.</span>';
  const readOnly = state.user?.role !== 'admin';
  $('#pricingForm').querySelectorAll('input,select,button').forEach(el=>el.disabled=readOnly);
  $('#pricingSave').hidden=readOnly;
}
$('#pricingOpen').onclick = async () => {
  $('#pricingErr').textContent=''; $('#pricingSaveStatus').textContent='';
  try {
    const data=await api('/pricing'); pricingConfig=data.config; pricingVersion=data.version;
    pricingDraft=JSON.parse(JSON.stringify(data.config)); pricingDraft.version=data.version;
    renderPricingDraft(); $('#pricingDlg').showModal();
  } catch(err) { toast(err.message,true); }
};
$('#pricingClose').onclick=()=>$('#pricingDlg').close();
$('#pricingGroups').addEventListener('input',e=>{
  const row=e.target.closest('[data-rate-group]'); if(!row || !e.target.dataset.rate)return;
  pricingDraft[row.dataset.rateGroup][+row.dataset.rateIndex][e.target.dataset.rate]=Number(e.target.value);
});
$('#pricingGroups').addEventListener('change',e=>{
  if(!e.target.matches('[data-rate-end]'))return;
  const row=e.target.closest('[data-rate-group]'), rows=pricingDraft[row.dataset.rateGroup], i=+row.dataset.rateIndex, end=Number(e.target.value);
  if(end<=rows[i].start || end>=rows[i+1].end) { $('#pricingErr').textContent='Mốc giờ phải nằm giữa đầu khung này và cuối khung tiếp theo.'; renderPricingDraft(); return; }
  rows[i].end=end; rows[i+1].start=end; $('#pricingErr').textContent=''; renderPricingDraft();
});
$('#pricingHolidayAdd').onclick=()=>{
  const day=$('#pricingHolidayDate').value; if(!day) { $('#pricingHolidayDate').focus(); return; }
  if(!pricingDraft.holidays.includes(day))pricingDraft.holidays.push(day);
  pricingDraft.holidays.sort(); renderPricingDraft(); $('#pricingHolidayDate').value='';
};
$('#pricingHolidays').addEventListener('click',e=>{
  const btn=e.target.closest('[data-remove-holiday]'); if(!btn)return;
  pricingDraft.holidays=pricingDraft.holidays.filter(d=>d!==btn.dataset.removeHoliday); renderPricingDraft();
});
$('#pricingForm').addEventListener('submit',async e=>{
  e.preventDefault(); $('#pricingErr').textContent=''; $('#pricingSave').disabled=true;
  try {
    const config=CourtlyPricing.validate(pricingDraft);
    const data=await api('/admin/pricing',{method:'PUT',body:{config,version:pricingDraft.version}});
    pricingConfig=data.config; pricingVersion=data.version; pricingDraft.version=data.version;
    $('#pricingSaveStatus').textContent='Đã lưu bảng giá mới'; renderSummary(); renderAsSummary(); renderBkCourts(); toast('Đã cập nhật bảng giá');
  } catch(err){$('#pricingErr').textContent=err.message;}
  finally{$('#pricingSave').disabled=false;}
});
function previewInvoiceDiscount() {
  const form=$('#extrasDiscountForm'), percent=form.elements.type.value==='percent';
  form.elements.value.max=percent?'100':String(Math.min(extrasBill?.subtotal || 0,2147483647));
  const value=Number(form.elements.value.value), subtotal=extrasBill?.subtotal || 0;
  const lines=extrasBill?[extrasBill.base,...extrasBill.addons.map(a=>a.quantity*a.unit_price)]:[];
  const discount=percent?lines.reduce((sum,gross)=>sum+Math.round(gross*value/100),0):value;
  $('#extrasDiscountPreview').textContent=Number.isSafeInteger(value)&&value>=0&&value<=Number(form.elements.value.max)
    ? `Giảm ${money(discount)} · Tổng còn ${money(Math.max(0,subtotal-discount))}${state.user?.role==='staff' && !CourtlyAccess.withinLimit(state.user,subtotal,discount)?' · Cần chủ sân duyệt':''}` : 'Nhập mức giảm hợp lệ.';
  $('#extrasDiscountPreview').hidden = value === Number(extrasBill?.booking.invoice_discount_value || 0)
    && form.elements.type.value === (extrasBill?.booking.invoice_discount_type || 'amount');
}
$('#extrasDiscountForm').addEventListener('input',previewInvoiceDiscount);
$('#extrasDiscountForm').addEventListener('submit',async e=>{
  e.preventDefault(); if(!extrasBookingId)return;
  const id=extrasBookingId, form=e.target, btn=form.querySelector('[type="submit"]'); btn.disabled=true; $('#extrasErr').textContent='';
  try{
    const result=await api(`/admin/bookings/${id}/discount`,{method:'PATCH',body:{type:form.elements.type.value,value:Number(form.elements.value.value)}});
    if(id===extrasBookingId)await reloadBookingExtras(); refreshBookingViews(); toast(result.pending ? 'Đã gửi chủ sân duyệt. Giá chưa thay đổi.' : 'Đã cập nhật giảm giá');
  }catch(err){$('#extrasErr').textContent=err.message;}
  finally{ if(id===extrasBookingId)btn.disabled=!!(extrasBill?.booking.paid || extrasBill?.addons.some(a=>a.paid)); }
});

// ---------- motion ----------
function initAmenityRail() {
  const rail = document.querySelector('.amenity-grid');
  if (!rail) return;
  rail.querySelectorAll('.amenity').forEach((card) => { card.tabIndex = 0; });
  let frame = 0;
  const updateParallax = () => {
    frame = 0;
    if (reduce) return;
    const bounds = rail.getBoundingClientRect();
    const positions = [...rail.querySelectorAll('.amenity-photo')].map((photo) => {
      const card = photo.closest('.amenity').getBoundingClientRect();
      const offset = Math.max(-1, Math.min(1, (card.left + card.width / 2 - bounds.left - bounds.width / 2) / bounds.width));
      return [photo, `${Math.round(offset * -12)}px`];
    });
    positions.forEach(([photo, offset]) => photo.style.setProperty('--parallax-x', offset));
  };
  const queueParallax = () => { if (!frame) frame = requestAnimationFrame(updateParallax); };
  rail.addEventListener('scroll', queueParallax, { passive: true });
  window.addEventListener('resize', queueParallax, { passive: true });
  queueParallax();

  let drag = null, motionFrame = 0, wheelTarget = null;
  const maxScroll = () => Math.max(0, rail.scrollWidth - rail.clientWidth);
  const clampScroll = (value) => Math.max(0, Math.min(maxScroll(), value));
  const stopMotion = () => {
    if (motionFrame) cancelAnimationFrame(motionFrame);
    motionFrame = 0;
    wheelTarget = null;
  };
  const glide = (speed) => {
    if (reduce || Math.abs(speed) < 0.12) return;
    let last = performance.now();
    const tick = (time) => {
      const dt = Math.min(40, Math.max(1, time - last));
      last = time;
      const next = clampScroll(rail.scrollLeft + speed * dt);
      if (Math.abs(next - rail.scrollLeft) < 0.1) { motionFrame = 0; return; }
      rail.scrollLeft = next;
      speed *= Math.pow(0.91, dt / 16);
      motionFrame = Math.abs(speed) < 0.025 ? 0 : requestAnimationFrame(tick);
    };
    motionFrame = requestAnimationFrame(tick);
  };
  rail.addEventListener('pointerdown', (e) => {
    stopMotion();
    if (e.pointerType !== 'mouse') {
      drag = null;
      return;
    }
    if (e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, left: rail.scrollLeft, moved: false,
      samples: [{ time: performance.now(), left: rail.scrollLeft }] };
  });
  rail.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      rail.classList.add('is-dragging');
      rail.setPointerCapture(e.pointerId);
    }
    rail.scrollLeft = clampScroll(drag.left - dx);
    const time = performance.now();
    drag.samples.push({ time, left: rail.scrollLeft });
    while (drag.samples.length > 2 && time - drag.samples[0].time > 90) drag.samples.shift();
  });
  const finishDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const finished = drag;
    drag = null;
    if (rail.hasPointerCapture(e.pointerId)) rail.releasePointerCapture(e.pointerId);
    rail.classList.remove('is-dragging');
    if (e.type !== 'pointerup' || !finished.moved) return;
    const samples = finished.samples, first = samples[0], last = samples[samples.length - 1];
    if (performance.now() - last.time > 100) return;
    const speed = (last.left - first.left) / Math.max(1, last.time - first.time);
    glide(Math.max(-2.8, Math.min(2.8, speed)));
  };
  rail.addEventListener('pointerup', finishDrag);
  rail.addEventListener('pointercancel', finishDrag);
  rail.addEventListener('lostpointercapture', finishDrag);
  rail.addEventListener('wheel', (e) => {
    if (!matchMedia('(hover:hover) and (pointer:fine)').matches) return;
    const delta = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rail.clientWidth : 1);
    if (!delta) return;
    const next = clampScroll((wheelTarget ?? rail.scrollLeft) + delta);
    if (Math.abs(next - rail.scrollLeft) < 0.5 && wheelTarget === null) return;
    e.preventDefault();
    if (reduce) { stopMotion(); rail.scrollLeft = next; return; }
    if (wheelTarget === null) stopMotion();
    wheelTarget = next;
    if (motionFrame) return;
    let last = performance.now();
    const tick = (time) => {
      const dt = Math.min(40, Math.max(1, time - last));
      last = time;
      const diff = wheelTarget - rail.scrollLeft;
      if (Math.abs(diff) < 0.5) { rail.scrollLeft = wheelTarget; wheelTarget = null; motionFrame = 0; return; }
      rail.scrollLeft = clampScroll(rail.scrollLeft + diff * (1 - Math.exp(-dt / 65)));
      motionFrame = requestAnimationFrame(tick);
    };
    motionFrame = requestAnimationFrame(tick);
  }, { passive: false });
  rail.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    stopMotion();
    rail.scrollBy({ left: (e.key === 'ArrowRight' ? 1 : -1) * rail.querySelector('.amenity').getBoundingClientRect().width, behavior: reduce ? 'instant' : 'smooth' });
  });
}
function initTodayRail() {
  const rail = $('#upcoming');
  if (!rail) return;
  let drag = null, motionFrame = 0, wheelTarget = null, suppressClick = false;
  const clamp = (value) => Math.max(0, Math.min(Math.max(0, rail.scrollHeight - rail.clientHeight), value));
  const stop = () => { if (motionFrame) cancelAnimationFrame(motionFrame); motionFrame = 0; wheelTarget = null; };
  const glide = (velocity) => {
    if (reduce || Math.abs(velocity) < .12) return;
    let previous = performance.now();
    const tick = (time) => {
      const dt = Math.min(40, Math.max(1, time - previous)); previous = time;
      const next = clamp(rail.scrollTop + velocity * dt);
      if (Math.abs(next - rail.scrollTop) < .1) { motionFrame = 0; return; }
      rail.scrollTop = next;
      velocity *= Math.pow(.91, dt / 16);
      motionFrame = Math.abs(velocity) < .025 ? 0 : requestAnimationFrame(tick);
    };
    motionFrame = requestAnimationFrame(tick);
  };
  rail.addEventListener('pointerdown', (event) => {
    stop();
    if (event.pointerType !== 'mouse' || event.button !== 0 || !rail.classList.contains('has-more')) return;
    drag = { id: event.pointerId, y: event.clientY, top: rail.scrollTop, moved: false,
      samples: [{ time: performance.now(), top: rail.scrollTop }] };
  });
  rail.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) < 6) return;
    if (!drag.moved) { drag.moved = true; rail.classList.add('is-dragging'); rail.setPointerCapture(event.pointerId); }
    rail.scrollTop = clamp(drag.top - dy);
    const time = performance.now();
    drag.samples.push({ time, top: rail.scrollTop });
    while (drag.samples.length > 2 && time - drag.samples[0].time > 90) drag.samples.shift();
  });
  const finish = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const done = drag; drag = null;
    if (rail.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId);
    rail.classList.remove('is-dragging');
    if (event.type !== 'pointerup' || !done.moved) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    const first = done.samples[0], last = done.samples[done.samples.length - 1];
    if (performance.now() - last.time <= 100)
      glide(Math.max(-2.8, Math.min(2.8, (last.top - first.top) / Math.max(1, last.time - first.time))));
  };
  rail.addEventListener('pointerup', finish);
  rail.addEventListener('pointercancel', finish);
  rail.addEventListener('lostpointercapture', finish);
  rail.addEventListener('click', (event) => { if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  rail.addEventListener('wheel', (event) => {
    if (!rail.classList.contains('has-more') || !matchMedia('(hover:hover) and (pointer:fine)').matches) return;
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rail.clientHeight : 1);
    const next = clamp((wheelTarget ?? rail.scrollTop) + delta);
    if (Math.abs(next - rail.scrollTop) < .5 && wheelTarget === null) return;
    event.preventDefault();
    if (reduce) { stop(); rail.scrollTop = next; return; }
    if (wheelTarget === null) stop();
    wheelTarget = next;
    if (motionFrame) return;
    let previous = performance.now();
    const tick = (time) => {
      const dt = Math.min(40, Math.max(1, time - previous)); previous = time;
      const diff = wheelTarget - rail.scrollTop;
      if (Math.abs(diff) < .5) { rail.scrollTop = wheelTarget; wheelTarget = null; motionFrame = 0; return; }
      rail.scrollTop = clamp(rail.scrollTop + diff * (1 - Math.exp(-dt / 65)));
      motionFrame = requestAnimationFrame(tick);
    };
    motionFrame = requestAnimationFrame(tick);
  }, { passive: false });
  rail.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(event.key)) return;
    if (!rail.classList.contains('has-more')) return;
    event.preventDefault(); stop();
    rail.scrollBy({ top: (event.key.endsWith('Down') ? 1 : -1) * (event.key.startsWith('Page') ? rail.clientHeight : 96), behavior: reduce ? 'instant' : 'smooth' });
  });
}
function initMotion() {
  if (!motion) return;
  gsap.registerPlugin(ScrollTrigger);
  if (typeof Lenis !== 'undefined') {
    lenis = new Lenis({
      // Dialog nằm ở top layer: luôn để trình duyệt xử lý cuộn trong popup.
      prevent: (node) => !!node?.closest?.('dialog[open], #scheduleViewport, #upcoming, .amenity-grid'),
    });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add((t) => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
  }
  gsap.timeline({ defaults: { ease: 'power4.out' } })
    .from('.hero-carousel', { scale: 1.15, opacity: 0, duration: 1.6 }, 0)
    .from('.hero h1 .ln span', { yPercent: 110, duration: 1.1, stagger: .12 }, .2)
    .from('.fade', { y: 24, opacity: 0, duration: .8, stagger: .1 }, .7);
  gsap.to('[data-parallax]', { yPercent: -12, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
  if (matchMedia('(hover:hover)').matches) {
    document.querySelectorAll('[data-magnetic]').forEach((el) => {
      const x = gsap.quickTo(el, 'x', { duration: .4, ease: 'power3' }), y = gsap.quickTo(el, 'y', { duration: .4, ease: 'power3' });
      el.addEventListener('mousemove', (e) => { const r = el.getBoundingClientRect(); x((e.clientX - r.left - r.width / 2) * .3); y((e.clientY - r.top - r.height / 2) * .3); });
      el.addEventListener('mouseleave', () => { x(0); y(0); });
    });
  }
}
// ---------- boot ----------
(async function boot() {
  initAmenityRail();
  initTodayRail();
  initMotion();
  renderDates();
  try { const data = await api('/pricing'); pricingConfig = data.config; pricingVersion = data.version; }
  catch { toast('Không tải được bảng giá. Vui lòng tải lại trang.', true); }
  if (state.token) {
    try { state.user = await api('/me'); }
    catch { state.token = null; localStorage.removeItem('token'); }
  }
  afterAuth();
})();
