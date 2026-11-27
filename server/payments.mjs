import {mealPlanLabel} from '../public/booking-tools.js';
// Owner accounting is separate from gateway capture/refund records.
export const MAX_PAISE=1000000000;
export function financeFor(b){
 const sale=b.sale_amount_paise??(!b.owner_entry&&b.source==='website'?b.total_paise:null);
 const gateway=Math.max(0,b.paid_paise-b.refunded_paise),offline=b.offline_received_paise||0,received=gateway+offline;
 return {sale_amount_paise:sale,gateway_received_paise:gateway,offline_received_paise:offline,
   received_paise:received,balance_paise:sale===null?null:Math.max(0,sale-received),credit_paise:sale===null?0:Math.max(0,received-sale)};
}
export function validatePaymentInput(action,input,ErrorClass){
 const fail=message=>{throw new ErrorClass(message);};
 const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
 if(action==='settings'){
   if(typeof input.enabled!=='boolean')fail('Choose whether payment reminders are enabled.');
   return {enabled:input.enabled};
 }
 if(!uuid(input.id))fail('Choose a reservation.');
 if(!Number.isSafeInteger(input.revision)||input.revision<0)fail('Reopen payment details and try again.');
 const clean={id:input.id,revision:input.revision};
 if(action==='save_sale'){
   if(!Number.isSafeInteger(input.sale_amount_paise)||input.sale_amount_paise<0||input.sale_amount_paise>MAX_PAISE)fail('Enter a valid sale amount.');
   return {...clean,sale_amount_paise:input.sale_amount_paise};
 }
 if(action==='receipt'){
   if(!uuid(input.request_key))fail('Reopen payment details and try again.');
   if(!Number.isSafeInteger(input.amount_paise)||input.amount_paise<=0||input.amount_paise>MAX_PAISE)fail('Enter a valid amount received.');
   if(!['cash','upi','bank','ota','other'].includes(input.method))fail('Choose how payment was received.');
   if(typeof (input.note??'')!=='string'||(input.note||'').length>300)fail('Keep the payment note within 300 characters.');
   return {...clean,request_key:input.request_key,amount_paise:input.amount_paise,method:input.method,note:(input.note||'').trim()};
 }
 if(action==='void'){
   if(!uuid(input.receipt_id)||typeof input.reason!=='string'||input.reason.trim().length<3||input.reason.length>300)fail('Select the receipt and enter a correction reason.');
   return {...clean,receipt_id:input.receipt_id,reason:input.reason.trim()};
 }
 fail('Unknown payment action.');
}
export function paymentNotificationFor(task){
 const b=task.booking,amount=new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:2}).format(b.balance_paise/100);
 const stage=task.stage==='arrival'?'check-in':'checkout';
 const plan=task.stage==='arrival'?` · ${mealPlanLabel(b.meal_plan,b.meal_plan_note)}`:'';
 return {title:`Collect payment: ${stage} tomorrow`,
   body:`${b.guest_name}${plan} · Balance ${amount} · ${b.reference}. ${stage==='check-in'?'Check-in':'Checkout'} ${task.event_date}. Open Payments after collecting.`,
   kind:'payment',stage:task.stage,event_date:task.event_date,booking_id:b.id,
   tag:`chakoram-payment-${b.id}-${task.stage}-${task.event_date}`};
}
