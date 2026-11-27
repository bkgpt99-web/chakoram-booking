import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {calculateSalePaise,checkoutFor,stayNights,mealPlanLabel,isUpcomingBooking,bookingSourceLabel} from '../public/booking-tools.js';

test('sale calculator handles room nights, mixed rates, discounts and exact rounding',()=>{
 for(const [expression,paise] of [
  ['3200 × 3',960000],['(3500 × 5 + 3900) × 2',4280000],['3200 * 3 + 500 - 200',990000],
  ['(3200 * 3) * (1 - 10%)',864000],['0.1 + 0.2',30],['1 ÷ 3 * 3',100],
  ['1 / 200',1],['1,00,000 + 20,000.50',12000050],['(100 + 20) / 3',4000],
  ['0',0],['10000000',1000000000]
 ])assert.equal(calculateSalePaise(expression),paise,expression);
});
test('calculator rejects executable text, invalid arithmetic and out-of-range totals',()=>{
 for(const expression of ['', '1 / 0', '-1', '10000000.01','1e3','1,2','2(3)','(1+2','1+','Math.random()', 'globalThis.process.exit()', '1;alert(1)', '9'.repeat(161)])assert.throws(()=>calculateSalePaise(expression),undefined,expression);
});
test('nights and checkout handle month, year and leap-day boundaries without timezone drift',()=>{
 for(const [start,n,end] of [['2026-11-30',2,'2026-12-02'],['2026-12-31',1,'2027-01-01'],['2028-02-28',2,'2028-03-01'],['2027-02-28',1,'2027-03-01'],['2026-04-01',30,'2026-05-01']]){
  assert.equal(checkoutFor(start,n),end);assert.equal(stayNights(start,end),n);
 }
 for(const n of [0,-1,1.5,31,'',NaN])assert.equal(checkoutFor('2026-11-30',n),'');
 assert.equal(checkoutFor('2026-02-30',1),'');assert.equal(stayNights('','2026-11-30'),null);
});
test('actual owner date controls stay linked while opening a saved stay preserves its duration',async()=>{
 const source=await readFile(new URL('../public/admin.js',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('function updateManualCheckout('),source.indexOf('function updateManualMealPlan('));
 const fields={check_in:{value:'2026-12-31'},check_out:{value:'2027-01-03'},nights:{value:''}};
 const summary={};const context=vm.createContext({checkoutFor,stayNights,dateLabel:x=>x,manualCalculator:{updateStay(){}},$:id=>id==='manual-form'?{elements:fields}:summary});
 vm.runInContext(body,context);context.updateManualCheckout();assert.equal(fields.nights.value,'3');assert.equal(fields.check_out.value,'2027-01-03');
 fields.nights.value='5';context.updateManualCheckout('nights');assert.equal(fields.check_out.value,'2027-01-05');
 fields.check_in.value='2027-02-27';context.updateManualCheckout('check_in');assert.equal(fields.check_out.value,'2027-03-04');
 fields.check_out.value='2027-03-02';context.updateManualCheckout('check_out');assert.equal(fields.nights.value,'3');assert.match(summary.textContent,/3 nights/);
 fields.nights.value='';context.updateManualCheckout('nights');assert.equal(fields.check_out.value,'');
});
test('plan labels spell out meals and leave unknown legacy plans explicit',()=>{
 assert.match(mealPlanLabel('ep'),/Room only/);assert.match(mealPlanLabel('cp'),/Breakfast/);
 assert.match(mealPlanLabel('ap'),/Breakfast, lunch & dinner/);assert.equal(mealPlanLabel(null),'Meal plan not set');
 assert.equal(mealPlanLabel('package','Breakfast and transfers'),'Package — Breakfast and transfers');
});

test('upcoming arrivals include today and future dates, excluding past, cancelled and checked-in stays',()=>{
 const base={status:'confirmed',check_in:'2026-11-27',check_out:'2026-11-28',kpi:{}};
 assert.equal(isUpcomingBooking(base,'2026-11-27'),true);
 assert.equal(isUpcomingBooking({...base,check_in:'2027-01-01'},'2026-11-27'),true);
 assert.equal(isUpcomingBooking({...base,check_in:'2026-11-26'},'2026-11-27'),false);
 for(const status of ['cancelled','held','expired','payment_review'])assert.equal(isUpcomingBooking({...base,status},'2026-11-27'),false);
 for(const stay_status of ['in_house','checked_out','no_show'])assert.equal(isUpcomingBooking({...base,kpi:{stay_status}},'2026-11-27'),false);
 const rows=[{...base,id:'later',check_in:'2027-01-01'},{...base,id:'past',check_in:'2026-11-26'},{...base,id:'today'}];
 assert.deepEqual(rows.filter(b=>isUpcomingBooking(b,'2026-11-27')).sort((a,b)=>a.check_in.localeCompare(b.check_in)).map(b=>b.id),['today','later']);
 assert.equal(bookingSourceLabel('MMT/Goibibo'),'MakeMyTrip / Goibibo');
 assert.equal(bookingSourceLabel('website'),'Guest website booking');
});
