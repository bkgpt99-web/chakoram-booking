import {$,esc,money,today,dateLabel,api,message,busy} from './common.js';
export function rupeesToPaise(value,blank=null){
 const s=String(value??'').trim();if(!s)return blank;
 if(!/^\d{1,8}(\.\d{1,2})?$/.test(s))throw new Error('Enter an amount with up to two decimal places.');
 const [whole,fraction='']=s.split('.'),paise=Number(whole)*100+Number(fraction.padEnd(2,'0'));
 if(paise>1000000000)throw new Error('Amount cannot exceed ₹1,00,00,000.');return paise;
}
export function bookingMoney(b){
 const sale=b.sale_amount_paise??(!b.owner_entry&&b.source==='website'?b.total_paise:null);
 const received=Math.max(0,b.paid_paise-b.refunded_paise)+(b.offline_received_paise||0);
 return {sale,received,balance:sale===null?null:Math.max(0,sale-received)};
}
export function createOwnerPayments({onError,onChange,openBooking,showTab}){
 const state={payments:{offset:0,version:0},website:{offset:0,version:0}};
 let detail,detailVersion=0,receiptKey,selectedReceipt;
 const filters=type=>{
  const f=Object.fromEntries(new FormData($(`${type}-filters`)));
  return {...f,limit:50,offset:state[type].offset};
 };
 const endpoint=type=>type==='website'?'website_report':'list';
 const get=(type,params)=>api(`/admin/payments/${endpoint(type)}?${new URLSearchParams(params)}`);
 const error=(id,e)=>{message(id,e.message,'error');if(e.status===401)onError(e);};
 function stats(type,r){
  const s=r.summary;
  $(type+'-summary').innerHTML=(type==='payments'?
   [['Balance to collect',money(s.balance_paise)],['Reservations',r.total],['Sale amount missing',s.unpriced]]:
   [['Website reservations',r.total],['Booked value',money(s.sale_paise)],['Received, net of refunds',money(s.received_paise)],['Confirmed balance due',money(s.balance_paise)]])
   .map(([label,value])=>`<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('');
 }
 function rows(type,r){
  $(`${type}-list`).innerHTML=r.rows.length?r.rows.map(b=>{
   const unpriced=b.sale_amount_paise===null;
   return `<article class="collection-row"><div class="collection-guest"><h3>${esc(b.guest_name)}</h3><p>${dateLabel(b.check_in)} → ${dateLabel(b.check_out)}</p><p>${esc(b.room_ids.join(', '))} · ${esc(b.reference)} · ${esc(b.source)}</p>${type==='website'?`<span class="badge">${esc(b.display_status.replaceAll('_',' '))}</span>`:''}</div><dl class="collection-amounts"><div><dt>Sale amount</dt><dd>${unpriced?'Not entered':money(b.sale_amount_paise)}</dd></div><div><dt>Received</dt><dd>${money(b.received_paise)}</dd></div><div><dt>${b.status==='confirmed'?'Balance due':'Unpaid amount'}</dt><dd class="balance-amount">${unpriced?'—':money(b.balance_paise)}</dd></div></dl><button class="button ${type==='website'?'secondary ':''}small" data-payment="${esc(b.id)}">${unpriced?'Enter sale amount':b.balance_paise>0&&b.status==='confirmed'?'Collect payment':'Payment details'}</button></article>`;
  }).join(''):`<div class="empty-state">${type==='payments'?'No pending collections match this view.':'No guest website bookings match these filters.'}</div>`;
  const count=r.rows.length;
  $(`${type}-page`).textContent=r.total?`${r.offset+1}–${r.offset+count} of ${r.total}`:'0 reservations';
  $(`${type}-prev`).disabled=r.offset===0;$(`${type}-next`).disabled=r.offset+count>=r.total;
 }
 async function refresh(type='payments'){
  const version=++state[type].version;$(`${type}-list`).setAttribute('aria-busy','true');message(`${type}-message`,'');
  try{
   const r=await get(type,filters(type));if(version!==state[type].version)return;
   if(!r.rows.length&&r.total&&state[type].offset){state[type].offset=Math.max(0,Math.floor((r.total-1)/50)*50);return refresh(type);}
   stats(type,r);rows(type,r);
   if(type==='payments'){
    $('payment-reminders').checked=r.reminders_enabled;
    $('payment-device-status').textContent=`${r.device_count} alert ${r.device_count===1?'device':'devices'} connected. Reminders show guest names and the current balance. ${r.device_count?'Manage devices in Alerts.':'Enable phone alerts in the Alerts tab to receive reminders.'}`;
   }
  }catch(e){if(version===state[type].version)error(`${type}-message`,e);}
  finally{if(version===state[type].version)$(`${type}-list`).removeAttribute('aria-busy');}
 }
 function renderDetail(result){
  detail=result.booking;receiptKey=crypto.randomUUID();selectedReceipt=null;
  const b=detail,editable=b.status==='confirmed',website=b.source==='website'&&!b.owner_entry;
  $('payment-guest').textContent=b.guest_name;$('payment-stay').textContent=`${b.reference} · ${dateLabel(b.check_in)} – ${dateLabel(b.check_out)} · ${b.room_ids.join(', ')} · ${b.source}`;
  $('payment-detail-summary').innerHTML=[['Sale amount',b.sale_amount_paise===null?'Not entered':money(b.sale_amount_paise)],['Received',money(b.received_paise)],['Balance',b.balance_paise===null?'Enter sale amount':money(b.balance_paise)]]
   .map(([label,value])=>`<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('');
  $('payment-account-note').textContent=`Razorpay received (after refunds): ${money(b.gateway_received_paise)}. Recorded separately: ${money(b.offline_received_paise)}.${b.credit_paise?` Credit above the sale amount: ${money(b.credit_paise)}.`:''}${!editable?' This reservation is not confirmed. No new payments can be entered.':''}`;
  const price=$('payment-sale-form');price.hidden=website||!editable;price.elements.sale.value=b.sale_amount_paise===null?'':(b.sale_amount_paise/100).toFixed(2);
  const form=$('payment-receipt-form');form.hidden=!editable||!b.balance_paise;form.reset();form.elements.amount.max=(b.balance_paise/100).toFixed(2);form.elements.amount.value=b.balance_paise>0?(b.balance_paise/100).toFixed(2):'';
  $('payment-ledger').innerHTML=result.receipts.length?result.receipts.map(r=>`<article class="receipt-row ${r.voided_at?'receipt-void':''}"><div><strong>${money(r.amount_paise)} · ${esc(({cash:'Cash',upi:'UPI',bank:'Bank transfer',ota:'OTA remittance',other:'Other'})[r.method])}</strong><p>${new Date(r.created_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST${r.note?` · ${esc(r.note)}`:''}</p>${r.voided_at?`<p>Corrected: ${esc(r.void_reason)}</p>`:''}</div>${r.voided_at?'<span class="badge">Voided</span>':`<button class="text-button" data-void="${r.id}">Correct entry</button>`}</article>`).join(''):'<p class="muted">No payments have been entered manually.</p>';
  $('payment-correction-form').hidden=true;
 }
 async function open(id){
  const version=++detailVersion;message('payment-detail-message','');
  try{const result=await api(`/admin/payments/booking?id=${encodeURIComponent(id)}`);if(version!==detailVersion)return;renderDetail(result);if(!$('payment-dialog').open)$('payment-dialog').showModal();}
  catch(e){onError(e);}
 }
 async function save(action,payload,button){
  await busy(button,async()=>{
   try{const result=await api(`/admin/payments/${action}`,{id:detail.id,revision:detail.owner_revision,...payload});renderDetail(result);message('payment-detail-message','Payment details saved.','success');await onChange();}
   catch(e){error('payment-detail-message',e);if(e.code==='PAYMENT_STALE'){const id=detail.id;await open(id);message('payment-detail-message','Details were updated elsewhere. Review the refreshed amounts before saving.','error');}}
  });
 }
 function refreshVisible(){return Promise.all(['payments','website'].filter(t=>!$(`tab-${t}`).hidden).map(refresh));}
 for(const type of ['payments','website']){
  $(`${type}-filters`).onsubmit=e=>{e.preventDefault();state[type].offset=0;refresh(type);};
  $(`${type}-prev`).onclick=()=>{state[type].offset=Math.max(0,state[type].offset-50);refresh(type);};
  $(`${type}-next`).onclick=()=>{state[type].offset+=50;refresh(type);};
  $(`${type}-list`).onclick=e=>{const b=e.target.closest('[data-payment]');if(b)open(b.dataset.payment);};
 }
 $('payment-reminders').onchange=async e=>{
  const el=e.target;el.disabled=true;
  try{await api('/admin/payments/settings',{enabled:el.checked});message('payments-message',el.checked?'Reminders enabled for 9:00 a.m. IST, one day before check-in and checkout.':'Payment reminders paused.','success');}
  catch(err){el.checked=!el.checked;error('payments-message',err);}finally{el.disabled=false;}
 };
 $('payment-alerts-link').onclick=()=>showTab('overview');
 $('close-payment').onclick=()=>{$('payment-dialog').close();detailVersion++;};
 $('payment-view-booking').onclick=()=>{$('payment-dialog').close();openBooking(detail.id);};
 $('payment-sale-form').onsubmit=e=>{e.preventDefault();try{save('save_sale',{sale_amount_paise:rupeesToPaise(e.target.elements.sale.value)},e.submitter);}catch(err){error('payment-detail-message',err);}};
 $('payment-receipt-form').onsubmit=e=>{e.preventDefault();try{const f=e.target.elements;save('receipt',{request_key:receiptKey,amount_paise:rupeesToPaise(f.amount.value),method:f.method.value,note:f.note.value},e.submitter);}catch(err){error('payment-detail-message',err);}};
 $('payment-ledger').onclick=e=>{const b=e.target.closest('[data-void]');if(b){selectedReceipt=b.dataset.void;$('payment-correction-form').hidden=false;$('payment-correction-form').elements.reason.value='';$('payment-correction-form').elements.reason.focus();}};
 $('payment-correction-form').onsubmit=e=>{e.preventDefault();save('void',{receipt_id:selectedReceipt,reason:e.target.elements.reason.value},e.submitter);};
 $('cancel-payment-correction').onclick=()=>{$('payment-correction-form').hidden=true;selectedReceipt=null;};
 $('export-website').onclick=()=>busy($('export-website'),async()=>{
  try{
   const query={...filters('website'),limit:100,offset:0},all=[];let result;
   do{result=await get('website',query);all.push(...result.rows);query.offset+=result.rows.length;}while(result.rows.length&&all.length<result.total);
   const cols=['reference','guest_name','check_in','check_out','room_ids','display_status','sale_amount_paise','received_paise','balance_paise','created_at'];
   const cell=v=>`"${String(v??'').replace(/^[\s]*[=+@-]/,"'$&").replaceAll('"','""')}"`;
   const csv=[cols.map(k=>k.replace('_paise','_INR')), ...all.map(b=>cols.map(k=>k.endsWith('_paise')?(b[k]===null?'':(b[k]/100).toFixed(2)):b[k]))].map(row=>row.map(cell).join(',')).join('\r\n');
   const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));a.download=`Chakoram-website-bookings-${today()}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000);
   message('website-message',`Exported ${all.length} website reservations.`,'success');
  }catch(e){error('website-message',e);}
 });
 document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!$('workspace').hidden)refreshVisible();});
 return {open,refresh,refreshVisible};
}
