import {bookingSourceLabel} from './booking-tools.js?v=sources-20261127';
import {$,esc,money,today,plusDays,dateLabel,api,message,busy} from './common.js';
import {attachKpiCapture} from './kpi-capture.js?v=kpi-20261127';
const fmt=(n,d=1)=>n===null||n===undefined?'—':Number(n).toLocaleString('en-IN',{maximumFractionDigits:d});
const cash=n=>n==null?'—':money(n);
const pct=n=>n==null?'—':`${fmt(n)}%`;
const categories={expense:{salary:'Salaries / staff',food:'Food supplies',housekeeping:'Housekeeping',laundry:'Laundry',utilities:'Electricity / water / fuel',internet:'Internet / telephone',repairs:'Repairs / maintenance',marketing:'Marketing',other:'Other operating cost'},income:{food:'Additional food sales',transfer:'Additional transfers',other:'Other operating income'}};
const metrics=[['occupancy_percent','Paid occupancy','percent'],['adr_paise','ARR / ADR','money'],['revpar_paise','RevPAR','money'],['total_revenue_paise','Operating revenue','money'],['room_revenue_paise','Room revenue, excluding tax','money'],['trevpar_paise','Total revenue per available room','money'],['room_nights','Paid room nights','number'],['available_room_nights','Available room nights','number'],['average_stay_nights','Average stay · nights','number'],['average_lead_days','Average booking lead · days','number'],['direct_share_percent','Direct share · room nights','percent'],['ota_share_percent','OTA share · room nights','percent']];
export function createOwnerKpi({onError,onChange,openBooking,openPayments}){
 let report,version=0,detail,ledgerKey=crypto.randomUUID(),voidEntry;
 const form=$('kpi-filters'),editor=$('kpi-booking-form');
 const capture=attachKpiCapture($('kpi-booking-capture'),{getBooking:()=>detail,getSale:()=>detail?.sale_amount_paise??null});
 function range(monthOffset=0){const d=new Date(`${today().slice(0,7)}-01T12:00:00Z`);d.setUTCMonth(d.getUTCMonth()+monthOffset);const start=d.toISOString().slice(0,10);d.setUTCMonth(d.getUTCMonth()+1);return {start,end:plusDays(d.toISOString().slice(0,10),-1)};}
 function setRange(offset){const r=range(offset);form.elements.start.value=r.start;form.elements.end.value=r.end;}
 function setFinancialYear(offset=0){const [year,month]=today().split('-').map(Number),startYear=year-(month<4?1:0)+offset;form.elements.start.value=`${startYear}-04-01`;form.elements.end.value=`${startYear+1}-03-31`;}
 function failure(id,e){message(id,e.message,'error');if(e.status===401)onError(e);}
 function tile(label,value,note=''){return `<article class="kpi-tile"><span>${esc(label)}</span><strong>${esc(value)}</strong>${note?`<small>${esc(note)}</small>`:''}</article>`;}
 function render(){
  const c=report.current,p=report.previous,r=report.range;
  $('kpi-period').textContent=`${dateLabel(c.start)} – ${dateLabel(c.end)} · ${r.mode==='actual'?'Verified stays through yesterday':'Confirmed booked stays, including future dates'} · Compared with ${dateLabel(p.start)} – ${dateLabel(p.end)}`;
  $('kpi-source-summary').textContent=`Sources for ${dateLabel(c.start)} – ${dateLabel(c.end)} (${r.mode==='actual'?'verified stays':'confirmed bookings'}): ${c.sources.length?c.sources.map(s=>`${bookingSourceLabel(s.source)}: ${s.reservations} ${s.reservations===1?'stay':'stays'}`).join(' · '):'none'}. Stays outside these dates are excluded. For future bookings, select Next month or Next 90 days.`;
  $('kpi-cards').innerHTML=metrics.map(([key,label,type])=>{const f=type==='money'?cash:type==='percent'?pct:fmt;return tile(label,f(c[key]),`Previous period: ${f(p[key])}`);}).join('');
  const problems=[c.missing_revenue?`${c.missing_revenue} stays need an income split`:null,c.missing_costs?`${c.missing_costs} stays need selling costs`:null,c.unverified_stays?`${c.unverified_stays} past/current stays need arrival or departure verification`:null,c.capacity_conflicts?'Room capacity conflicts need review':null].filter(Boolean);
  $('kpi-quality-summary').textContent=problems.length?problems.join(' · '):'Selected stays have complete income and cost allocations.';
  $('kpi-quality-summary').className=`notice ${problems.length?'':'success'}`;
  $('kpi-operations').innerHTML=[
   ['Occupied room nights',fmt(c.occupied_room_nights),`${fmt(c.complimentary_room_nights)} complimentary · Physical occupancy ${pct(c.physical_occupancy_percent)}`],
   ['Guest nights',fmt(c.guest_nights),`${c.unknown_guest_count} stays have an unknown guest count`],
   ['Cancellations',`${c.cancelled} · ${pct(c.cancellation_percent)}`,`From ${c.arrival_cohort} reservations due to arrive in this period`],
   ['No-shows',`${c.no_shows} · ${pct(c.no_show_percent)}`,'Only reservations explicitly marked no-show'],
   ['Received for selected stays',cash(c.received_paise),'Whole-stay receipts, net of recorded gateway refunds'],
   ['Balance on selected stays',cash(c.balance_paise),`${c.unpriced} stays need a sale amount · whole-stay balance`],
   ['Distribution costs',cash(c.distribution_cost_paise),'Recorded commission and gateway fees'],
   ['Operating expenses entered',cash(c.expenses_paise),'Service-period share of entered operating costs'],
   ['Operating result',cash(c.operating_result_paise),c.reviewed?'Reviewed periods · excludes financing, depreciation and income tax':'Provisional · review completeness below'],
   ['Operating margin',pct(c.operating_margin_percent),'Operating result ÷ operating revenue'],
   ['Cost per occupied room night',cash(c.operating_cost_per_occupied_room_paise),'Entered operating and distribution costs'],
   ['Out of order room nights',fmt(c.out_of_order_nights),'Excluded from available capacity']
  ].map(v=>tile(...v)).join('');
  $('kpi-daily').innerHTML=`<table class="kpi-table"><caption>Daily room performance</caption><thead><tr><th>Date</th><th>Available</th><th>Paid</th><th>All occupied</th><th>Paid occupancy</th><th>Room income</th></tr></thead><tbody>${c.series.map(d=>`<tr><th>${dateLabel(d.date)}</th><td>${d.available}</td><td>${d.sold}</td><td>${d.occupied}</td><td><span class="kpi-bar"><i style="width:${Math.max(0,Math.min(100,d.occupancy_percent||0))}%"></i></span>${pct(d.occupancy_percent)}</td><td>${cash(d.room_revenue_paise)}</td></tr>`).join('')}</tbody></table>`;
  $('kpi-room-table').innerHTML=`<table class="kpi-table"><caption>Room occupancy</caption><thead><tr><th>Room</th><th>Available nights</th><th>Paid nights</th><th>Occupied nights</th><th>Paid occupancy</th></tr></thead><tbody>${c.rooms.map(d=>`<tr><th>${esc(d.name)}</th><td>${d.available}</td><td>${d.sold}</td><td>${d.occupied}</td><td>${pct(d.occupancy_percent)}</td></tr>`).join('')}</tbody></table>`;
  $('kpi-source-table').innerHTML=`<table class="kpi-table"><caption>Booking sources · selected stay dates</caption><thead><tr><th>Source</th><th>Stays</th><th>Room nights</th><th>Share of room nights</th><th>Stay income, excl. tax</th></tr></thead><tbody>${c.sources.map(d=>`<tr><th>${esc(bookingSourceLabel(d.source))}</th><td>${d.reservations}</td><td>${d.room_nights}</td><td>${pct(c.occupied_room_nights?d.room_nights*100/c.occupied_room_nights:null)}</td><td>${cash(d.revenue_paise)}</td></tr>`).join('')||'<tr><td colspan="5">No selected stays</td></tr>'}</tbody></table>`;
  $('kpi-mix').innerHTML=[...Object.entries(c.mix).map(([key,n])=>tile(`${({room:'Room',food:'Meals',transfer:'Transfers',other:'Other stay'})[key]} income`,cash(n),c.missing_revenue?'Known allocations only':'Excluding tax')),tile('Additional non-booking income',cash(c.extra_income_paise)),tile('Taxes in allocations',cash(c.tax_paise),'Excluded from revenue')].join('');
  $('kpi-known-note').textContent=`Known room income: ${cash(c.known_room_revenue_paise)}. Revenue ratios show — when any selected stay lacks a confirmed split. Average lead time uses ${c.lead_known} of ${c.reservations} selected reservations.`;
  $('kpi-quality').innerHTML=c.quality.length?c.quality.map(b=>`<article class="kpi-quality-row"><div><strong>${esc(b.guest_name)}</strong><p>${dateLabel(b.check_in)} · ${esc(b.reference)}</p><p class="small muted">${esc(b.missing.join(' · '))}</p></div><button class="button secondary small" data-kpi-booking="${esc(b.id)}">Complete details</button></article>`).join(''):'<p class="muted">No missing booking details in this view.</p>';
  $('kpi-ledger-list').innerHTML=report.ledger.length?report.ledger.map(e=>`<article class="kpi-quality-row ${e.voided_at?'receipt-void':''}"><div><strong>${esc(categories[e.kind][e.category])} · ${cash(e.amount_paise)}</strong><p>${dateLabel(e.start_date)} – ${dateLabel(e.end_date)} · ${e.kind==='expense'?'Expense':'Income'}</p><p>${esc(e.note)}</p>${e.voided_at?`<p>Voided: ${esc(e.void_reason)}</p>`:''}</div>${e.voided_at?'':`<button class="text-button" data-kpi-void="${esc(e.id)}">Correct entry</button>`}</article>`).join(''):'<p class="muted">No operating entries for this period.</p>';
  reviewMonth();
 }
 async function refresh(){
  const current=++version;report=null;$('kpi-export').disabled=true;$('kpi-report').hidden=true;message('kpi-message','Loading performance…');
  try{const next=await api(`/admin/kpi/report?${new URLSearchParams(new FormData(form))}`);if(current!==version)return;report=next;render();$('kpi-report').hidden=false;$('kpi-export').disabled=false;message('kpi-message','');}
  catch(e){if(current===version)failure('kpi-message',e);}
 }
 async function open(id){
  try{detail=await api(`/admin/booking?id=${encodeURIComponent(id)}`);$('kpi-booking-name').textContent=detail.guest_name;$('kpi-booking-stay').textContent=`${detail.reference} · ${dateLabel(detail.check_in)} – ${dateLabel(detail.check_out)} · ${detail.room_ids.join(', ')} · ${detail.status}`;
   editor.elements.guests.value=detail.guests??'';editor.elements.meal_plan.value=detail.meal_plan||'';editor.elements.meal_plan_note.value=detail.meal_plan_note||'';
   capture.load(detail);$('kpi-booking-capture').open=true;message('kpi-booking-message','');$('kpi-booking-dialog').showModal();
  }catch(e){onError(e);}
 }
 editor.onsubmit=e=>{e.preventDefault();busy(e.submitter,async()=>{try{
  await api('/admin/kpi/booking',{id:detail.id,revision:detail.owner_revision,guests:editor.elements.guests.value===''?null:Number(editor.elements.guests.value),meal_plan:editor.elements.meal_plan.value||null,meal_plan_note:editor.elements.meal_plan_note.value,kpi:capture.read()});
  $('kpi-booking-dialog').close();await onChange();message('kpi-message','Booking KPI details saved.','success');
 }catch(err){failure('kpi-booking-message',err);}});};
 $('kpi-close-booking').onclick=()=>$('kpi-booking-dialog').close();
 $('kpi-booking-payment').onclick=()=>{$('kpi-booking-dialog').close();openPayments(detail.id);};
 $('kpi-booking-reservation').onclick=()=>{$('kpi-booking-dialog').close();openBooking(detail.id);};
 $('kpi-quality').onclick=e=>{const button=e.target.closest('[data-kpi-booking]');if(button)open(button.dataset.kpiBooking);};
 form.onsubmit=e=>{e.preventDefault();refresh();};
 $('kpi-this-month').onclick=()=>{setRange(0);refresh();};$('kpi-last-month').onclick=()=>{setRange(-1);refresh();};
 $('kpi-current-fy').onclick=()=>{setFinancialYear(0);refresh();};$('kpi-last-fy').onclick=()=>{setFinancialYear(-1);refresh();};
 $('kpi-next-month').onclick=()=>{setRange(1);form.elements.mode.value='booked';refresh();};
 $('kpi-next-90').onclick=()=>{form.elements.start.value=today();form.elements.end.value=plusDays(today(),89);form.elements.mode.value='booked';refresh();};
 function ledgerCategories(){const f=$('kpi-ledger-form');f.elements.category.innerHTML=Object.entries(categories[f.elements.kind.value]).map(([key,label])=>`<option value="${key}">${esc(label)}</option>`).join('');}
 $('kpi-add-ledger').onclick=()=>{const f=$('kpi-ledger-form');f.reset();ledgerKey=crypto.randomUUID();f.elements.start_date.value=today();f.elements.end_date.value=today();ledgerCategories();message('kpi-ledger-message','');$('kpi-ledger-dialog').showModal();};
 $('kpi-close-ledger').onclick=()=>$('kpi-ledger-dialog').close();$('kpi-ledger-form').elements.kind.onchange=ledgerCategories;
 $('kpi-ledger-form').elements.start_date.onchange=e=>{const f=$('kpi-ledger-form');if(f.elements.end_date.value<e.target.value)f.elements.end_date.value=e.target.value;};
 $('kpi-ledger-form').onsubmit=e=>{e.preventDefault();busy(e.submitter,async()=>{try{const v=Object.fromEntries(new FormData(e.target));if(!/^\d+(\.\d{1,2})?$/.test(v.amount))throw new Error('Enter a valid amount.');await api('/admin/kpi/ledger',{...v,id:ledgerKey,amount_paise:Math.round(Number(v.amount)*100)});$('kpi-ledger-dialog').close();await refresh();message('kpi-message','Operating entry saved.','success');}catch(err){failure('kpi-ledger-message',err);}});};
 $('kpi-ledger-list').onclick=e=>{const button=e.target.closest('[data-kpi-void]');if(button){voidEntry=report.ledger.find(v=>v.id===button.dataset.kpiVoid);$('kpi-void-form').reset();$('kpi-void-label').textContent=`${cash(voidEntry.amount_paise)} · ${categories[voidEntry.kind][voidEntry.category]}`;message('kpi-void-message','');$('kpi-void-dialog').showModal();}};
 $('kpi-keep-entry').onclick=()=>$('kpi-void-dialog').close();
 $('kpi-void-form').onsubmit=e=>{e.preventDefault();busy(e.submitter,async()=>{try{await api('/admin/kpi/void',{id:voidEntry.id,revision:voidEntry.revision,reason:e.target.elements.reason.value});$('kpi-void-dialog').close();await refresh();message('kpi-message','Entry voided. Add a replacement if needed. The correction remains in the history.','success');}catch(err){failure('kpi-void-message',err);}});};
 function reviewMonth(){const f=$('kpi-review-form');f.elements.month.min=form.elements.start.value.slice(0,7);f.elements.month.max=form.elements.end.value.slice(0,7);if(!f.elements.month.value||f.elements.month.value<f.elements.month.min||f.elements.month.value>f.elements.month.max)f.elements.month.value=f.elements.month.min;const p=report?.periods.find(p=>p.month===f.elements.month.value+'-01');f.elements.bookings_complete.checked=!!p?.bookings_complete;f.elements.costs_complete.checked=!!p?.costs_complete;}
 $('kpi-review-form').elements.month.onchange=reviewMonth;
 $('kpi-review-form').onsubmit=e=>{e.preventDefault();busy(e.submitter,async()=>{try{const f=e.target.elements;await api('/admin/kpi/review',{month:f.month.value+'-01',bookings_complete:f.bookings_complete.checked,costs_complete:f.costs_complete.checked});await refresh();message('kpi-message','Month review saved.','success');}catch(err){failure('kpi-message',err);}});};
 $('kpi-export').onclick=()=>{if(!report)return;const rows=[['Chakoram management performance',report.range.mode],['Period',report.current.start,report.current.end],['Previous period',report.previous.start,report.previous.end],['Review',report.current.reviewed?'Reviewed':'Provisional'],['Metric','Current','Previous']];
  const exportMetrics=[...metrics,['received_paise','Whole-stay received','money'],['balance_paise','Whole-stay balance','money'],['expenses_paise','Operating expenses entered','money'],['distribution_cost_paise','Distribution costs','money'],['operating_result_paise','Operating result (provisional if incomplete)','money'],['missing_revenue','Stays missing revenue','number'],['unverified_stays','Unverified past/current stays','number']];
  for(const [key,label,type] of exportMetrics)rows.push([label,...[report.current[key],report.previous[key]].map(v=>v==null?'Not available':type==='money'?(v/100).toFixed(2):v)]);
  rows.push([],['Source','Stays','Room nights','Share of room nights percent','Stay income INR']);for(const s of report.current.sources)rows.push([bookingSourceLabel(s.source),s.reservations,s.room_nights,report.current.occupied_room_nights?(s.room_nights*100/report.current.occupied_room_nights).toFixed(2):'',s.revenue_paise===null?'Not available':(s.revenue_paise/100).toFixed(2)]);
  rows.push([],['Date','Available room nights','Paid room nights','Occupied room nights','Room income INR']);for(const d of report.current.series)rows.push([d.date,d.available,d.sold,d.occupied,d.room_revenue_paise===null?'Not available':(d.room_revenue_paise/100).toFixed(2)]);
  rows.push([],['Guest','Reference','Check-in','Missing data']);for(const b of report.current.quality)rows.push([b.guest_name,b.reference,b.check_in,b.missing.join('; ')]);
  const cell=v=>`"${String(v??'').replace(/^[\s]*[=+@-]/,"'$&").replaceAll('"','""')}"`,csv=rows.map(row=>row.map(cell).join(',')).join('\r\n'),a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));a.download=`Chakoram-KPI-${report.current.start}-${report.current.end}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000);
 };
 setRange(0);
 return {open,refresh,refreshVisible:()=>!$('tab-kpi').hidden?refresh():Promise.resolve()};
}
