import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createECDH,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createLocalDatabase} from '../scripts/dev-support.mjs';
import {createApp,validateOwnerBooking,hash} from '../server/core.mjs';
import {createPushService,createNetlifyPush} from '../server/push.mjs';
import {financeFor,paymentNotificationFor} from '../server/payments.mjs';
import {rupeesToPaise} from '../public/owner-payments.js';
let s,db,day,push;
const email='owner@example.com',env={ADMIN_EMAIL:email,SITE_URL:'https://book.example.com',RATE_LIMIT_SECRET:'local-test',CONTEXT:'production'};
const user={email,email_confirmed_at:'2026-01-01'},policy='Test cancellation policy. Contact the property for booking changes and refunds.';
const date=n=>{const d=new Date(`${day}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const input=(extra={})=>({request_key:randomUUID(),guest_name:'SAMPLE GUEST',source:'Direct',room_ids:['D1','P1'],check_in:date(1),check_out:date(3),actor:email,...extra});
const raw=async id=>(await db.query('select * from ch_bookings where id=$1',[id])).rows[0];
const details=id=>s.financeRpc('booking',{id});
const pay=(b,amount,extra={})=>s.financeRpc('receipt',{id:b.id,revision:b.owner_revision,request_key:randomUUID(),amount_paise:amount,method:'cash',actor:email,...extra});
before(async()=>{
 s=await createLocalDatabase();db=s.db;day=(await db.query("select ((now() at time zone 'Asia/Kolkata')::date)::text as today")).rows[0].today;
 await db.exec('alter role service_role bypassrls');
 await s.rpc('admin_settings',{booking_open:true,deposit_percent:50,cancellation_policy:policy,policy_reviewed:true,room_types:[{id:'deluxe',rate_paise:320000,max_guests:3},{id:'premium',rate_paise:380000,max_guests:4}]});
 await s.rpc('admin_inventory',{room_ids:['D1','D2','D3','D4','D5','P1'],start:day,end:date(365),is_open:true,note:''});
});
beforeEach(async()=>{
 await db.exec('truncate ch_bookings,ch_push_subscriptions,ch_push_settings,ch_rate_limits cascade; update ch_payment_settings set reminders_enabled=true');
 push=createPushService(env,s.pushRpc,{paymentRpc:s.paymentReminderRpc,send:async()=>({statusCode:201})});
});
after(()=>db.close());
async function device(name='one'){
 const keys=await push.handle('prepare','POST',{},user),ecdh=createECDH('prime256v1');ecdh.generateKeys();
 return push.handle('subscribe','POST',{public_key:keys.public_key,label:name,subscription:{endpoint:`https://fcm.googleapis.com/fcm/send/${name}`,keys:{p256dh:ecdh.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}}},user);
}
async function website(){
 const stay={check_in:date(10),check_out:date(12),quantity:1,guests:2};
 const av=await s.rpc('availability',stay),r=av.rooms.find(r=>r.id==='deluxe');
 let b=await s.rpc('hold',{...stay,id:randomUUID(),reference:`CH-${randomUUID()}`,request_key:randomUUID(),token_hash:hash('sample'),room_type:'deluxe',guest_name:'WEBSITE GUEST',email:'sample@example.com',phone:'+919999999999',expected_total:r.total_paise,expected_deposit:r.deposit_paise,accepted_policy:policy});
 await s.rpc('attach_order',{id:b.id,order_id:`order_${b.id}`});
 return s.rpc('captured',{order_id:`order_${b.id}`,payment_id:`pay_${b.id}`,amount:b.deposit_paise,currency:'INR'});
}
async function claim(){
 await s.paymentReminderRpc('claim',{owner_email:email});
 // Keep tests independent of execution time while preserving the IST event date.
 await db.exec("update ch_payment_reminders set next_send_at=now()-interval '1 second',lease_until=null");
 return s.paymentReminderRpc('claim',{owner_email:email});
}

test('one mixed-room entry saves exact sale, advance and balance atomically, with safe retries',async()=>{
 const i=validateOwnerBooking(input({sale_amount_paise:1400001,advance_paise:200001}));
 const b=await s.ownerRpc({...i,actor:email}),d=await details(b.id);
 assert.equal(d.booking.balance_paise,1200000);assert.equal(d.booking.received_paise,200001);
 assert.equal(b.paid_paise,0);assert.equal(b.sale_amount_paise,1400001);assert.equal(b.room_type,null);
 assert.equal(d.receipts.length,1);assert.equal(d.receipts[0].id,b.id);
 assert.equal((await s.ownerRpc(i)).id,b.id);assert.equal((await details(b.id)).receipts.length,1);
 await assert.rejects(()=>s.ownerRpc({...i,advance_paise:1}),{code:'OWNER_REQUEST_REUSED'});
 await assert.rejects(()=>s.ownerRpc(input({sale_amount_paise:200,advance_paise:100})),{code:'RESERVATION_CONFLICT'});
 assert.equal((await db.query('select count(*)::int n from ch_booking_receipts')).rows[0].n,1);
});
test('unpriced legacy bookings are flagged, zero price is distinct, and invalid advances fail',async()=>{
 const b=await s.ownerRpc(input());assert.equal((await details(b.id)).booking.balance_paise,null);
 const list=await s.financeRpc('list',{scope:'unpriced'});assert.equal(list.total,1);assert.equal(list.summary.balance_paise,0);
 await assert.rejects(()=>pay(b,100),{code:'PAYMENT_INVALID_RECEIPT'});
 const z=await s.financeRpc('save_sale',{id:b.id,revision:b.owner_revision,sale_amount_paise:0});
 assert.equal(z.booking.balance_paise,0);assert.equal((await s.financeRpc('list',{})).total,0);
 for(const extra of [{sale_amount_paise:-1},{advance_paise:100},{sale_amount_paise:100,advance_paise:101},{sale_amount_paise:0.1},{advance_paise:'100'}])assert.throws(()=>validateOwnerBooking(input(extra)));
 assert.equal(rupeesToPaise('1000.01'),100001);assert.equal(rupeesToPaise(''),null);assert.equal(rupeesToPaise('',0),0);
 for(const value of ['1e3','-1','1.001','Infinity','10000000.01'])assert.throws(()=>rupeesToPaise(value));
});
test('collections are idempotent, revision guarded and never overcollect; void keeps an audit trail',async()=>{
 let b=await s.ownerRpc(input({sale_amount_paise:100000,advance_paise:10000}));
 const key=randomUUID(),payload={request_key:key,note:'Sample UPI reference',method:'upi'};
 let result=await pay(b,30000,payload);assert.equal(result.booking.balance_paise,60000);
 assert.equal((await pay(b,30000,payload)).receipts.length,2);
 await assert.rejects(()=>pay(b,40000,payload),{code:'PAYMENT_REQUEST_REUSED'});
 await assert.rejects(()=>pay(b,100),{code:'PAYMENT_STALE'});
 b=result.booking;await assert.rejects(()=>pay(b,60001),{code:'PAYMENT_INVALID_RECEIPT'});
 await assert.rejects(()=>s.financeRpc('save_sale',{id:b.id,revision:b.owner_revision,sale_amount_paise:1}),{code:'PAYMENT_INVALID_SALE'});
 result=await s.financeRpc('void',{id:b.id,revision:b.owner_revision,receipt_id:key,reason:'Duplicate entered',actor:email});
 assert.equal(result.booking.balance_paise,90000);assert.ok(result.receipts.find(r=>r.id===key).voided_at);
 assert.equal(result.receipts.find(r=>r.id===key).void_reason,'Duplicate entered');
 assert.equal((await s.financeRpc('void',{id:b.id,revision:b.owner_revision,receipt_id:key,reason:'retry'})).booking.balance_paise,90000);
 assert.equal((await db.query("select count(*)::int n from ch_audit where action='payment_entry_voided' and details->>'id'=$1",[b.id])).rows[0].n,1);
 result=await pay(result.booking,90000);assert.equal(result.booking.balance_paise,0);assert.equal((await s.financeRpc('list',{})).total,0);
 assert.equal(result.booking.paid_paise,0);
});
test('Razorpay and manual receipts combine without overwriting gateway history; refunds reopen the balance',async()=>{
 let b=await website();const before=await raw(b.id);let f=(await details(b.id)).booking;
 assert.equal(f.sale_amount_paise,b.total_paise);assert.equal(f.received_paise,b.paid_paise);
 await assert.rejects(()=>s.financeRpc('save_sale',{id:b.id,revision:b.owner_revision,sale_amount_paise:1}),{code:'PAYMENT_WEBSITE_PRICE'});
 f=(await pay(f,f.balance_paise)).booking;assert.equal(f.balance_paise,0);
 for(const key of ['total_paise','paid_paise','refunded_paise','deposit_paise','order_id','payment_id'])assert.equal(f[key],before[key]);
 await s.rpc('refund',{id:b.id,payment_id:b.payment_id,amount_refunded:10000});
 f=(await details(b.id)).booking;assert.equal(f.balance_paise,10000);assert.deepEqual(financeFor(f).received_paise,f.received_paise);
 await s.rpc('admin_cancel',{id:b.id});assert.equal((await s.financeRpc('list',{})).total,0);
 await assert.rejects(async()=>pay(await raw(b.id),100),{code:'PAYMENT_BOOKING_LOCKED'});
});
test('website report excludes owner and OTA entries, respects date/status filters and page totals',async()=>{
 const b=await website();await s.ownerRpc(input({source:'MMT/Goibibo'}));
 const r=await s.financeRpc('website_report',{limit:1});assert.equal(r.total,1);assert.equal(r.rows[0].id,b.id);
 assert.ok(!('token_hash' in r.rows[0]));assert.ok(!('request_key' in r.rows[0]));
 assert.equal((await s.financeRpc('website_report',{start:date(11)})).total,0);
 assert.equal((await s.financeRpc('website_report',{status:'confirmed',search:'website'})).total,1);
 await s.rpc('admin_cancel',{id:b.id});const cancelled=await s.financeRpc('website_report',{status:'cancelled'});
 assert.equal(cancelled.total,1);assert.equal(cancelled.summary.balance_paise,0);
});
test('payments query the entire history rather than the latest 500 reservation cards',async()=>{
 // Closed historic samples need no inventory allocation; verify pagination with >500 rows.
 await db.exec(`insert into ch_bookings(id,reference,request_key,token_hash,room_type,room_ids,check_in,check_out,guest_name,email,phone,guests,total_paise,deposit_paise,nightly_rates,policy,status,source,expires_at,owner_entry,sale_amount_paise)
 select gen_random_uuid(),'SAMPLE-'||i,gen_random_uuid(),'sample','deluxe',array['D1'],current_date-1000-i,current_date-999-i,'SAMPLE '||i,'','',1,100,100,'[]'::jsonb,'sample','confirmed','Direct',now(),true,100 from generate_series(1,505) i;`);
 const r=await s.financeRpc('list',{offset:500,limit:50,scope:'overdue'});assert.equal(r.total,505);assert.equal(r.rows.length,5);assert.equal(r.summary.balance_paise,50500);
});
test('IST reminder is due at 9am the day before each event, and reports current guest and balance',async()=>{
 const b=await s.ownerRpc(input({sale_amount_paise:100000,advance_paise:20000}));await device();
 const tasks=await claim();assert.equal(tasks.length,1);
 const t=tasks[0],current=await s.paymentReminderRpc('current',t);assert.equal(current.current,true);assert.equal(current.stage,'arrival');assert.equal(current.booking.guest_name,'SAMPLE GUEST');assert.equal(current.booking.balance_paise,80000);
 const time=(await db.query("select (due_at at time zone 'Asia/Kolkata')::text due,event_date::text from ch_payment_reminders")).rows[0];assert.equal(time.due,day+' 09:00:00');assert.equal(time.event_date,date(1));
 assert.equal((await s.paymentReminderRpc('claim',{owner_email:email})).length,0);
 await pay(await raw(b.id),80000);assert.equal((await s.paymentReminderRpc('current',t)).current,false);
 const p=paymentNotificationFor(current);assert.match(p.body,/SAMPLE GUEST/);assert.match(p.body,/800/);assert.equal(p.kind,'payment');
});
test('checkout reminder is separate; cancellation, date changes, disabled reminders and unpriced stays do not send',async()=>{
 let b=await s.ownerRpc(input({check_in:date(-2),check_out:date(1),sale_amount_paise:100000}));await device();
 let t=(await claim())[0];assert.equal((await s.paymentReminderRpc('current',t)).stage,'departure');
 await db.query('update ch_bookings set check_out=$1 where id=$2',[date(2),b.id]);assert.equal((await s.paymentReminderRpc('current',t)).current,false);
 await db.query('update ch_bookings set check_out=$1 where id=$2',[date(1),b.id]);
 await s.financeRpc('settings',{enabled:false});assert.equal((await s.paymentReminderRpc('current',t)).current,false);assert.equal((await s.paymentReminderRpc('claim',{owner_email:email})).length,0);
 await s.financeRpc('settings',{enabled:true});await s.rpc('admin_cancel',{id:b.id});assert.equal((await claim()).length,0);
 await s.ownerRpc(input());assert.equal((await claim()).length,0);
});
test('partial push delivery retries only the failed device and payment alerts are independent of CM tasks',async()=>{
 await s.ownerRpc(input({sale_amount_paise:100000}));await device('one');await device('two');await claim();
 await db.exec("update ch_payment_reminders set lease_until=null;update ch_push_tasks set resolved_at=now()");
 const sent=[];let fail=true;
 push=createPushService(env,s.pushRpc,{paymentRpc:s.paymentReminderRpc,send:async(sub,payload)=>{const p=JSON.parse(payload);assert.equal(p.kind,'payment');sent.push(sub.endpoint);if(fail&&sub.endpoint.endsWith('/two'))throw new Error('Sample delivery failure');}});
 assert.equal((await push.drain()).payment_reminders,1);assert.equal(sent.length,2);
 await db.exec("update ch_payment_reminders set next_send_at=now()-interval '1 second'");fail=false;
 await push.drain();assert.equal(sent.length,3);assert.ok(sent[2].endsWith('/two'));
 await push.drain();assert.equal(sent.length,3);
 assert.equal((await db.query('select count(*)::int n from ch_payment_reminder_deliveries')).rows[0].n,2);
});
test('preview and old Netlify deploys cannot claim payment tasks',async()=>{
 let calls=0;const payment=async()=>{calls++;return [];};
 for(const context of [{},{deploy:{context:'deploy-preview',published:false}},{deploy:{context:'production',published:false}}])assert.deepEqual(await createNetlifyPush(env,s.pushRpc,context,payment).drain(),{processed:0});
 assert.equal(calls,0);
});
test('payment routes require owner authentication, same-origin writes and server-assigned actor',async()=>{
 const b=await s.ownerRpc(input({sale_amount_paise:1000}));
 const app=createApp(env,{...s,auth:async()=>user});
 const req=(path,body,cookie='yes',origin=env.SITE_URL)=>new Request(`${env.SITE_URL}/api/admin/payments/${path}`,{method:body?'POST':'GET',headers:{...(cookie?{cookie:'ch_access='+cookie}:{}),...(body?{origin,'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await app(req('list',null,''))).status,401);
 assert.equal((await app(req('receipt',{id:b.id,revision:0,amount_paise:1},'yes','https://evil.example'))).status,403);
 assert.equal((await app(req('list?start=2026-02-31'))).status,400);
 assert.equal((await app(req('receipt',{id:b.id,revision:b.owner_revision,request_key:randomUUID(),amount_paise:1.1,method:'cash'}))).status,400);
 const response=await app(req('receipt',{id:b.id,revision:b.owner_revision,request_key:randomUUID(),amount_paise:100,method:'cash',actor:'attacker'}));
 assert.equal(response.status,200);assert.equal((await response.json()).receipts[0].created_by,email);
});
test('payment tables/RPCs deny anonymous access and service role can perform the full workflow',async()=>{
 for(const role of ['anon','authenticated']){
  await db.exec(`set role ${role}`);
  await assert.rejects(()=>db.query("select ch_payments('list','{}')"),/permission denied/);
  await assert.rejects(()=>db.query("select * from ch_booking_receipts"),/permission denied/);
  await assert.rejects(()=>db.query("select ch_payment_push('claim','{}')"),/permission denied/);
  await db.exec('reset role');
 }
 await db.exec('set role service_role');
 const b=await s.ownerRpc(input({sale_amount_paise:100000,advance_paise:10000}));
 assert.equal((await pay(b,10000)).booking.balance_paise,80000);
 assert.equal((await s.financeRpc('list',{actor:email})).total,1);
 assert.deepEqual(await s.paymentReminderRpc('claim',{owner_email:email}),[]);
 await db.exec('reset role');
});
test('payment notification opens the Payments reservation and uses a separate reminder tag',async()=>{
 const listeners={},shown=[];const sandbox={URL,self:{location:{origin:env.SITE_URL},addEventListener:(name,fn)=>listeners[name]=fn,registration:{showNotification:async(title,options)=>shown.push({title,...options})}}};
 vm.runInNewContext(await readFile(new URL('../public/owner-sw.js',import.meta.url),'utf8'),sandbox);
 let pending;const id=randomUUID();listeners.push({data:{json:()=>paymentNotificationFor({stage:'arrival',event_date:date(1),booking:{id,guest_name:'SAMPLE GUEST',balance_paise:10000,reference:'SAMPLE'}})},waitUntil:p=>pending=p});await pending;
 assert.equal(shown[0].data.url,`/admin?payment=${id}`);assert.match(shown[0].tag,/chakoram-payment/);
});

test('owner meal plans persist across create, edit, reports and old clients without changing payments',async()=>{
 const i=validateOwnerBooking(input({meal_plan:'package',meal_plan_note:'Breakfast and airport transfers',sale_amount_paise:1200000,advance_paise:200000}));
 let b=await s.ownerRpc(i);assert.equal(b.meal_plan,'package');assert.equal(b.meal_plan_note,i.meal_plan_note);
 assert.equal((await s.ownerRpc(i)).id,b.id);
 await assert.rejects(()=>s.ownerRpc({...i,meal_plan:'ep'}),{code:'OWNER_REQUEST_REUSED'});
 assert.equal((await s.ownerDashboard(date(1))).bookings.find(v=>v.id===b.id).meal_plan,'package');
 assert.equal((await s.financeRpc('list',{})).rows[0].meal_plan,'package');
 const saved=await details(b.id);
 const edit=extra=>validateOwnerBooking(input({id:b.id,revision:b.owner_revision,...extra}));
 b=await s.ownerRpc(edit({guest_name:'UPDATED GUEST'}));assert.equal(b.meal_plan,'package');assert.equal(b.meal_plan_note,i.meal_plan_note);
 const stale=edit({meal_plan:'cp'});
 b=await s.ownerRpc(edit({meal_plan:'ap'}));assert.equal(b.meal_plan,'ap');assert.equal(b.meal_plan_note,'');
 await assert.rejects(()=>s.ownerRpc(stale),{code:'OWNER_STALE'});
 const updated=await details(b.id);
 for(const k of ['sale_amount_paise','paid_paise','offline_received_paise','balance_paise'])assert.equal(updated.booking[k],saved.booking[k]);
 assert.equal(updated.receipts.length,saved.receipts.length);
 b=await s.ownerRpc(edit({meal_plan:''}));assert.equal(b.meal_plan,null);
});
test('invalid meal plans fail both API and database validation',async()=>{
 for(const extra of [{meal_plan:'unknown'},{meal_plan:42},{meal_plan:{}},{meal_plan_note:'a'.repeat(201)}]){
  assert.throws(()=>validateOwnerBooking(input(extra)));
  await assert.rejects(()=>s.ownerRpc(input(extra)),{code:'OWNER_INVALID_PLAN'});
 }
 assert.equal((await s.ownerRpc(input())).meal_plan,null);
});
test('arrival reminders read the latest plan at send time and departure reminders keep collection wording',async()=>{
 let b=await s.ownerRpc(input({sale_amount_paise:100000,meal_plan:'cp'}));await device();
 const task=(await claim())[0];let current=await s.paymentReminderRpc('current',task);
 assert.equal(current.booking.meal_plan,'cp');assert.match(paymentNotificationFor(current).body,/CP — Breakfast/);
 b=await s.ownerRpc(input({id:b.id,revision:b.owner_revision,meal_plan:'package',meal_plan_note:'All meals and transfers'}));
 current=await s.paymentReminderRpc('current',task);
 const arrival=paymentNotificationFor(current);assert.match(arrival.body,/SAMPLE GUEST · Package — All meals and transfers/);assert.match(arrival.body,/Balance/);
 assert.doesNotMatch(paymentNotificationFor({...current,stage:'departure'}).body,/Package/);
 assert.match(paymentNotificationFor({...current,booking:{...current.booking,meal_plan:null}}).body,/Meal plan not set/);
});
