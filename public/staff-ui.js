// Staff configuration is stored on the account. All writes are independently checked by the server.
function operationReason(title, hint='Thao tác và lý do sẽ được lưu trong nhật ký.') {
  if ($('#operationReasonDlg').open) return Promise.resolve(null);
  return new Promise(resolve => {
    const dlg=$('#operationReasonDlg'),form=$('#operationReasonForm');
    $('#operationReasonTitle').textContent=title; $('#operationReasonHint').textContent=hint;
    form.reset(); let value=null;
    form.onsubmit=e=>{e.preventDefault();value=$('#operationReasonText').value.trim();if(value.length>=3)dlg.close();};
    $('#operationReasonBack').onclick=()=>dlg.close();
    dlg.addEventListener('close',()=>resolve(value),{once:true});dlg.showModal();$('#operationReasonText').focus();
  });
}
function applyStaffUI() {
  const owner=state.user?.role==='admin',staff=state.user?.role==='staff';
  document.body.classList.toggle('staff-no-create',staff&&!can('bookingCreate'));
  $('#staffOperationsOpen').hidden=!owner; $('#customerExport').hidden=!can('customerExport');
  $('#staffRoleNote').hidden=!staff;
  if(staff) $('#staffRoleNote').textContent='Ca trưởng · Quyền thao tác do chủ sân cấp cho tài khoản của bạn.';
  $('#mine').hidden=$('#nav-mine').hidden=!state.user || (staff && !can('bookingView'));
  $('#admin').hidden=$('#nav-admin').hidden=!(owner || (staff && (can('bookingView')||can('revenueView')||can('customerExport'))));
  $('.rev-panel').hidden=$('#revenueHeading').hidden=!can('revenueView');
  $('#revRangeToggle').disabled=staff;
  if(staff) setRevenueCalendar(false);
  $('.court-list-head').hidden=$('#courtList').hidden=$('.pricing-entry').hidden=!owner;
  if(!owner) $('#courtForm').hidden=true;
  $('#stats').hidden=staff && !can('bookingView');
  $('#bookingTitle').textContent=staff&&!can('bookingCreate')?'Lịch sân':'Đặt sân';
  $('#asSummary').hidden=staff&&!can('bookingCreate');
}
let staffAccessId=null,staffAccessVersion=null;
async function loadStaffAccess(id) {
  staffAccessId=id;staffAccessVersion=null;
  $('#staffAccessPanel').hidden=false;$('#staffAccessFields').disabled=true;
  $('#staffAccessErr').textContent='Đang tải quyền…';
  try {
    const data=await api(`/admin/staff/${id}/access`);
    if(staffAccessId!==id || !$('#accEditDlg').open)return;
    staffAccessVersion=data.version;
    $('#staffPermissionList').innerHTML=Object.entries(CourtlyAccess.catalog).map(([key,[label]])=>`<label class="permission-row"><input type="checkbox" name="${key}" ${data.permissions[key]?'checked':''}><span>${esc(label)}</span></label>`).join('');
    const f=$('#staffAccessForm');f.elements.maxPercent.value=data.maxPercent;f.elements.maxAmount.value=data.maxAmount;
    f.elements.disabled.checked=data.disabled;f.elements.reason.value='';
    $('#staffAccessFields').disabled=false;$('#staffAccessErr').textContent='';
  }catch(e){$('#staffAccessErr').textContent=e.message;}
}
$('#staffAccessForm').onsubmit=async e=>{
  e.preventDefault();if(staffAccessVersion===null)return;
  const f=e.target,id=staffAccessId,btn=f.querySelector('[type=submit]');btn.disabled=true;$('#staffAccessErr').textContent='';
  try {
    const data=await api(`/admin/staff/${id}/access`,{method:'PATCH',body:{
      permissions:Object.fromEntries(Object.keys(CourtlyAccess.catalog).map(k=>[k,f.elements[k].checked])),
      maxPercent:Number(f.elements.maxPercent.value),maxAmount:Number(f.elements.maxAmount.value),
      disabled:f.elements.disabled.checked,version:staffAccessVersion,reason:f.elements.reason.value,
    }});
    if(staffAccessId!==id)return;
    staffAccessVersion=data.version;f.elements.reason.value='';toast('Đã lưu quyền. Các phiên cũ của ca trưởng đã kết thúc.');loadAccounts(accPage);
  }catch(e){$('#staffAccessErr').textContent=e.message;}finally{btn.disabled=false;}
};
$('#accEditDlg').addEventListener('close',()=>{staffAccessId=null;staffAccessVersion=null;$('#staffAccessPanel').hidden=true;});
$('#customerExport').onclick=async()=>{
  try {
    const response=await fetch('/api/admin/customers/export',{headers:{Authorization:'Bearer '+state.token}});
    if(!response.ok)throw new Error((await response.json()).error);
    const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');a.href=url;a.download='courtly-khach-hang.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(e){toast(e.message,true);}
};
let operationsView='requests',auditPage=1,operationsSequence=0;
const auditLabels={'booking.create':'Tạo booking','booking.edit':'Đổi sân / giờ','booking.cancel':'Hủy booking','booking.extend':'Gia hạn',
  'payment.court':'Thu tiền sân','payment.service':'Thu tiền dịch vụ','payment.settle':'Thu toàn bộ hóa đơn','service.add':'Thêm dịch vụ','service.remove':'Xóa dịch vụ',
  'discount.change':'Điều chỉnh giảm giá','discount.request':'Gửi yêu cầu giảm giá','discount.approve':'Duyệt giảm giá','discount.reject':'Từ chối giảm giá','staff.access':'Thay đổi quyền ca trưởng','customer.export':'Xuất danh sách khách'};
function auditSummary(data) {
  if(!data)return 'Chưa có';
  if(data.permissions)return Object.entries(data.permissions).map(([k,v])=>`${CourtlyAccess.catalog[k]?.[0] || k}: ${v?'Bật':'Tắt'}`).join(' · ')+` · Hạn mức ${data.maxPercent}% / ${money(data.maxAmount)} · ${data.disabled?'Đã khóa':'Hoạt động'}`;
  const b=data.booking || data;
  if(b.starts_at)return `Sân #${b.court_id} · ${playTimeText(b)} · ${money(b.total_price)} · ${b.status==='cancelled'?'Đã hủy':'Đã xác nhận'} · Tiền sân ${b.paid?'đã thu':'chưa thu'} · Giảm ${b.invoice_discount_value || 0}${b.invoice_discount_type==='percent'?'%':'đ'}`+(data.addons?.length?' · '+data.addons.map(a=>`${a.label} × ${a.quantity}: ${money(a.quantity*a.unit_price)} (${a.paid?'đã thu':'chưa thu'})`).join(' · '):'');
  if(data.requestId)return `Yêu cầu #${data.requestId} · Giảm ${money(data.amount)}`;
  if(data.count!==undefined)return `${data.count} khách hàng`;
  return 'Đã ghi nhận';
}
async function loadOperations() {
  const sequence=++operationsSequence;
  $('#operationsTitle').textContent=operationsView==='audit'?'Nhật ký thao tác':'Yêu cầu giảm giá';
  $('#operationsContent').innerHTML='<p class="mute">Đang tải…</p>';$('#operationsErr').textContent='';$('#auditPages').hidden=operationsView!=='audit';
  try {
    const data=await api(operationsView==='audit'?`/admin/audit?page=${auditPage}`:'/admin/discount-requests');
    if(sequence!==operationsSequence || !$('#operationsDlg').open)return;
    if(operationsView==='audit'){
      $('#auditPage').textContent=`Trang ${auditPage}`;$('#auditPrev').disabled=auditPage===1;$('#auditNext').disabled=data.rows.length<30;
      $('#operationsContent').innerHTML=data.rows.map(r=>`<details class="operation-card"><summary><strong>${esc(auditLabels[r.action]||'Thao tác hệ thống')}${r.entity_id?' · #'+r.entity_id:''}</strong><small>${esc(r.actor_name)} · ${historyDateTime(r.created_at)}</small></summary><p>${esc(r.reason || 'Không yêu cầu lý do')}</p><div class="audit-comparison"><div><small>Trước</small><p>${esc(auditSummary(r.before_data))}</p></div><div><small>Sau</small><p>${esc(auditSummary(r.after_data))}</p></div></div></details>`).join('')||'<p class="mute">Chưa có thao tác được ghi nhận.</p>';
    }else{
      $('#operationsContent').innerHTML=data.map(r=>`<article class="operation-card"><span class="eyebrow">BOOKING #${r.booking_id}</span><h4>${esc(r.court_name)} · ${esc(r.player_name)}</h4><p class="request-value">Giảm ${r.discount_type==='percent'?r.discount_value+'%':money(r.discount_value)}</p><p>${esc(r.reason)}</p><p class="mute small">${esc(r.requester)} · ${historyDateTime(r.created_at)}</p><div class="access-actions"><button type="button" class="ghost" data-review="${r.id}" data-approve="false">Từ chối</button><button type="button" class="btn" data-review="${r.id}" data-approve="true">Duyệt giảm giá</button></div></article>`).join('')||'<p class="mute">Không có yêu cầu chờ duyệt.</p>';
    }
  }catch(e){$('#operationsErr').textContent=e.message;$('#operationsContent').innerHTML='';}
}
$('#staffOperationsOpen').onclick=()=>{operationsView='requests';auditPage=1;$('#operationsDlg').showModal();loadOperations();};
$('#operationsClose').onclick=()=>$('#operationsDlg').close();
document.querySelectorAll('[data-operation-view]').forEach(b=>b.onclick=()=>{operationsView=b.dataset.operationView;loadOperations();});
$('#auditPrev').onclick=()=>{auditPage--;loadOperations();};$('#auditNext').onclick=()=>{auditPage++;loadOperations();};
$('#operationsContent').onclick=async e=>{
  const button=e.target.closest('[data-review]');if(!button)return;
  const approve=button.dataset.approve==='true',why=await operationReason(approve?'Duyệt giảm giá':'Từ chối giảm giá');if(!why)return;
  button.disabled=true;
  try{await api(`/admin/discount-requests/${button.dataset.review}/review`,{method:'POST',body:{approve,reason:why}});await loadOperations();refreshBookingViews();toast(approve?'Đã duyệt và áp dụng giảm giá':'Đã từ chối yêu cầu');}
  catch(err){$('#operationsErr').textContent=err.message;button.disabled=false;}
};
function renderBookingEdit(b,bill) {
  const section=$('#bookingEditSection'),f=$('#bookingEditForm');
  section.hidden=!can('bookingEdit') || b.status!=='confirmed' || b.paid || bill.addons.some(a=>a.paid || a.kind==='extra_time');
  f.elements.courtId.innerHTML=state.courts.map(c=>`<option value="${c.id}" ${String(c.id)===String(b.court_id)?'selected':''}>${esc(c.name)}</option>`).join('');
  f.elements.date.value=vnDayOf(b.starts_at);f.elements.date.min=todayStr();f.elements.date.max=addDays(todayStr(),29);
  f.elements.start.value=fmtMin(vnMin(b.starts_at));f.elements.end.value=vnMin(b.ends_at)===0?'24:00':fmtMin(vnMin(b.ends_at));
}
$('#bookingEditForm').onsubmit=async e=>{
  e.preventDefault();const f=e.target,btn=f.querySelector('[type=submit]');btn.disabled=true;
  try{
    const day=f.elements.date.value;
    await api(`/admin/bookings/${extrasBookingId}/details`,{method:'PATCH',body:{courtId:Number(f.elements.courtId.value),startsAt:toDate(day,hm(f.elements.start.value)).toISOString(),endsAt:toDate(day,hm(f.elements.end.value)).toISOString()}});
    await reloadBookingExtras();refreshBookingViews();toast('Đã đổi sân / giờ và tính lại giá theo bảng giá hiện tại');
  }catch(err){$('#extrasErr').textContent=err.message;}finally{btn.disabled=false;}
};
socket.on('session:changed',p=>{if(String(p.userId)===String(state.user?.id)){logout();toast('Quyền tài khoản đã thay đổi. Vui lòng đăng nhập lại.',true);}});
// Reconnection and tab wakeup revalidate sessions even when a live notification was missed.
async function revalidateSession(){if(!state.token)return;try{const token=state.token,u=await api('/me');if(state.token===token){state.user=u;applyStaffUI();}}catch(e){if(e.status===401&&state.token)logout();}}
socket.on('connect',revalidateSession);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)revalidateSession();});
applyStaffUI();
