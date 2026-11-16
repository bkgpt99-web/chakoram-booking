import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createLocalDatabase} from '../scripts/dev-support.mjs';
import {createApp,validateOwnerBooking,validateGuest} from '../server/core.mjs';
let db,rpc,ownerRpc,ownerDashboard,day;
const date=n=>{const d=new Date(`${day}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const input=(n,extra={})=>({request_key:randomUUID(),guest_name:'Sample Guest',source:'Direct',room_ids:['D1'],check_in:date(n),check_out:date(n+2),...extra});
const edit=(b,extra={})=>({id:b.id,revision:b.owner_revision,guest_name:b.guest_name,source:b.source,room_ids:b.room_ids,check_in:b.check_in,check_out:b.check_out,guests:b.guests,email:b.email,phone:b.phone,guest_note:b.guest_note,...extra});
before(async()=>{({db,rpc,ownerRpc,ownerDashboard}=await createLocalDatabase());day=(await db.query("select ((now() at time zone 'Asia/Kolkata')::date)::text as today")).rows[0].today;
 await db.exec("update ch_room_types set max_guests=case when id='premium' then 4 else 3 end;");});
after(()=>db.close());

test('name-only OTA entry reserves selected closed rooms and calendar displays all occupied nights',async()=>{
 const request=input(1,{source:'Booking.com'}),b=await ownerRpc(request);
 assert.equal(b.guest_name,'Sample Guest');assert.equal(b.email,'');assert.equal(b.phone,'');assert.equal(b.guests,null);
 assert.equal(b.status,'confirmed');assert.equal(b.paid_paise,0);assert.equal(b.owner_entry,true);
 assert.ok(!('token_hash' in b));assert.ok(!('request_key' in b));
 const dashboard=await rpc('admin_dashboard',{start:date(1)});
 for(const d of [date(1),date(2)])assert.equal(dashboard.calendar.find(c=>c.room_id==='D1'&&c.date===d).booking.guest_name,'Sample Guest');
 assert.equal(dashboard.calendar.find(c=>c.room_id==='D1'&&c.date===date(3)).booking,null);
 assert.equal((await ownerRpc(request)).id,b.id);
 await assert.rejects(()=>ownerRpc({...request,guest_name:'A different person'}),{code:'OWNER_REQUEST_REUSED'});
 await rpc('admin_inventory',{room_ids:['D1'],start:date(1),end:date(2),is_open:true});
 const av=await rpc('availability',{check_in:date(1),check_out:date(3),quantity:1,guests:1});
 assert.equal(av.rooms.find(r=>r.id==='deluxe').available,0);
});

test('editing moves nights atomically, preserves money and rejects stale overwrites',async()=>{
 let b=await ownerRpc(input(5));const original=b;
 await rpc('admin_sync',{id:b.id,synced:true});b=await rpc('get_booking',{id:b.id});
 b=await ownerRpc(edit(b,{guest_name:'Updated Guest Name',room_ids:['D2'],check_in:date(6),check_out:date(8),source:'Agoda'}));
 assert.equal(b.total_paise,original.total_paise);assert.equal(b.deposit_paise,original.deposit_paise);assert.equal(b.synced_to_cm,false);
 const dashboard=await rpc('admin_dashboard',{start:date(5)});
 assert.equal(dashboard.calendar.find(c=>c.room_id==='D1'&&c.date===date(5)).booking,null);
 assert.equal(dashboard.calendar.find(c=>c.room_id==='D2'&&c.date===date(6)).booking.guest_name,'Updated Guest Name');
 await assert.rejects(()=>ownerRpc(edit(original,{guest_name:'Stale edit'})),{code:'OWNER_STALE'});
 const task=(await db.query('select revision,previous_states from ch_push_tasks where booking_id=$1',[b.id])).rows[0];
 assert.equal(task.revision,b.cm_revision);assert.equal(task.previous_states.at(-1).room_ids[0],'D1');
});

test('overlapping creates and moves fail without changing the original reservation',async()=>{
 const occupied=await ownerRpc(input(10));const moving=await ownerRpc(input(14));
 await assert.rejects(()=>ownerRpc(input(11)),{code:'RESERVATION_CONFLICT'});
 await assert.rejects(()=>ownerRpc(edit(moving,{check_in:date(11),check_out:date(13)})),{code:'RESERVATION_CONFLICT'});
 assert.equal((await rpc('get_booking',{id:moving.id})).check_in,moving.check_in);
 const adjacent=await ownerRpc(input(12));assert.equal(adjacent.check_in,occupied.check_out);
});

test('active payment holds block owner entry; expired holds do not',async()=>{
 await rpc('admin_inventory',{room_ids:['P1'],start:date(20),end:date(21),is_open:true});
 await db.query("insert into ch_bookings(id,reference,request_key,token_hash,room_type,room_ids,check_in,check_out,guests,guest_name,email,phone,total_paise,deposit_paise,nightly_rates,policy,status,source,expires_at) values($1,$2,$1,'test','premium',array['P1'],$3,$4,1,'Payment guest','guest@example.com','12345678',760000,760000,'[]','Test policy','held','website',now()+interval '10 minutes')",[randomUUID(),'TEST-HOLD',date(20),date(22)]);
 await assert.rejects(()=>ownerRpc(input(20,{room_ids:['P1']})),{code:'RESERVATION_CONFLICT'});
 await db.exec("update ch_bookings set expires_at=now()-interval '1 minute' where reference='TEST-HOLD'");
 assert.equal((await ownerRpc(input(20,{room_ids:['P1']}))).status,'confirmed');
});

test('premium capacity, room identity, optional fields and past stays are handled',async()=>{
 const b=await ownerRpc(input(25,{room_ids:['P1'],guests:4}));assert.equal(b.guests,4);
 await assert.rejects(()=>ownerRpc(input(28,{room_ids:['P1'],guests:5})),{code:'INVALID_ROOM_OR_GUESTS'});
 await assert.rejects(()=>ownerRpc(input(28,{room_ids:['D1','P1']})),{code:'OWNER_MIXED_ROOMS'});
 await assert.rejects(()=>ownerRpc(input(28,{room_ids:['D1','D1']})),{code:'INVALID_ROOMS'});
 await assert.rejects(()=>ownerRpc(input(28,{guest_name:'   '})),{code:'OWNER_INVALID_GUEST'});
 assert.equal((await ownerRpc(input(-2))).check_in,date(-2));
 assert.equal(validateOwnerBooking(input(30)).guests,null);
 assert.throws(()=>validateOwnerBooking(input(30,{email:'bad'})));
 assert.throws(()=>validateGuest({...input(30),room_type:'deluxe',quantity:1,guests:2,expected_total:1,expected_deposit:1,token:'a'.repeat(64)}));
});

test('cancelled stays cannot be edited; manually closed inventory remains closed',async()=>{
 let b=await ownerRpc(input(35));await rpc('admin_cancel',{id:b.id});b=await rpc('get_booking',{id:b.id});
 await assert.rejects(()=>ownerRpc(edit(b)),{code:'OWNER_BOOKING_LOCKED'});
 const av=await rpc('availability',{check_in:date(35),check_out:date(37),quantity:1,guests:1});
 assert.equal(av.rooms.find(r=>r.id==='deluxe').available,0);
});

test('paid website booking edits preserve payment, agreed price and policy',async()=>{
 let b=await ownerRpc(input(40));
 await db.query("update ch_bookings set source='website',owner_entry=false,order_id='order_paid',payment_id='pay_paid',paid_paise=total_paise where id=$1",[b.id]);
 b=await rpc('get_booking',{id:b.id});const updated=await ownerRpc(edit(b,{guest_name:'Corrected Name',room_ids:['D3']}));
 for(const key of ['order_id','payment_id','paid_paise','total_paise','deposit_paise','refunded_paise','policy'])assert.deepEqual(updated[key],b[key]);
 await assert.rejects(()=>ownerRpc(edit(updated,{source:'Direct'})),{code:'OWNER_SOURCE_LOCKED'});
});

test('owner API requires owner auth and same origin; private fields are never returned',async()=>{
 const prod=createApp({SITE_URL:'https://book.example.com',ADMIN_EMAIL:'owner@example.com'},{rpc,ownerRpc,auth:async()=>({email:'not-owner@example.com',email_confirmed_at:'2026-01-01'})});
 const request=(origin,cookie)=>new Request('https://book.example.com/api/admin/save-booking',{method:'POST',headers:{origin,'content-type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(input(45))});
 assert.equal((await prod(request('https://book.example.com'))).status,401);
 assert.equal((await prod(request('https://book.example.com','ch_access=wrong-user'))).status,403);
 assert.equal((await prod(request('https://evil.example','ch_access=wrong-user'))).status,403);
 const demo=createApp({}, {rpc,ownerRpc,demo:true});
 const response=await demo(new Request('http://localhost/api/admin/save-booking',{method:'POST',headers:{origin:'http://localhost','content-type':'application/json',cookie:'ch_access=local-demo'},body:JSON.stringify(input(48))}));
 assert.equal(response.status,200);const {booking}=await response.json();assert.ok(!('token_hash' in booking));assert.ok(!('request_key' in booking));
 for(const role of ['anon','authenticated']){
  await db.exec(`set role ${role}`);
  await assert.rejects(()=>db.query("select ch_owner_booking('{}'::jsonb)"));
  await assert.rejects(()=>db.query('select guest_name from ch_bookings'));
  await db.exec('reset role');
 }
});

test('service role can save through invoker grants and RLS remains enabled',async()=>{
 await db.exec('alter role service_role bypassrls; set role service_role');
 const b=await ownerRpc(input(55));assert.equal(b.status,'confirmed');
 await db.exec('reset role');
 const tables=(await db.query("select relrowsecurity from pg_class where oid='ch_bookings'::regclass")).rows;
 assert.equal(tables[0].relrowsecurity,true);
});

test('month calendar includes every day in short, long and leap-year months',async()=>{
 for(const [month,days] of [['2026-11-01',30],['2026-12-01',31],['2027-02-01',28],['2028-02-01',29]]){
  const d=await ownerDashboard(month);assert.equal(d.calendar.length,6*days);
  assert.equal(d.month_start,month);assert.equal(d.month_end,`${month.slice(0,8)}${days}`);
  assert.ok(d.bookings.every(b=>!('token_hash' in b)&&!('request_key' in b)));
 }
 await db.exec('set role authenticated');
 await assert.rejects(()=>ownerDashboard('2026-11-01'));
 await db.exec('reset role');
});
