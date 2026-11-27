import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createLocalDatabase} from '../scripts/dev-support.mjs';
import {createApp,validateOwnerBooking} from '../server/core.mjs';
import {buildKpiReport,reportRange,prorate,validateKpiCapture,dateNumber,dateString} from '../server/kpi.mjs';
const kpi=(extra={})=>validateKpiCapture({booked_on:'2026-09-01',stay_status:'unverified',stay_kind:'paid',room_revenue_paise:90000,food_revenue_paise:10000,transfer_revenue_paise:0,other_revenue_paise:0,tax_paise:0,commission_paise:5000,gateway_fee_paise:0,revenue_confirmed:true,costs_confirmed:true,...extra});
const sample=(extra={})=>({id:randomUUID(),guest_name:'TEST GUEST',reference:'CH-TEST',source:'Direct',owner_entry:true,check_in:'2026-09-30',check_out:'2026-10-03',status:'confirmed',room_ids:['D1','P1'],guests:4,meal_plan:'cp',sale_amount_paise:100000,paid_paise:0,refunded_paise:0,offline_received_paise:20000,kpi:kpi(),...extra});
const dataset=(bookings=[],extra={})=>({bookings,rooms:[{id:'D1',name:'Deluxe'},{id:'P1',name:'Premium'}],outages:[],ledger:[],periods:[],...extra});
const range=()=>reportRange({start:'2026-10-01',end:'2026-10-02'},Error,'2026-11-27');
test('booked KPIs use room nights, split stay income and preserve whole-stay collections',()=>{
 const c=buildKpiReport(dataset([sample()]),range()).current;
 assert.equal(c.room_nights,4);assert.equal(c.available_room_nights,4);assert.equal(c.occupancy_percent,100);
 assert.equal(c.room_revenue_paise,60000);assert.equal(c.adr_paise,15000);assert.equal(c.revpar_paise,15000);
 assert.equal(c.stay_revenue_paise,66667);assert.equal(c.received_paise,20000);assert.equal(c.balance_paise,80000);
 assert.equal(c.average_stay_nights,3);assert.equal(c.average_lead_days,29);assert.equal(c.guest_nights,8);assert.equal(c.direct_share_percent,100);
});
test('paise allocation conserves totals over month boundaries and short ranges',()=>{
 for(const amount of [1,2,100001,1000000000]){
  const parts=['2026-09-30','2026-10-01','2026-10-02'].map(day=>prorate(amount,'2026-09-30','2026-10-03',day,day));
  assert.equal(parts.reduce((a,b)=>a+b,0),amount);assert.equal(prorate(amount,'2026-09-30','2026-10-03','2026-08-01','2026-08-31'),0);
 }
});
test('complimentary occupancy is separate, maintenance removes capacity and closed sales do not',()=>{
 const b=sample({room_ids:['D1'],kpi:kpi({stay_kind:'complimentary',room_revenue_paise:0,food_revenue_paise:100000})});
 const c=buildKpiReport(dataset([b],{outages:[{room_id:'P1',stay_date:'2026-10-01'}],calendar:[{is_open:false}]}),range()).current;
 assert.equal(c.available_room_nights,3);assert.equal(c.room_nights,0);assert.equal(c.occupied_room_nights,2);assert.equal(c.occupancy_percent,0);assert.equal(c.adr_paise,null);assert.equal(c.physical_occupancy_percent,200/3);
});
test('unknown financial data produces unavailable ratios, not zero or tariff-derived revenue',()=>{
 const c=buildKpiReport(dataset([sample({kpi:{},guests:null,meal_plan:null,sale_amount_paise:null,total_paise:999999})]),range()).current;
 for(const key of ['adr_paise','revpar_paise','total_revenue_paise','operating_result_paise'])assert.equal(c[key],null);
 assert.equal(c.known_room_revenue_paise,0);assert.equal(c.unknown_guest_count,1);assert.equal(c.unpriced,1);assert.ok(c.quality[0].missing.includes('Original booking date'));
});
test('actual excludes unverified and future stays and flags the missing arrival verification',()=>{
 const r=reportRange({start:'2026-10-01',end:'2026-10-31',mode:'actual'},Error,'2026-10-03');assert.equal(r.end,'2026-10-02');
 const c=buildKpiReport(dataset([sample(),sample({id:'checked',kpi:kpi({stay_status:'checked_out'}),room_ids:['P1']})]),r).current;
 assert.equal(c.reservations,1);assert.equal(c.room_nights,2);assert.equal(c.unverified_stays,1);
 assert.throws(()=>reportRange({start:'2026-10-03',end:'2026-10-04',mode:'actual'},Error,'2026-10-03'));
});
test('expenses are accrued by service period, commission deducted once and cancellations use arrival cohort',()=>{
 const b=sample({check_in:'2026-10-01',check_out:'2026-10-03'});
 const d=dataset([b,sample({status:'cancelled',check_in:'2026-10-01'}),sample({status:'cancelled',check_in:'2026-10-01',kpi:kpi({stay_status:'no_show'})}),sample({status:'held',check_in:'2026-10-01'})],{ledger:[{kind:'expense',category:'salary',amount_paise:31000,start_date:'2026-10-01',end_date:'2026-10-31'},{kind:'income',category:'other',amount_paise:1000,start_date:'2026-10-01',end_date:'2026-10-01'},{kind:'expense',amount_paise:999999,start_date:'2026-10-01',end_date:'2026-10-01',voided_at:'yes'}]});
 const c=buildKpiReport(d,range()).current;
 assert.equal(c.expenses_paise,2000);assert.equal(c.distribution_cost_paise,5000);assert.equal(c.total_revenue_paise,101000);assert.equal(c.operating_result_paise,94000);assert.equal(c.arrival_cohort,3);assert.equal(c.cancelled,1);assert.equal(c.no_shows,1);assert.equal(c.reviewed,false);
});
test('reviewed status requires completed past-period financial data and verified stays',()=>{
 const p={month:'2026-10-01',bookings_complete:true,costs_complete:true};
 const complete=sample({kpi:kpi({stay_status:'checked_out'})});
 assert.equal(buildKpiReport(dataset([complete],{periods:[p]}),range()).current.reviewed,true);
 assert.equal(buildKpiReport(dataset([sample()],{periods:[p]}),range()).current.reviewed,false);
 assert.equal(buildKpiReport(dataset([sample({kpi:kpi({stay_status:'checked_out',costs_confirmed:false})})],{periods:[p]}),range()).current.reviewed,false);
});
test('report date and money validation reject impossible dates, fractions and excessively wide periods',()=>{
 for(const start of ['2026-02-31','2026-1-01','invalid'])assert.throws(()=>reportRange({start,end:'2026-12-01'}));
 assert.throws(()=>reportRange({start:'2025-01-01',end:'2026-12-01'}));assert.throws(()=>validateKpiCapture({room_revenue_paise:1.1}));assert.throws(()=>validateKpiCapture({costs_confirmed:'true'}));
});
let s,db,today;const day=n=>dateString(dateNumber(today)+n);
const input=(extra={})=>({request_key:randomUUID(),guest_name:'OWNER KPI TEST',source:'Direct',room_ids:['D1','P1'],check_in:day(1),check_out:day(3),guests:4,meal_plan:'cp',sale_amount_paise:100000,advance_paise:20000,actor:'owner@test.example',...extra});
const dataKpi=(extra={})=>kpi({booked_on:today,...extra});
before(async()=>{s=await createLocalDatabase();db=s.db;today=(await db.query("select ((now() at time zone 'Asia/Kolkata')::date)::text today")).rows[0].today;await db.exec('alter role service_role bypassrls');});
beforeEach(async()=>{await db.exec('truncate ch_bookings,ch_room_nights,ch_kpi_ledger,ch_kpi_periods cascade');});
after(async()=>{await db?.close();});
test('owner capture is atomic, validated, revision guarded and retry-safe',async()=>{
 const i=input({kpi:dataKpi()}),b=await s.ownerRpc(validateOwnerBooking(i));assert.equal(b.kpi.room_revenue_paise,90000);
 assert.equal((await s.ownerRpc(validateOwnerBooking(i))).id,b.id);
 await assert.rejects(()=>s.ownerRpc({...i,kpi:dataKpi({commission_paise:1})}),{code:'OWNER_REQUEST_REUSED'});
 await assert.rejects(()=>s.ownerRpc(input({room_ids:['D2'],guests:2,kpi:dataKpi({room_revenue_paise:1})})),{code:'KPI_REVENUE_SPLIT'});
 assert.equal((await db.query('select count(*)::int n from ch_bookings')).rows[0].n,1);
 await assert.rejects(()=>s.kpiRpc('booking',{id:b.id,revision:b.owner_revision-1,kpi:dataKpi(),guests:4,meal_plan:'cp'}),{code:'OWNER_STALE'});
});
test('sale and KPI edits commit together, and legacy updates/refunds invalidate allocations',async()=>{
 let b=await s.ownerRpc(input({kpi:dataKpi()}));
 await assert.rejects(()=>s.financeRpc('save_sale',{id:b.id,revision:b.owner_revision,sale_amount_paise:200000,kpi:b.kpi}),{code:'KPI_REVENUE_SPLIT'});
 b=(await s.financeRpc('booking',{id:b.id})).booking;assert.equal(b.sale_amount_paise,100000);assert.equal(b.kpi.revenue_confirmed,true);
 b=(await s.financeRpc('save_sale',{id:b.id,revision:b.owner_revision,sale_amount_paise:200000,kpi:dataKpi({room_revenue_paise:190000})})).booking;assert.equal(b.kpi.revenue_confirmed,true);
 await db.query("select ch_payments('save_sale',$1)",[JSON.stringify({id:b.id,revision:b.owner_revision,sale_amount_paise:210000})]);
 b=(await s.financeRpc('booking',{id:b.id})).booking;assert.equal(b.kpi.revenue_confirmed,false);assert.equal(b.kpi.commission_paise,5000);
 await db.query('update ch_bookings set kpi=$2::jsonb where id=$1',[b.id,JSON.stringify(dataKpi({room_revenue_paise:200000}))]);
 await db.query('update ch_bookings set refunded_paise=1000 where id=$1',[b.id]);
 assert.equal((await s.financeRpc('booking',{id:b.id})).booking.kpi.revenue_confirmed,false);
});
test('old owner clients preserve KPI metadata and unknown history remains unknown',async()=>{
 const b=await s.ownerRpc(input({kpi:dataKpi()}));
 const edited=await s.ownerRpc({...input(),id:b.id,revision:b.owner_revision,guest_name:'UPDATED NAME'});assert.deepEqual(edited.kpi,b.kpi);
 const old=await s.ownerRpc(input({room_ids:['D2'],guests:null}));assert.deepEqual(old.kpi,{});
});
test('actual status requires valid dates and cancellation before no-show; guest and meal changes keep money',async()=>{
 let b=await s.ownerRpc(input({check_in:day(-4),check_out:day(-2),kpi:dataKpi({booked_on:day(-10)})}));
 const update={id:b.id,revision:b.owner_revision,guests:3,meal_plan:'ap',meal_plan_note:'',kpi:{...b.kpi,stay_status:'checked_out'}};
 b=await s.kpiRpc('booking',update);assert.equal(b.guests,3);assert.equal(b.meal_plan,'ap');assert.equal(b.kpi.stay_status,'checked_out');assert.equal(b.sale_amount_paise,100000);assert.equal(b.offline_received_paise,20000);
 await assert.rejects(()=>s.kpiRpc('booking',{...update,revision:b.owner_revision,kpi:{...b.kpi,stay_status:'no_show'}}),{code:'KPI_STAY_STATUS'});
 await s.rpc('admin_cancel',{id:b.id});b=(await s.financeRpc('booking',{id:b.id})).booking;
 b=await s.kpiRpc('booking',{...update,revision:b.owner_revision,kpi:{...b.kpi,stay_status:'no_show'}});assert.equal(b.kpi.stay_status,'no_show');
});
test('out of order is explicit, blocks bookings, reopens safely and conflicts atomically',async()=>{
 await s.kpiRpc('inventory',{start:day(1),end:day(2),room_ids:['D1'],is_open:false,out_of_order:true});
 await assert.rejects(()=>s.ownerRpc(input()),{code:'KPI_ROOM_OUT_OF_ORDER'});
 await s.rpc('admin_inventory',{start:day(1),end:day(2),room_ids:['D1'],is_open:true,note:''});
 let d=await s.kpiRpc('data',{start:today,end:day(4)});assert.equal(d.outages.length,0);
 await s.ownerRpc(input());
 await assert.rejects(()=>s.kpiRpc('inventory',{start:day(1),end:day(2),room_ids:['D1','D2'],is_open:false,out_of_order:true}),{code:'RESERVATION_CONFLICT'});
 d=await s.kpiRpc('data',{start:today,end:day(4)});assert.equal(d.outages.length,0);
});
test('ledger retries and void corrections are auditable and require new completeness review',async()=>{
 const month=today.slice(0,7)+'-01';await s.kpiRpc('review',{month,bookings_complete:true,costs_complete:true});
 const i={id:randomUUID(),kind:'expense',category:'salary',amount_paise:500000,start_date:today,end_date:today,note:'Test payroll',actor:'owner'};
 const e=await s.kpiRpc('ledger',i);assert.equal((await s.kpiRpc('ledger',i)).id,e.id);
 await assert.rejects(()=>s.kpiRpc('ledger',{...i,amount_paise:1}),{code:'KPI_ENTRY_REUSED'});
 assert.equal((await s.kpiRpc('data',{start:today,end:today})).periods[0].costs_complete,false);
 await assert.rejects(()=>s.kpiRpc('void',{id:e.id,revision:2,reason:'Wrong amount'}),{code:'KPI_STALE'});
 await s.kpiRpc('void',{id:e.id,revision:0,reason:'Wrong amount',actor:'owner'});assert.ok((await s.kpiRpc('data',{start:today,end:today})).ledger[0].voided_at);
});
test('KPI reads all matching history and strips private credentials',async()=>{
 const b=await s.ownerRpc(input());
 await db.query(`insert into ch_bookings select (jsonb_populate_record(null::ch_bookings,to_jsonb(b)||jsonb_build_object('id',gen_random_uuid(),'reference','TEST-'||n,'request_key',gen_random_uuid()))).* from ch_bookings b cross join generate_series(1,501) n where b.id=$1`,[b.id]);
 const d=await s.kpiRpc('data',{start:today,end:day(4)});assert.equal(d.bookings.length,502);assert.equal('token_hash' in d.bookings[0],false);assert.equal('request_key' in d.bookings[0],false);
});
test('KPI routes require owner session, reject foreign origins and assign the audit actor',async()=>{
 const env={SITE_URL:'https://book.example',ADMIN_EMAIL:'owner@example.com',RATE_LIMIT_SECRET:'local-test'},app=createApp(env,{...s,auth:async()=>({email:env.ADMIN_EMAIL,email_confirmed_at:'2026-01-01'})});
 const req=(path,body,auth=true,origin=env.SITE_URL)=>new Request(env.SITE_URL+'/api/admin/kpi/'+path,{method:body?'POST':'GET',headers:{...(auth?{cookie:'ch_access=test'}:{}),...(body?{'content-type':'application/json',origin}:{})},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await app(req(`report?start=${today}&end=${today}`,null,false))).status,401);
 assert.equal((await app(req('ledger',{},true,'https://evil.example'))).status,403);
 assert.equal((await app(req('report?start=2026-02-31&end=2026-03-01'))).status,400);
 const r=await app(req('ledger',{id:randomUUID(),kind:'expense',category:'food',start_date:today,end_date:today,amount_paise:100,note:'test',actor:'spoofed'}));assert.equal(r.status,200);assert.equal((await r.json()).created_by,env.ADMIN_EMAIL);
});
test('RLS and RPC grants protect KPI data while service role performs capture',async()=>{
 for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);await assert.rejects(()=>db.query('select * from ch_kpi_ledger'),/permission denied/);await assert.rejects(()=>db.query("select ch_kpi('data','{}')"),/permission denied/);await assert.rejects(()=>db.query("select ch_kpi_owner_booking('{}')"),/permission denied/);await db.exec('reset role');}
 await db.exec('set role service_role');const b=await s.ownerRpc(input({kpi:dataKpi()}));assert.ok(b.id);const d=await s.kpiRpc('data',{start:today,end:day(3)});assert.equal(d.bookings.length,1);await db.exec('reset role');
});
