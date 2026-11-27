import {financeFor} from './payments.mjs';

const DAY=86400000;
export const dateNumber=value=>Date.parse(`${value}T00:00:00Z`)/DAY;
export const dateString=value=>new Date(value*DAY).toISOString().slice(0,10);
export const istToday=()=>new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
const validDate=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(dateNumber(v))&&dateString(dateNumber(v))===v;
export function reportRange(input,ErrorClass=Error,today=istToday()){
 let {start,end,mode='booked'}=input;
 if(!validDate(start)||!validDate(end)||end<start||dateNumber(end)-dateNumber(start)>365||!['booked','actual'].includes(mode))throw new ErrorClass('Choose a valid reporting period of up to 366 days.');
 if(mode==='actual')end=end<today?end:dateString(dateNumber(today)-1);
 if(end<start)throw new ErrorClass('Actual performance is available through yesterday. Choose an earlier start date.');
 const days=dateNumber(end)-dateNumber(start)+1;
 return {start,end,mode,days,previous_start:dateString(dateNumber(start)-days),previous_end:dateString(dateNumber(start)-1),today};
}
export function validateKpiCapture(value,ErrorClass=Error){
 const fail=()=>{throw new ErrorClass('Check the KPI dates, stay status and amounts. Amounts must be zero or positive, with at most two decimal places.');};
 if(!value||typeof value!=='object'||Array.isArray(value))fail();
 const clean={};
 clean.booked_on=value.booked_on||null;if(clean.booked_on&&!validDate(clean.booked_on))fail();
 clean.stay_status=value.stay_status||'unverified';clean.stay_kind=value.stay_kind||'paid';
 if(!['unverified','in_house','checked_out','no_show'].includes(clean.stay_status)||!['paid','complimentary'].includes(clean.stay_kind))fail();
 for(const field of ['room_revenue_paise','food_revenue_paise','transfer_revenue_paise','other_revenue_paise','tax_paise','commission_paise','gateway_fee_paise']){
  const amount=value[field]??null;if(amount!==null&&(!Number.isSafeInteger(amount)||amount<0||amount>1000000000))fail();clean[field]=amount;
 }
 for(const field of ['revenue_confirmed','costs_confirmed']){if(value[field]!==undefined&&typeof value[field]!=='boolean')fail();clean[field]=value[field]===true;}
 return clean;
}
// Cumulative integer allocation conserves paise across adjoining reporting periods.
export function prorate(amount,a,z,start,end){
 const n=dateNumber(z)-dateNumber(a),lo=Math.max(0,dateNumber(start)-dateNumber(a)),hi=Math.min(n,dateNumber(end)+1-dateNumber(a));
 return n>0&&hi>lo?Math.floor(amount*hi/n)-Math.floor(amount*lo/n):0;
}
const divide=(a,b)=>b?a/b:null;
const direct=new Set(['website','Direct','phone','walk-in']);
const ota=new Set(['Booking.com','Agoda','Airbnb','Expedia','MMT/Goibibo','OTA']);
const overlap=(b,start,end)=>b.check_in<=end&&b.check_out>start;
function summarize(data,start,end,mode,today){
 const days=dateNumber(end)-dateNumber(start)+1,rooms=data.rooms||[],bookings=data.bookings||[];
 const outages=new Set((data.outages||[]).filter(n=>n.stay_date>=start&&n.stay_date<=end).map(n=>`${n.room_id}/${n.stay_date}`));
 const series=Array.from({length:days},(_,i)=>{const date=dateString(dateNumber(start)+i);return {date,available:rooms.filter(r=>!outages.has(`${r.id}/${date}`)).length,sold:0,occupied:0,room_revenue_paise:0};});
 const roomRows=rooms.map(r=>({...r,available:series.filter(d=>!outages.has(`${r.id}/${d.date}`)).length,sold:0,occupied:0}));
 const byRoom=new Map(roomRows.map(r=>[r.id,r])),sourceMap=new Map(),quality=[];
 const result={available_room_nights:series.reduce((n,d)=>n+d.available,0),out_of_order_nights:outages.size,room_nights:0,occupied_room_nights:0,complimentary_room_nights:0,reservations:0,guest_nights:0,unknown_guest_count:0,missing_revenue:0,missing_costs:0,unverified_stays:0,capacity_conflicts:0,known_room_revenue_paise:0,known_stay_revenue_paise:0,known_distribution_cost_paise:0,tax_paise:0,received_paise:0,balance_paise:0,unpriced:0};
 const mix={room:0,food:0,transfer:0,other:0};let nightsTotal=0,leadTotal=0,leadCount=0,directNights=0,otaNights=0;
 for(const b of bookings.filter(b=>b.status==='confirmed'&&overlap(b,start,end))){
  const k=b.kpi||{},missing=[];
  const booked=k.booked_on||(!b.owner_entry&&b.source==='website'&&b.created_at?new Date(b.created_at).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'}):null);
  if(financeFor(b).sale_amount_paise===null)missing.push('Sale amount');if(!booked)missing.push('Original booking date');if(b.guests==null)missing.push('Guest count');if(!b.meal_plan)missing.push('Meal plan');
  if(!k.revenue_confirmed)missing.push('Revenue split / tax');if(!k.costs_confirmed)missing.push('Commission / gateway costs');
  const verified=['in_house','checked_out'].includes(k.stay_status);
  if(b.check_in<today&&!verified){missing.push('Verify arrival / departure');result.unverified_stays++;}
  if(missing.length)quality.push({id:b.id,guest_name:b.guest_name,reference:b.reference,check_in:b.check_in,missing});
  if(mode==='actual'&&!verified)continue;
  result.reservations++;nightsTotal+=dateNumber(b.check_out)-dateNumber(b.check_in);
  if(booked){leadTotal+=Math.max(0,dateNumber(b.check_in)-dateNumber(booked));leadCount++;}
  const ds=series.filter(d=>d.date>=b.check_in&&d.date<b.check_out),rn=ds.length*b.room_ids.length,paid=k.stay_kind!=='complimentary';
  result.occupied_room_nights+=rn;result.room_nights+=paid?rn:0;result.complimentary_room_nights+=paid?0:rn;
  if(b.guests==null)result.unknown_guest_count++;else result.guest_nights+=b.guests*ds.length;
  if(direct.has(b.source))directNights+=rn;if(ota.has(b.source))otaNights+=rn;
  if(!sourceMap.has(b.source))sourceMap.set(b.source,{source:b.source,reservations:0,room_nights:0,known_revenue_paise:0,missing_revenue:0});
  const source=sourceMap.get(b.source);source.reservations++;source.room_nights+=rn;
  if(!k.revenue_confirmed){result.missing_revenue++;source.missing_revenue++;}
  if(!k.costs_confirmed)result.missing_costs++;
  const fraction=amount=>prorate(amount||0,b.check_in,b.check_out,start,end);
  if(k.revenue_confirmed){
   for(const key of Object.keys(mix))mix[key]+=fraction(k[`${key}_revenue_paise`]);
   result.known_room_revenue_paise+=fraction(k.room_revenue_paise);
   const revenue=['room','food','transfer','other'].reduce((n,key)=>n+fraction(k[`${key}_revenue_paise`]),0);
   result.known_stay_revenue_paise+=revenue;source.known_revenue_paise+=revenue;result.tax_paise+=fraction(k.tax_paise);
  }
  if(k.costs_confirmed)result.known_distribution_cost_paise+=fraction(k.commission_paise)+fraction(k.gateway_fee_paise);
  const f=financeFor(b);result.received_paise+=f.received_paise;result.balance_paise+=f.balance_paise||0;if(f.sale_amount_paise===null)result.unpriced++;
  for(const d of ds){
   d.occupied+=b.room_ids.length;d.sold+=paid?b.room_ids.length:0;
   d.room_revenue_paise=!k.revenue_confirmed||d.room_revenue_paise===null?null:d.room_revenue_paise+prorate(k.room_revenue_paise,b.check_in,b.check_out,d.date,d.date);
   for(const id of b.room_ids){const r=byRoom.get(id);if(r){r.occupied++;r.sold+=paid?1:0;}if(outages.has(`${id}/${d.date}`))result.capacity_conflicts++;}
  }
 }
 for(const d of series){d.occupancy_percent=divide(d.sold*100,d.available);if(d.occupied>d.available)result.capacity_conflicts++;}
 for(const r of roomRows)r.occupancy_percent=divide(r.sold*100,r.available);
 const ledger=(data.ledger||[]).filter(e=>!e.voided_at&&e.start_date<=end&&e.end_date>=start);
 const expenseRows={};let expenses=0,extra=0;
 for(const e of ledger){const amount=prorate(e.amount_paise,e.start_date,dateString(dateNumber(e.end_date)+1),start,end);if(e.kind==='expense'){expenses+=amount;expenseRows[e.category]=(expenseRows[e.category]||0)+amount;}else extra+=amount;}
 const cohorts=bookings.filter(b=>b.check_in>=start&&b.check_in<=end&&['confirmed','cancelled'].includes(b.status));
 const cancelled=cohorts.filter(b=>b.status==='cancelled'&&b.kpi?.stay_status!=='no_show').length,noShows=cohorts.filter(b=>b.status==='cancelled'&&b.kpi?.stay_status==='no_show').length;
 const months=[...new Set(series.map(d=>d.date.slice(0,7)+'-01'))];
 const reviewed=end<today&&!result.missing_revenue&&!result.missing_costs&&!result.unverified_stays&&!result.unpriced&&!result.capacity_conflicts&&months.every(month=>(data.periods||[]).some(p=>p.month===month&&p.bookings_complete&&p.costs_complete));
 const roomRevenue=result.missing_revenue?null:result.known_room_revenue_paise,total=result.missing_revenue?null:result.known_stay_revenue_paise+extra;
 const distribution=result.missing_costs?null:result.known_distribution_cost_paise;
 const profit=total===null||distribution===null?null:total-distribution-expenses;
 return {start,end,days,...result,occupancy_percent:divide(result.room_nights*100,result.available_room_nights),physical_occupancy_percent:divide(result.occupied_room_nights*100,result.available_room_nights),room_revenue_paise:roomRevenue,stay_revenue_paise:result.missing_revenue?null:result.known_stay_revenue_paise,total_revenue_paise:total,adr_paise:roomRevenue===null?null:divide(roomRevenue,result.room_nights),revpar_paise:roomRevenue===null?null:divide(roomRevenue,result.available_room_nights),trevpar_paise:total===null?null:divide(total,result.available_room_nights),distribution_cost_paise:distribution,expenses_paise:expenses,extra_income_paise:extra,operating_result_paise:profit,operating_margin_percent:profit===null?null:divide(profit*100,total),operating_cost_per_occupied_room_paise:distribution===null?null:divide(expenses+distribution,result.occupied_room_nights),average_stay_nights:divide(nightsTotal,result.reservations),average_lead_days:divide(leadTotal,leadCount),lead_known:leadCount,direct_share_percent:divide(directNights*100,result.occupied_room_nights),ota_share_percent:divide(otaNights*100,result.occupied_room_nights),cancelled,no_shows:noShows,cancellation_percent:divide(cancelled*100,cohorts.length),no_show_percent:divide(noShows*100,cohorts.length),arrival_cohort:cohorts.length,reviewed,series,rooms:roomRows,sources:[...sourceMap.values()].map(s=>({...s,revenue_paise:s.missing_revenue?null:s.known_revenue_paise})),mix,expense_categories:expenseRows,quality:quality.sort((a,b)=>a.check_in.localeCompare(b.check_in))};
}
export function buildKpiReport(data,range){
 return {range,current:summarize(data,range.start,range.end,range.mode,range.today),previous:summarize(data,range.previous_start,range.previous_end,range.mode,range.today),ledger:(data.ledger||[]).filter(e=>e.start_date<=range.end&&e.end_date>=range.start),periods:data.periods||[]};
}
