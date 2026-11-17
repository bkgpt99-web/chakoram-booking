import {$,esc,money,today,plusDays,dateLabel,api,message,busy} from './common.js';
import {createOwnerAlerts} from './owner-alerts.js';
let data,session,detailId,manualDraft,dayDate;
let refreshVersion=0;
const alerts=createOwnerAlerts({openBooking:openDetail,onChange:refresh,onError:handleError,onCount:n=>{$('stat-sync').textContent=n;$('alerts-count').textContent=n;$('alerts-count').hidden=!n;}});
const formValues=id=>Object.fromEntries(new FormData($(id)));
const guestCount=b=>b.guests==null?'Guest count not entered':`${b.guests} guests`;
const status=b=>b.status==='held'&&new Date(b.expires_at)<new Date()?'expired':b.status;
const badge=b=>`<span class="badge ${status(b)==='payment_review'?'red':status(b)==='held'?'warn':''}">${esc(status(b).replaceAll('_',' '))}</span>`;
function showTab(name){
 document.querySelectorAll('[data-tab]').forEach(b=>{b.classList.toggle('active',b.dataset.tab===name);b.setAttribute('aria-current',b.dataset.tab===name?'page':'false');});
 document.querySelectorAll('.tab-panel').forEach(p=>p.hidden=p.id!==`tab-${name}`);
 document.body.classList.toggle('calendar-screen',name==='calendar'&&!$('workspace').hidden);
 if(name==='calendar')requestAnimationFrame(()=>{if(data)renderCalendar();});
}
async function refresh(){
 const version=++refreshVersion,month=$('calendar-start').value;
 $('calendar').setAttribute('aria-busy','true');
 try{
  const next=await api(`/admin/dashboard?month=${month}-01`);
  if(version!==refreshVersion)return;
  data=next;render();if($('day-dialog').open)openDay(dayDate);await alerts.refresh();
 }catch(err){if(version===refreshVersion)handleError(err);}
 finally{if(version===refreshVersion)$('calendar').removeAttribute('aria-busy');}
}
function handleError(err){message('admin-message',err.message,'error');if(err.status===401){alerts.stop();document.body.classList.remove('calendar-screen','owner-desk');$('workspace').hidden=true;$('login-panel').hidden=false;$('logout').hidden=true;}}
async function start(){try{session=await api('/admin/session');$('workspace').hidden=false;$('login-panel').hidden=true;$('logout').hidden=false;$('signed-in').textContent=session.email;$('demo-banner').hidden=!session.demo;document.body.classList.add('owner-desk');showTab('calendar');await refresh();await alerts.start();const booking=new URL(location.href).searchParams.get('booking');if(booking)await openDetail(booking);}catch(err){if(err.status!==401)handleError(err);}}
function render(){const confirmed=data.bookings.filter(b=>b.status==='confirmed');$('stat-arrivals').textContent=confirmed.filter(b=>b.check_in===today()).length;$('stat-upcoming').textContent=confirmed.filter(b=>b.check_out>today()).length;$('stat-sync').textContent=data.bookings.filter(b=>!b.synced_to_cm&&['confirmed','cancelled','payment_review'].includes(b.status)).length;$('stat-review').textContent=data.bookings.filter(b=>b.attention).length;
 const open=data.settings.booking_open&&data.settings.policy_reviewed&&session.checkout_ready;$('sale-status').textContent=open?session.payment_mode==='live'?'Online bookings open':'Test bookings open':'Online bookings paused';$('sale-status').className=`badge ${open?'':'warn'}`;
 renderCalendar();renderBookings();renderSettings();}
function calendarState(n){return n?.booking?(n.booking.status==='held'?'held':'booked'):n?.is_open?'open':'closed';}
function renderCalendar(){
 const first=data.month_start,month=first.slice(0,7),start=new Date(`${first}T12:00:00Z`);
 const count=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,0)).getUTCDate();
 const leading=start.getUTCDay(),weeks=Math.ceil((leading+count)/7),grid=$('calendar');
 $('calendar-heading').textContent=start.toLocaleDateString('en-IN',{month:'long',year:'numeric',timeZone:'UTC'});
 const filter=$('calendar-room');
 if(filter.options.length!==data.rooms.length+1){
  const chosen=filter.value;
  filter.innerHTML='<option value="all">All rooms</option>'+data.rooms.map(r=>`<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  filter.value=data.rooms.some(r=>r.id===chosen)?chosen:'all';
 }
 const rooms=data.rooms.filter(r=>filter.value==='all'||r.id===filter.value);
 const cells=new Map(data.calendar.map(n=>[`${n.room_id}/${n.date}`,n]));
 grid.style.setProperty('--weeks',weeks);
 const css=getComputedStyle(grid),num=v=>parseFloat(css.getPropertyValue(v))||0;
 const cellHeight=(grid.clientHeight-(weeks-1)*(parseFloat(css.rowGap)||0))/weeks;
 const dotHeight=num('--dot-height');
 const nameSpace=Math.max(0,cellHeight-2*num('--day-padding')-2-num('--day-head')-dotHeight-2*num('--day-gap'));
 const lineHeight=num('--entry-height'),maxLines=Math.floor(nameSpace/lineHeight);
 const focused=grid.contains(document.activeElement)?document.activeElement.dataset.date:null;
 const blanks=n=>'<div class="month-empty" aria-hidden="true"></div>'.repeat(n);
 grid.innerHTML=blanks(leading)+Array.from({length:count},(_,i)=>{
  const date=`${month}-${String(i+1).padStart(2,'0')}`;
  const nights=rooms.map(r=>({room:r,night:cells.get(`${r.id}/${date}`)}));
  const open=nights.filter(n=>calendarState(n.night)==='open').length;
  const guests=new Map();
  for(const {room,night}of nights)if(night?.booking){
   const b=night.booking;
   if(!guests.has(b.id))guests.set(b.id,{...b,rooms:[]});
   guests.get(b.id).rooms.push(room.id);
  }
  const entries=[...guests.values()];
  const limit=maxLines;
  const shown=entries.slice(0,limit),more=entries.length-shown.length;
  const label=`${dateLabel(date)}. ${open} of ${rooms.length} rooms open. ${entries.length?entries.map(b=>`${b.guest_name}, ${b.rooms.join(', ')}${b.status==='held'?', payment hold':''}`).join('; ')+'. ':''}View rooms and bookings.`;
  return `<button type="button" class="month-day ${date===today()?'is-today':''}" data-date="${date}" aria-label="${esc(label)}" ${date===today()?'aria-current="date"':''}>
   <span class="day-top"><span class="day-number">${i+1}</span><span class="day-summary"><span class="day-open">${open?`${open} open`:entries.length?'':'Closed'}</span>${more?`<span class="day-extra" title="${more} ${shown.length?'more bookings':'bookings'}">${shown.length?'+':''}${more}</span>`:''}</span></span>
   <span class="day-bookings">${shown.map(b=>`<span class="day-guest ${b.status==='held'?'is-held':''}"><span class="day-room-code">${esc(b.rooms.join(', '))}</span><span class="day-guest-name">${esc(b.guest_name)}</span></span>`).join('')}</span>
   <span class="room-dots" aria-hidden="true">${nights.map(({room,night})=>`<i class="${calendarState(night)}" title="${esc(`${room.name}: ${night?.booking?.guest_name||calendarState(night)}`)}"></i>`).join('')}</span>
  </button>`;
 }).join('')+blanks(weeks*7-leading-count);
 if(focused)grid.querySelector(`[data-date="${focused}"]`)?.focus({preventScroll:true});
 if(!$('room-checks').children.length)$('room-checks').innerHTML=data.rooms.map(r=>`<label><input type="checkbox" name="room_id" value="${esc(r.id)}" checked>${esc(r.name)}</label>`).join('');
}
function openDay(date){
 dayDate=date;
 $('day-title').textContent=new Date(`${date}T12:00:00Z`).toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'UTC'});
 $('day-rooms').innerHTML=data.rooms.map(r=>{
  const n=data.calendar.find(n=>n.room_id===r.id&&n.date===date),state=calendarState(n),b=n?.booking;
  return `<article class="day-room"><div><strong>${esc(r.name)}</strong><p>${b?esc(b.guest_name):`<span class="room-status ${state}">${state==='open'?'Open':'Closed'}</span>`}</p>${b?.status==='held'?'<p class="small muted">Payment hold</p>':''}${!b&&n?.note?`<p class="muted">${esc(n.note)}</p>`:''}</div><div class="row">${b?`<button class="button secondary small" data-day-booking="${esc(b.id)}">View booking</button>`:`<button class="button small" data-day-add="${esc(r.id)}">Add booking</button>${date>=today()?`<button class="button secondary small" data-day-availability="${esc(r.id)}">${state==='open'?'Close night':'Open night'}</button>`:''}`}</div></article>`;
 }).join('');
 if(!$('day-dialog').open)$('day-dialog').showModal();
}
function openInventory(date,roomId){
 const form=$('inventory-form');
 if(date){
  form.elements.start.value=date;form.elements.end.value=date;
  const current=data.calendar.find(n=>n.room_id===roomId&&n.date===date);
  form.elements.is_open.value=String(!current?.is_open);form.elements.note.value=current?.note||'';
  form.querySelectorAll('[name=room_id]').forEach(c=>c.checked=c.value===roomId);
 }
 message('inventory-message','');$('inventory-dialog').showModal();
}
function renderBookings(){const query=$('booking-search').value.toLowerCase(),filter=$('booking-filter').value;const bookings=data.bookings.filter(b=>`${b.guest_name} ${b.reference} ${b.phone} ${b.source}`.toLowerCase().includes(query)&&(filter==='all'||(filter==='unsynced'?!b.synced_to_cm&&['confirmed','cancelled','payment_review'].includes(b.status):status(b)===filter)));
 $('booking-list').innerHTML=bookings.length?bookings.map(b=>`<article class="reservation"><div><div class="row"><h3>${esc(b.guest_name)}</h3>${badge(b)}${!b.synced_to_cm&&['confirmed','cancelled','payment_review'].includes(b.status)?'<span class="badge warn">Update CM</span>':''}</div><p>${dateLabel(b.check_in)} – ${dateLabel(b.check_out)} · ${esc(b.room_ids.join(', '))} · ${guestCount(b)}</p><span class="meta">${esc(b.reference)} · ${esc(b.source)}</span>${b.attention?`<p class="attention">${esc(b.attention)}</p>`:''}</div><div><div class="money">${money(b.total_paise)}</div>${b.owner_entry?'<p>Reference tariff</p>':''}<p>Paid ${money(b.paid_paise)}</p><button class="button secondary small" data-detail="${b.id}">View reservation</button></div></article>`).join(''):'<div class="empty-state">No reservations match this view.</div>';}
function renderSettings(){const form=$('settings-form');if(!form.contains(document.activeElement)){form.elements.booking_open.value=String(data.settings.booking_open);form.elements.deposit_percent.value=String(data.settings.deposit_percent);form.elements.cancellation_policy.value=data.settings.cancellation_policy;form.elements.policy_reviewed.checked=data.settings.policy_reviewed;$('base-rates').innerHTML=data.room_types.map(r=>`<label>${esc(r.name)} · base price (₹)<input type="number" name="rate_${r.id}" min="100" max="1000000" step="0.01" value="${r.rate_paise/100}" required></label><label>${esc(r.name)} · max guests<input type="number" name="guests_${r.id}" min="1" max="6" value="${r.max_guests}" required></label>`).join('');}
 $('seasonal-rates').innerHTML=`<strong>Overrides in the displayed calendar period</strong><br>${data.rates.length?data.rates.map(r=>`${dateLabel(r.stay_date)} · ${esc(r.room_type)} · ${money(r.rate_paise)}`).join('<br>'):'No overrides. Base rates apply.'}`;}
async function openDetail(id){detailId=id;let b;try{b=await api(`/admin/booking?id=${encodeURIComponent(id)}`);if(detailId!==id)return;const index=data.bookings.findIndex(item=>item.id===id);if(index<0)data.bookings.push(b);else data.bookings[index]=b;}catch(err){handleError(err);return;}message('detail-message','');$('booking-detail').innerHTML=`<h2>${esc(b.guest_name)}</h2><div class="row">${badge(b)}<span class="small muted">${esc(b.reference)}</span></div><table class="confirmation-table"><tr><td>Stay</td><td>${dateLabel(b.check_in)} – ${dateLabel(b.check_out)}</td></tr><tr><td>Rooms</td><td>${esc(b.room_ids.join(', '))}</td></tr><tr><td>Guests</td><td>${b.guests??'Not entered'}</td></tr><tr><td>Source</td><td>${esc(b.source)}</td></tr><tr><td>Contact</td><td>${esc(b.phone||'Not entered')}<br>${esc(b.email||'')}</td></tr><tr><td>${b.owner_entry?'Reference tariff / paid / refunded':'Total / paid / refunded'}</td><td>${money(b.total_paise)} / ${money(b.paid_paise)} / ${money(b.refunded_paise)}</td></tr><tr><td>Payment reference</td><td>${esc(b.payment_id||'No online payment')}</td></tr><tr><td>CM updated</td><td>${b.synced_to_cm?'Yes':'No'}</td></tr></table>${b.guest_note?`<p class="detail-note">${esc(b.guest_note)}</p>`:''}${b.attention?`<div class="notice error">${esc(b.attention)}</div>`:''}<details class="policy-details"><summary>${b.owner_entry?'Website policy for reference':'Agreed cancellation policy'}</summary><p>${esc(b.policy)}</p></details><div class="booking-detail-actions">${status(b)==='confirmed'?'<button class="button" id="edit-reservation">Edit booking details</button>':''}<button class="button" id="mark-sync">${b.synced_to_cm?'Mark CM update needed':'Mark CM updated'}</button>${b.order_id?'<button class="button secondary" id="reconcile">Recheck payment</button>':''}${['confirmed','held','payment_review'].includes(status(b))?'<button class="button secondary" id="cancel-reservation">Cancel reservation</button>':''}${b.phone?`<a class="button secondary" href="https://wa.me/${esc(b.phone.replace(/\D/g,''))}?text=${encodeURIComponent(`Hello ${b.guest_name}, regarding your Chakoram reservation ${b.reference}.`)}" target="_blank" rel="noopener">WhatsApp guest</a>`:''}</div>`;
 if($('edit-reservation'))$('edit-reservation').onclick=()=>{$('detail-dialog').close();openManual(b);};
 $('mark-sync').onclick=()=>detailAction('/admin/sync',{id,synced:!b.synced_to_cm,revision:b.cm_revision});if($('reconcile'))$('reconcile').onclick=()=>detailAction('/admin/reconcile',{id});if($('cancel-reservation'))$('cancel-reservation').onclick=()=>$('cancel-dialog').showModal();if(!$('detail-dialog').open)$('detail-dialog').showModal();}
async function detailAction(path,body){try{await api(path,body);if(path==='/admin/sync'&&body.synced)await alerts.closeNotifications(body.id);await refresh();await openDetail(detailId);message('detail-message','Reservation updated.','success');}catch(err){if(err.code==='PUSH_STALE'){await refresh();await openDetail(detailId);}message('detail-message',err.message,'error');}}
async function mutation(formId,path,payload,button){await busy(button||$(formId).querySelector('button[type=submit]'),async()=>{try{await api(path,payload);await refresh();message('admin-message','Changes saved.','success');}catch(err){handleError(err);}});}
$('login-form').onsubmit=async e=>{e.preventDefault();await busy(e.target.querySelector('button'),async()=>{try{await api('/admin/login',formValues('login-form'));e.target.elements.password.value='';message('admin-message','');await start();}catch(err){handleError(err);}});};
$('demo-login').onclick=async()=>{await api('/admin/login',{});await start();};$('logout').onclick=async()=>{await api('/admin/logout',{});location.reload();};
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>showTab(b.dataset.tab));
$('calendar-start').value=today().slice(0,7);
$('calendar-start').onchange=()=>{if($('calendar-start').value)refresh();else $('calendar-start').value=data?.month_start.slice(0,7)||today().slice(0,7);};
$('prev-days').onclick=()=>{$('calendar-start').value=shiftMonth($('calendar-start').value,-1);refresh();};
$('next-days').onclick=()=>{$('calendar-start').value=shiftMonth($('calendar-start').value,1);refresh();};
$('calendar-room').onchange=()=>renderCalendar();
$('calendar').onclick=e=>{const cell=e.target.closest('[data-date]');if(cell)openDay(cell.dataset.date);};
$('calendar').onkeydown=e=>{
 const delta={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7}[e.key],cell=e.target.closest('[data-date]');
 if(delta&&cell){const next=$('calendar').querySelector(`[data-date="${plusDays(cell.dataset.date,delta)}"]`);if(next){e.preventDefault();next.focus({preventScroll:true});}}
};
$('close-day').onclick=()=>$('day-dialog').close();
$('day-rooms').onclick=e=>{
 const button=e.target.closest('button');if(!button)return;
 $('day-dialog').close();
 if(button.dataset.dayBooking)openDetail(button.dataset.dayBooking);
 else if(button.dataset.dayAdd)openManual(null,{date:dayDate,roomId:button.dataset.dayAdd});
 else if(button.dataset.dayAvailability)openInventory(dayDate,button.dataset.dayAvailability);
};
$('open-inventory').onclick=()=>openInventory();
$('close-inventory').onclick=()=>$('inventory-dialog').close();
$('admin-message').onclick=()=>message('admin-message','');
let calendarSize='';
new ResizeObserver(entries=>{
 const {width,height}=entries[0].contentRect,key=`${width}/${height}`;
 if(width&&height&&key!==calendarSize){calendarSize=key;requestAnimationFrame(()=>{if(data&&!$('tab-calendar').hidden)renderCalendar();});}
}).observe($('calendar'));
for(const id of ['inventory-form','rates-form']){$(id).elements.start.value=today();$(id).elements.end.value=plusDays(today(),30);$(id).elements.start.min=today();$(id).elements.end.min=today();}
$('inventory-form').onsubmit=async e=>{
 e.preventDefault();
 await busy(e.target.querySelector('button[type=submit]'),async()=>{
  try{
   const v=formValues('inventory-form'),room_ids=[...e.target.querySelectorAll('[name=room_id]:checked')].map(c=>c.value);
   if(!room_ids.length)throw new Error('Select at least one room.');
   await api('/admin/inventory',{...v,is_open:v.is_open==='true',room_ids});
   $('inventory-dialog').close();await refresh();message('admin-message','Availability updated. Tap this message to dismiss.','success');
  }catch(err){message('inventory-message',err.message,'error');}
 });
};
$('rates-form').onsubmit=e=>{e.preventDefault();const v=formValues('rates-form');mutation('rates-form','/admin/rates',{...v,rate_paise:Math.round(Number(v.rupees)*100),reset:false});};
$('reset-rates').onclick=()=>{const v=formValues('rates-form');if(!v.start||!v.end)return;mutation('rates-form','/admin/rates',{...v,reset:true},$('reset-rates'));};
$('settings-form').onsubmit=e=>{e.preventDefault();const v=formValues('settings-form');mutation('settings-form','/admin/settings',{booking_open:v.booking_open==='true',deposit_percent:+v.deposit_percent,cancellation_policy:v.cancellation_policy,policy_reviewed:v.policy_reviewed==='on',room_types:data.room_types.map(r=>({id:r.id,rate_paise:Math.round(Number(v[`rate_${r.id}`])*100),max_guests:Number(v[`guests_${r.id}`])}))});};
$('booking-list').onclick=e=>{const button=e.target.closest('[data-detail]');if(button)openDetail(button.dataset.detail);};$('booking-search').oninput=renderBookings;$('booking-filter').onchange=renderBookings;$('close-detail').onclick=()=>$('detail-dialog').close();$('keep-booking').onclick=()=>$('cancel-dialog').close();$('confirm-cancel').onclick=async()=>{await busy($('confirm-cancel'),async()=>{await detailAction('/admin/cancel',{id:detailId});$('cancel-dialog').close();});};
$('export-bookings').onclick=()=>{const cols=['reference','guest_name','email','phone','check_in','check_out','room_type','room_ids','source','guests','status','total_paise','paid_paise','refunded_paise','synced_to_cm'];const csvCell=v=>`"${String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')}"`;const csv=[cols,...data.bookings.map(b=>cols.map(k=>b[k]))].map(row=>row.map(csvCell).join(',')).join('\r\n');const link=document.createElement('a');link.href=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));link.download=`Chakoram-reservations-${today()}.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),2000);};
function shiftMonth(month,offset){const d=new Date(`${month}-01T12:00:00Z`);d.setUTCMonth(d.getUTCMonth()+offset);return d.toISOString().slice(0,7);}
function selectedManualRooms(){return [...$('manual-rooms').querySelectorAll('input:checked')].map(c=>c.value);}
function renderManualRooms(selected,chooseFirst=false){
 const f=$('manual-form'),type=f.elements.room_type.value;
 const rooms=data.rooms.filter(r=>r.room_type===type);
 const ids=new Set(selected||[]);
 if(chooseFirst&&!ids.size&&rooms.length)ids.add(rooms[0].id);
 $('manual-rooms').innerHTML=rooms.map(r=>`<label><input type="checkbox" name="room_id" value="${esc(r.id)}" ${ids.has(r.id)?'checked':''}>${esc(r.name)}</label>`).join('');
 manualAvailabilityHint();
}
function manualAvailabilityHint(){
 const f=$('manual-form'),ids=selectedManualRooms(),a=f.elements.check_in.value,z=f.elements.check_out.value;
 const conflicts=data.bookings.filter(b=>b.id!==manualDraft?.id&&ids.some(id=>b.room_ids.includes(id))&&b.check_in<z&&b.check_out>a&&['confirmed','held'].includes(status(b)));
 $('manual-availability').textContent=conflicts.length?'A selected room already has a booking or payment hold during this stay. Choose another room or dates.':'The selected rooms will be reserved from check-in up to, but not including, check-out. Availability is checked when saved. You may record an OTA stay on dates already marked closed.';
}
function openManual(booking=null,options={}){
 const f=$('manual-form');f.reset();f.querySelector('details').open=false;
 manualDraft=booking?{id:booking.id,revision:booking.owner_revision,source:booking.source}:{request_key:crypto.randomUUID()};
 $('manual-title').textContent=booking?'Edit booking details':'Add a booking';
 $('save-manual').textContent=booking?'Save changes':'Save booking';
 f.elements.check_in.value=booking?.check_in||options.date||($('calendar-start').value===today().slice(0,7)?today():`${$('calendar-start').value}-01`);
 f.elements.check_out.value=booking?.check_out||plusDays(f.elements.check_in.value,1);
 f.elements.room_type.value=booking?.room_type||data.rooms.find(r=>r.id===options.roomId)?.room_type||'deluxe';
 for(const key of ['guest_name','email','phone','guest_note','guests'])f.elements[key].value=booking?.[key]??'';
 f.elements.source.value=booking?.source||'Direct';
 if(!f.elements.source.value)f.elements.source.value='Other';
 f.elements.source.disabled=booking?.source==='website';
 $('manual-price-note').textContent=booking?'Saving changes preserves the recorded amount and payment history. Handle any extra charges or refunds separately. Update Yanolja after a change.':'The website tariff is recorded for reference. Track OTA rates and offline receipts in your accounts. Closed dates remain closed after cancellation.';
 renderManualRooms(booking?.room_ids||(options.roomId?[options.roomId]:undefined),true);message('manual-message','');$('manual-dialog').showModal();
}
$('open-manual').onclick=()=>openManual();$('add-calendar-booking').onclick=()=>openManual();
$('close-manual').onclick=()=>$('manual-dialog').close();
$('manual-form').elements.room_type.onchange=()=>renderManualRooms([],true);
$('manual-form').oninput=manualAvailabilityHint;
$('manual-form').onsubmit=async e=>{
 e.preventDefault();
 await busy($('save-manual'),async()=>{
  try{
   const v=formValues('manual-form'),room_ids=selectedManualRooms();
   if(!room_ids.length)throw new Error('Select at least one room for this stay.');
   const payload={...manualDraft,...v,room_ids,guests:v.guests===''?null:Number(v.guests)};
   const res=await api('/admin/save-booking',payload);
   $('manual-dialog').close();$('calendar-start').value=res.booking.check_in.slice(0,7);
   await refresh();await openDetail(res.booking.id);message('detail-message','Booking saved. Update Yanolja separately.','success');
  }catch(err){message('manual-message',err.message,'error');}
 });
};
try{const cfg=await api('/config');if(cfg.demo){$('demo-banner').hidden=false;$('demo-login').hidden=false;$('login-form').hidden=true;}}catch{}
await start();
