import {createOwnerKpi} from './owner-kpi.js?v=fy-20261127';
import {attachKpiCapture} from './kpi-capture.js?v=kpi-20261127';
import {mealPlanLabel,stayNights,checkoutFor,isUpcomingBooking,bookingSourceLabel} from './booking-tools.js?v=sources-20261127';
import {attachSaleCalculator} from './owner-calculator.js';
import {$,esc,money,today,plusDays,dateLabel,api,message,busy} from './common.js';
import {createOwnerWall} from './owner-wall.js?v=payments-wall-20261122';
import {createOwnerPayments,rupeesToPaise,bookingMoney} from './owner-payments.js?v=kpi-20261127';
import {createOwnerAlerts} from './owner-alerts.js?v=payments-wall-20261122';
let data,session,detailId,manualDraft,dayDate;
let refreshVersion=0,cmCount=0,wallCount=0;
function alertCount(){const count=cmCount+wallCount;$('alerts-count').textContent=count;$('alerts-count').hidden=!count;}
const alerts=createOwnerAlerts({openBooking:openDetail,onChange:refresh,onError:handleError,onCount:n=>{$('stat-sync').textContent=n;cmCount=n;alertCount();}});
const wall=createOwnerWall({openBooking:openDetail,onChange:refresh,onError:handleError,onCount:n=>{wallCount=n;alertCount();}});
const payments=createOwnerPayments({onError:handleError,onChange:refresh,openBooking:openDetail,showTab});
const kpis=createOwnerKpi({onError:handleError,onChange:refresh,openBooking:openDetail,openPayments:id=>payments.open(id)});
const manualKpi=attachKpiCapture($('manual-kpi'),{getSale:()=>rupeesToPaise($('manual-form').elements.sale.value),getBooking:()=>manualDraft?.booking||{}});
const manualCalculator=attachSaleCalculator($('manual-sale-calculator'),$('manual-form').elements.sale,{getStay:()=>({nights:stayNights($('manual-form').elements.check_in.value,$('manual-form').elements.check_out.value),rooms:selectedManualRooms().length||1})});
const formValues=id=>Object.fromEntries(new FormData($(id)));
const guestCount=b=>b.guests==null?'Guest count not entered':`${b.guests} guests`;
const status=b=>b.status==='held'&&new Date(b.expires_at)<new Date()?'expired':b.status;
const badge=b=>`<span class="badge ${status(b)==='payment_review'?'red':status(b)==='held'?'warn':''}">${esc(status(b).replaceAll('_',' '))}</span>`;
function showTab(name){
 document.querySelectorAll('[data-tab]').forEach(b=>{b.classList.toggle('active',b.dataset.tab===name);b.setAttribute('aria-current',b.dataset.tab===name?'page':'false');});
 document.querySelectorAll('.tab-panel').forEach(p=>p.hidden=p.id!==`tab-${name}`);
 document.body.classList.toggle('calendar-screen',name==='calendar'&&!$('workspace').hidden);
 if(['payments','website'].includes(name))payments.refresh(name);
 if(name==='kpi')kpis.refresh();
 if(name==='calendar')requestAnimationFrame(()=>{if(data)renderCalendar();});
}
async function refresh(){
 const version=++refreshVersion,month=$('calendar-start').value;
 $('calendar').setAttribute('aria-busy','true');
 try{
  const next=await api(`/admin/dashboard?month=${month}-01`);
  if(version!==refreshVersion)return;
  data=next;render();if($('day-dialog').open)openDay(dayDate);await Promise.all([alerts.refresh(),wall.refresh(),payments.refreshVisible(),kpis.refreshVisible()]);
 }catch(err){if(version===refreshVersion)handleError(err);}
 finally{if(version===refreshVersion)$('calendar').removeAttribute('aria-busy');}
}
function handleError(err){message('admin-message',err.message,'error');if(err.status===401){alerts.stop();wall.stop();document.body.classList.remove('calendar-screen','owner-desk');$('workspace').hidden=true;$('login-panel').hidden=false;$('logout').hidden=true;}}
async function start(){try{session=await api('/admin/session');$('workspace').hidden=false;$('login-panel').hidden=true;$('logout').hidden=false;$('signed-in').textContent=session.email;$('demo-banner').hidden=!session.demo;document.body.classList.add('owner-desk');showTab('kpi');await refresh();await alerts.start();wall.start();const booking=new URL(location.href).searchParams.get('booking');if(booking)await openDetail(booking);const payment=new URL(location.href).searchParams.get('payment');if(payment){showTab('payments');await payments.open(payment);}const wallBooking=new URL(location.href).searchParams.get('wall');if(wallBooking){showTab('overview');await openDetail(wallBooking);}}catch(err){if(err.status!==401)handleError(err);}}
function render(){const confirmed=data.bookings.filter(b=>b.status==='confirmed');$('stat-arrivals').textContent=confirmed.filter(b=>b.check_in===today()).length;$('stat-upcoming').textContent=confirmed.filter(b=>isUpcomingBooking(b,today())).length;$('stat-sync').textContent=data.bookings.filter(b=>!b.synced_to_cm&&['confirmed','cancelled','payment_review'].includes(b.status)).length;$('stat-review').textContent=data.bookings.filter(b=>b.attention).length;
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
  return `<article class="day-room"><div><strong>${esc(r.name)}</strong><p>${b?esc(b.guest_name):`<span class="room-status ${state}">${state==='open'?'Open':n?.out_of_order?'Out of order':'Closed'}</span>`}</p>${b?.status==='held'?'<p class="small muted">Payment hold</p>':''}${!b&&n?.note?`<p class="muted">${esc(n.note)}</p>`:''}</div><div class="row">${b?`<button class="button secondary small" data-day-booking="${esc(b.id)}">View booking</button>`:`<button class="button small" data-day-add="${esc(r.id)}">Add booking</button>${date>=today()?`<button class="button secondary small" data-day-availability="${esc(r.id)}">${state==='open'?'Close night':'Open night'}</button>`:''}`}</div></article>`;
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
function renderBookings(){const query=$('booking-search').value.toLowerCase(),filter=$('booking-filter').value;const bookings=data.bookings.filter(b=>`${b.guest_name} ${b.reference} ${b.phone} ${b.source}`.toLowerCase().includes(query)&&(filter==='all'||(filter==='upcoming'?isUpcomingBooking(b,today()):filter==='unsynced'?!b.synced_to_cm&&['confirmed','cancelled','payment_review'].includes(b.status):status(b)===filter))).sort((a,b)=>a.check_in.localeCompare(b.check_in));
 $('booking-filter-help').textContent=filter==='upcoming'?'Confirmed arrivals today or later, earliest first. Guests already checked in and cancelled bookings are excluded.':'Latest 500 records, sorted by check-in date — earliest first.';
 $('booking-list').innerHTML=bookings.length?bookings.map(b=>`<article class="reservation"><div><div class="row"><h3>${esc(b.guest_name)}</h3>${badge(b)}${!b.synced_to_cm&&['confirmed','cancelled','payment_review'].includes(b.status)?'<span class="badge warn">Update CM</span>':''}</div><p>${dateLabel(b.check_in)} – ${dateLabel(b.check_out)} · ${esc(b.room_ids.join(', '))} · ${guestCount(b)}</p><span class="meta">${esc(b.reference)} · ${esc(bookingSourceLabel(b.source))} · ${esc(mealPlanLabel(b.meal_plan,b.meal_plan_note))}</span>${b.attention?`<p class="attention">${esc(b.attention)}</p>`:''}</div><div><div class="money">${bookingMoney(b).sale===null?'Sale not entered':money(bookingMoney(b).sale)}</div><p>Paid ${money(bookingMoney(b).received)}</p><button class="button secondary small" data-detail="${b.id}">View reservation</button></div></article>`).join(''):'<div class="empty-state">No reservations match this view.</div>';}
function renderSettings(){const form=$('settings-form');if(!form.contains(document.activeElement)){form.elements.booking_open.value=String(data.settings.booking_open);form.elements.deposit_percent.value=String(data.settings.deposit_percent);form.elements.cancellation_policy.value=data.settings.cancellation_policy;form.elements.policy_reviewed.checked=data.settings.policy_reviewed;$('base-rates').innerHTML=data.room_types.map(r=>`<label>${esc(r.name)} · base price (₹)<input type="number" name="rate_${r.id}" min="100" max="1000000" step="0.01" value="${r.rate_paise/100}" required></label><label>${esc(r.name)} · max guests<input type="number" name="guests_${r.id}" min="1" max="6" value="${r.max_guests}" required></label>`).join('');}
 $('seasonal-rates').innerHTML=`<strong>Overrides in the displayed calendar period</strong><br>${data.rates.length?data.rates.map(r=>`${dateLabel(r.stay_date)} · ${esc(r.room_type)} · ${money(r.rate_paise)}`).join('<br>'):'No overrides. Base rates apply.'}`;}
async function openDetail(id){detailId=id;let b;try{b=await api(`/admin/booking?id=${encodeURIComponent(id)}`);if(detailId!==id)return;const index=data.bookings.findIndex(item=>item.id===id);if(index<0)data.bookings.push(b);else data.bookings[index]=b;}catch(err){handleError(err);return;}message('detail-message','');$('booking-detail').innerHTML=`<h2>${esc(b.guest_name)}</h2><div class="row">${badge(b)}<span class="small muted">${esc(b.reference)}</span></div><table class="confirmation-table"><tr><td>Stay</td><td>${dateLabel(b.check_in)} – ${dateLabel(b.check_out)} · ${stayNights(b.check_in,b.check_out)} nights</td></tr><tr><td>Rate / meal plan</td><td>${esc(mealPlanLabel(b.meal_plan,b.meal_plan_note))}</td></tr><tr><td>Rooms</td><td>${esc(b.room_ids.join(', '))}</td></tr><tr><td>Guests</td><td>${b.guests??'Not entered'}</td></tr><tr><td>Source</td><td>${esc(bookingSourceLabel(b.source))}</td></tr><tr><td>Contact</td><td>${esc(b.phone||'Not entered')}<br>${esc(b.email||'')}</td></tr><tr><td>Sale amount</td><td>${bookingMoney(b).sale===null?'Not entered':money(bookingMoney(b).sale)}</td></tr><tr><td>Received / balance due</td><td>${money(bookingMoney(b).received)} / ${bookingMoney(b).balance===null?'Enter sale amount':money(bookingMoney(b).balance)}</td></tr><tr><td>Razorpay paid / refunded</td><td>${money(b.paid_paise)} / ${money(b.refunded_paise)}</td></tr><tr><td>Payment reference</td><td>${esc(b.payment_id||'No online payment')}</td></tr>${b.wall?`<tr><td>Booking wall updated</td><td>${b.wall.pending?'No — update needed':'Yes'}</td></tr>`:''}<tr><td>CM updated</td><td>${b.synced_to_cm?'Yes':'No'}</td></tr></table>${b.guest_note?`<p class="detail-note">${esc(b.guest_note)}</p>`:''}${b.attention?`<div class="notice error">${esc(b.attention)}</div>`:''}<details class="policy-details"><summary>${b.owner_entry?'Website policy for reference':'Agreed cancellation policy'}</summary><p>${esc(b.policy)}</p></details><div class="booking-detail-actions"><button class="button secondary" id="view-payments">Payment details</button>${['confirmed','cancelled'].includes(b.status)?'<button class="button secondary" id="view-kpis">KPI details / stay status</button>':''}${b.wall?`<button class="button secondary" id="mark-wall">${b.wall.pending?'Booking wall updated':'Mark wall update needed'}</button>`:''}${status(b)==='confirmed'?'<button class="button" id="edit-reservation">Edit booking details</button>':''}<button class="button" id="mark-sync">${b.synced_to_cm?'Mark CM update needed':'Mark CM updated'}</button>${b.order_id?'<button class="button secondary" id="reconcile">Recheck payment</button>':''}${['confirmed','held','payment_review'].includes(status(b))?'<button class="button secondary" id="cancel-reservation">Cancel reservation</button>':''}${b.phone?`<a class="button secondary" href="https://wa.me/${esc(b.phone.replace(/\D/g,''))}?text=${encodeURIComponent(`Hello ${b.guest_name}, regarding your Chakoram reservation ${b.reference}.`)}" target="_blank" rel="noopener">WhatsApp guest</a>`:''}</div>`;
 if($('mark-wall'))$('mark-wall').onclick=()=>busy($('mark-wall'),async()=>{try{await wall.ack(b.wall,b.wall.pending);await openDetail(id);message('detail-message','Booking wall status saved.','success');}catch(err){if(err.code==='WALL_STALE')await openDetail(id);message('detail-message',err.message,'error');}});
 if($('view-kpis'))$('view-kpis').onclick=()=>{$('detail-dialog').close();kpis.open(id);};
 $('view-payments').onclick=()=>{$('detail-dialog').close();payments.open(id);};
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
for(const id of ['inventory-form','rates-form']){$(id).elements.start.value=today();$(id).elements.end.value=plusDays(today(),30);$(id).elements.start.min=id==='inventory-form'?plusDays(today(),-730):today();$(id).elements.end.min=id==='inventory-form'?plusDays(today(),-730):today();}
$('inventory-form').onsubmit=async e=>{
 e.preventDefault();
 await busy(e.target.querySelector('button[type=submit]'),async()=>{
  try{
   const v=formValues('inventory-form'),room_ids=[...e.target.querySelectorAll('[name=room_id]:checked')].map(c=>c.value);
   if(!room_ids.length)throw new Error('Select at least one room.');
   await api('/admin/inventory',{...v,is_open:v.is_open==='true',out_of_order:v.is_open==='out_of_order',room_ids});
   $('inventory-dialog').close();await refresh();message('admin-message','Availability updated. Tap this message to dismiss.','success');
  }catch(err){message('inventory-message',err.message,'error');}
 });
};
$('rates-form').onsubmit=e=>{e.preventDefault();const v=formValues('rates-form');mutation('rates-form','/admin/rates',{...v,rate_paise:Math.round(Number(v.rupees)*100),reset:false});};
$('reset-rates').onclick=()=>{const v=formValues('rates-form');if(!v.start||!v.end)return;mutation('rates-form','/admin/rates',{...v,reset:true},$('reset-rates'));};
$('settings-form').onsubmit=e=>{e.preventDefault();const v=formValues('settings-form');mutation('settings-form','/admin/settings',{booking_open:v.booking_open==='true',deposit_percent:+v.deposit_percent,cancellation_policy:v.cancellation_policy,policy_reviewed:v.policy_reviewed==='on',room_types:data.room_types.map(r=>({id:r.id,rate_paise:Math.round(Number(v[`rate_${r.id}`])*100),max_guests:Number(v[`guests_${r.id}`])}))});};
$('booking-list').onclick=e=>{const button=e.target.closest('[data-detail]');if(button)openDetail(button.dataset.detail);};$('booking-search').oninput=renderBookings;$('booking-filter').onchange=renderBookings;$('close-detail').onclick=()=>$('detail-dialog').close();$('keep-booking').onclick=()=>$('cancel-dialog').close();$('confirm-cancel').onclick=async()=>{await busy($('confirm-cancel'),async()=>{await detailAction('/admin/cancel',{id:detailId});$('cancel-dialog').close();});};
$('export-bookings').onclick=()=>{const cols=['reference','guest_name','email','phone','check_in','check_out','meal_plan','meal_plan_note','room_type','room_ids','source','guests','status','total_paise','paid_paise','refunded_paise','synced_to_cm'];const csvCell=v=>`"${String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')}"`;const csv=[cols,...data.bookings.map(b=>cols.map(k=>k==='room_type'?(b.room_type||'deluxe+premium'):b[k]))].map(row=>row.map(csvCell).join(',')).join('\r\n');const link=document.createElement('a');link.href=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));link.download=`Chakoram-reservations-${today()}.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),2000);};
function shiftMonth(month,offset){const d=new Date(`${month}-01T12:00:00Z`);d.setUTCMonth(d.getUTCMonth()+offset);return d.toISOString().slice(0,7);}
function selectedManualRooms(){return [...$('manual-rooms').querySelectorAll('input:checked')].map(c=>c.value);}
function uppercaseManualGuestName(){
 const input=$('manual-form').elements.guest_name,value=input.value,upper=value.toUpperCase();
 if(value===upper)return;
 const start=input.selectionStart??value.length,end=input.selectionEnd??value.length,direction=input.selectionDirection;
 input.value=upper;
 input.setSelectionRange(value.slice(0,start).toUpperCase().length,value.slice(0,end).toUpperCase().length,direction);
}
function updateManualCheckout(changed='dates'){
 const f=$('manual-form'),arrival=f.elements.check_in.value,departure=f.elements.check_out,nights=f.elements.nights;
 departure.min=checkoutFor(arrival,1);departure.max=checkoutFor(arrival,30);
 if(changed==='check_in'||changed==='nights'){
  if(changed==='check_in'&&!nights.value)nights.value='1';
  departure.value=checkoutFor(arrival,nights.value);
 }else{
  const count=stayNights(arrival,departure.value);nights.value=count===null?'':String(count);
 }
 const count=stayNights(arrival,departure.value);
 $('manual-stay-summary').textContent=count!==null&&count>=1&&count<=30?`${count} ${count===1?'night':'nights'} · ${dateLabel(arrival)} → ${dateLabel(departure.value)}`:'Choose valid dates and a stay of 1–30 nights.';
 manualCalculator.updateStay();
}
function updateManualMealPlan(){$('manual-plan-note').hidden=$('manual-form').elements.meal_plan.value!=='package';}
function renderManualRooms(selected,chooseFirst=false){
 const ids=new Set(selected||[]);
 if(chooseFirst&&!ids.size&&data.rooms.length)ids.add(data.rooms[0].id);
 $('manual-rooms').innerHTML=data.room_types.map(type=>{
  const rooms=data.rooms.filter(r=>r.room_type===type.id);
  return `<div class="manual-room-group"><h3>${esc(type.name)}</h3><div class="room-checks">${rooms.map(r=>`<label><input type="checkbox" name="room_id" value="${esc(r.id)}" ${ids.has(r.id)?'checked':''}>${esc(r.name)}</label>`).join('')}</div></div>`;
 }).join('');
 $('select-all-manual').textContent=`Select all ${data.rooms.length} rooms`;
 manualAvailabilityHint();manualCalculator.updateStay();
}
function manualAvailabilityHint(){
 const f=$('manual-form'),ids=selectedManualRooms(),a=f.elements.check_in.value,z=f.elements.check_out.value;
 const chosen=data.rooms.filter(r=>ids.includes(r.id));
 const counts=data.room_types.map(t=>({type:t,count:chosen.filter(r=>r.room_type===t.id).length})).filter(t=>t.count);
 const capacity=counts.reduce((sum,t)=>sum+t.count*t.type.max_guests,0);
 $('manual-room-summary').textContent=ids.length?`${ids.length} ${ids.length===1?'room':'rooms'} selected · ${counts.map(t=>`${t.count} ${t.type.name.replace(/ Rooms?$/,'')}`).join(' + ')} · Up to ${capacity} guests`:'Select at least one room.';
 const conflicts=data.bookings.filter(b=>b.id!==manualDraft?.id&&ids.some(id=>b.room_ids.includes(id))&&b.check_in<z&&b.check_out>a&&['confirmed','held'].includes(status(b)));
 $('manual-availability').textContent=conflicts.length?'A selected room already has a booking or payment hold during this stay. Choose another room or dates.':'The selected rooms will be reserved from check-in up to, but not including, check-out. Availability is checked when saved. You may record an OTA stay on dates already marked closed.';
}
function openManual(booking=null,options={}){
 const f=$('manual-form');f.reset();f.querySelector('.optional-booking-fields').open=false;
 manualDraft=booking?{id:booking.id,revision:booking.owner_revision,source:booking.source,booking}:{request_key:crypto.randomUUID()};
 $('manual-title').textContent=booking?'Edit booking details':'Add a booking';
 $('save-manual').textContent=booking?'Save changes':'Save booking';
 f.elements.check_in.value=booking?.check_in||options.date||($('calendar-start').value===today().slice(0,7)?today():`${$('calendar-start').value}-01`);
 f.elements.check_out.value=booking?.check_out||plusDays(f.elements.check_in.value,1);
 for(const key of ['guest_name','email','phone','guest_note','guests','meal_plan','meal_plan_note'])f.elements[key].value=booking?.[key]??'';
 uppercaseManualGuestName();updateManualCheckout();updateManualMealPlan();
 f.elements.source.value=booking?.source||'';
 if(booking&&!f.elements.source.value)f.elements.source.value='Other';
 f.elements.source.disabled=booking?.source==='website';
 const amounts=booking?bookingMoney(booking):null;
 f.elements.sale.value=amounts?.sale==null?'':(amounts.sale/100).toFixed(2);
 f.elements.advance.value=amounts?(amounts.received/100).toFixed(2):'';
 $('manual-received-label').textContent=booking?'Received so far (₹)':'Advance received (₹)';
 f.elements.sale.disabled=!!booking;f.elements.advance.disabled=!!booking;$('manual-sale-calculator').hidden=!!booking;manualCalculator.reset();
 $('manual-payment-help').textContent=booking?'Received includes all recorded payments. Use Payment details to change the sale amount or record further collections.':'Enter the agreed total and advance already received. Leave sale blank if not yet known.';
 updateManualBalance();manualKpi.load(booking||{check_in:f.elements.check_in.value},!booking);
 $('manual-price-note').textContent=booking?'Saving booking details preserves payment records. Use Payment details for collections. Update Yanolja after a change.':'The sale amount applies to all selected rooms for the full stay. Closed dates remain closed after cancellation.';
 renderManualRooms(booking?.room_ids||(options.roomId?[options.roomId]:undefined),true);message('manual-message','');$('manual-dialog').showModal();
}
$('open-manual').onclick=()=>openManual();$('add-calendar-booking').onclick=()=>openManual();
$('close-manual').onclick=()=>$('manual-dialog').close();
$('select-all-manual').onclick=()=>renderManualRooms(data.rooms.map(r=>r.id));
$('clear-manual-rooms').onclick=()=>renderManualRooms([]);
function updateManualBalance(){
 const f=$('manual-form');
 try{const sale=rupeesToPaise(f.elements.sale.value),advance=rupeesToPaise(f.elements.advance.value,0);$('manual-balance').value=sale===null?'':((sale-advance)/100).toFixed(2);}
 catch{$('manual-balance').value='';}
}
$('manual-form').oninput=e=>{
 if(['sale','advance'].includes(e.target.name)){updateManualBalance();manualKpi.total();}
 if(e.target.name==='guest_name'&&!e.isComposing)uppercaseManualGuestName();
 if(['check_in','check_out','nights'].includes(e.target.name))updateManualCheckout(e.target.name);
 if(e.target.name==='meal_plan')updateManualMealPlan();
 if(e.target.name==='room_id')manualCalculator.updateStay();
 manualAvailabilityHint();
};
$('manual-form').elements.guest_name.oncompositionend=uppercaseManualGuestName;
$('manual-form').onsubmit=async e=>{
 e.preventDefault();
 await busy($('save-manual'),async()=>{
  try{
   uppercaseManualGuestName();
   const v=formValues('manual-form'),room_ids=selectedManualRooms();
   if(!room_ids.length)throw new Error('Select at least one room for this stay.');
   const {booking:original,...draft}=manualDraft;
   const payload={...draft,...v,kpi:manualKpi.read(),room_ids,guests:v.guests===''?null:Number(v.guests)};
   if(!manualDraft.id)Object.assign(payload,{sale_amount_paise:rupeesToPaise(v.sale),advance_paise:rupeesToPaise(v.advance,0)});
   const res=await api('/admin/save-booking',payload);
   $('manual-dialog').close();$('calendar-start').value=res.booking.check_in.slice(0,7);
   await refresh();await openDetail(res.booking.id);message('detail-message','Booking saved. Update Yanolja separately.','success');
  }catch(err){message('manual-message',err.message,'error');}
 });
};
try{const cfg=await api('/config');if(cfg.demo){$('demo-banner').hidden=false;$('demo-login').hidden=false;$('login-form').hidden=true;}}catch{}
await start();
