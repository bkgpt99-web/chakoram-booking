import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createECDH,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createLocalDatabase} from '../scripts/dev-support.mjs';
import {createApp,hash} from '../server/core.mjs';
import {createPushService,validateSubscription,notificationFor,pushDatabaseError,createNetlifyPush} from '../server/push.mjs';
let db,rpc,pushRpc,day,push;
const email='owner@example.com',env={ADMIN_EMAIL:email,SITE_URL:'https://book.example.com',RATE_LIMIT_SECRET:'test-limit',CONTEXT:'production'};
const policy='Test cancellation policy: contact the property to arrange changes and refunds.';
const user={email,email_confirmed_at:'2026-01-01'};
const next=n=>{const d=new Date(`${day}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const row=async id=>(await db.query('select * from ch_push_tasks where booking_id=$1',[id])).rows[0];
before(async()=>{
 ({db,rpc,pushRpc}=await createLocalDatabase());
 day=(await db.query("select ((now() at time zone 'Asia/Kolkata')::date)::text as today")).rows[0].today;
 await rpc('admin_settings',{booking_open:true,deposit_percent:50,cancellation_policy:policy,policy_reviewed:true,room_types:[{id:'deluxe',rate_paise:320000,max_guests:2},{id:'premium',rate_paise:380000,max_guests:2}]});
 await rpc('admin_inventory',{room_ids:['D1','D2','D3','D4','D5','P1'],start:day,end:next(70),is_open:true,note:''});
});
beforeEach(async()=>{
 await db.exec('truncate ch_push_deliveries,ch_push_tasks,ch_bookings,ch_push_subscriptions,ch_push_settings,ch_rate_limits cascade');
 push=createPushService(env,pushRpc,{send:async()=>({statusCode:201})});
});
after(()=>db.close());
async function booking(action='hold',extra={}) {
 const stay={check_in:next(5),check_out:next(7),quantity:1,guests:2};
 const av=await rpc('availability',stay),room=av.rooms.find(r=>r.id==='deluxe');
 return rpc(action,{...stay,id:randomUUID(),reference:`CH-${randomUUID()}`,request_key:randomUUID(),token_hash:hash('test'),room_type:'deluxe',guest_name:'Private Guest',email:'private@example.com',phone:'+919999999999',expected_total:room.total_paise,expected_deposit:room.deposit_paise,accepted_policy:policy,...extra});
}
async function capture(b) {
 const order=`order_${b.id}`;await rpc('attach_order',{id:b.id,order_id:order});
 return rpc('captured',{order_id:order,payment_id:`pay_${b.id}`,amount:b.deposit_paise,currency:'INR'});
}
function subscription(name='phone') {
 const ecdh=createECDH('prime256v1');ecdh.generateKeys();
 return {endpoint:`https://fcm.googleapis.com/fcm/send/${name}`,keys:{p256dh:ecdh.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
}
async function device(name='phone') {
 const keys=await push.handle('prepare','POST',{},user);
 return push.handle('subscribe','POST',{subscription:subscription(name),public_key:keys.public_key,label:name},user);
}
const due=()=>db.exec("update ch_push_tasks set next_send_at=now()-interval '1 second',lease_until=null");
const req=(path,body,cookie='yes',origin=env.SITE_URL)=>new Request(`${env.SITE_URL}/api/admin/${path}`,{
 method:body?'POST':'GET',headers:{...(cookie?{cookie:`ch_access=${cookie}`} : {}),...(body?{origin,'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});

test('only a verified capture queues a website alert; replay does not duplicate it',async()=>{
 let b=await booking();assert.equal(await row(b.id),undefined);
 await rpc('attach_order',{id:b.id,order_id:`order_${b.id}`});
 await assert.rejects(()=>rpc('captured',{order_id:`order_${b.id}`,payment_id:`pay_${b.id}`,amount:1,currency:'INR'}));
 assert.equal(await row(b.id),undefined);
 b=await capture(b);assert.equal(b.status,'confirmed');assert.equal(b.cm_revision,1);
 assert.equal((await row(b.id)).kind,'confirmed');
 await capture(b);assert.equal((await row(b.id)).revision,1);
});

test('direct and OTA manual bookings are distinguished, and cancellation creates a new pending version',async()=>{
 const b=await booking('manual',{source:'phone'}),ota=await booking('manual',{source:'OTA'});
 assert.equal((await row(b.id)).kind,'manual');assert.equal((await row(ota.id)).kind,'external');
 await push.handle('ack','POST',{booking_id:b.id,revision:b.cm_revision},user);
 const cancelled=await rpc('admin_cancel',{id:b.id});
 assert.equal(cancelled.cm_revision,2);assert.equal(cancelled.synced_to_cm,false);
 assert.equal((await row(b.id)).kind,'cancelled');assert.equal((await row(b.id)).resolved_at,null);
 await assert.rejects(()=>push.handle('ack','POST',{booking_id:b.id,revision:1},user),{code:'PUSH_STALE'});
});

test('paid cancellation remains a cancellation alert despite its refund warning',async()=>{
 const b=await capture(await booking());await rpc('admin_cancel',{id:b.id});
 assert.equal((await row(b.id)).kind,'cancelled');
});

test('changed room dates preserve old allocation and reject a stale acknowledgement',async()=>{
 const b=await booking('manual');
 await db.query('update ch_bookings set check_out=$2 where id=$1',[b.id,next(8)]);
 const t=await row(b.id);assert.equal(t.revision,2);assert.equal(t.kind,'changed');
 assert.equal(t.previous_states[0].check_out,next(7));
 await assert.rejects(()=>push.markSynced({id:b.id,revision:1,synced:true},user,()=>assert.fail('fallback')),{code:'PUSH_STALE'});
 await push.markSynced({id:b.id,revision:2,synced:true},user,()=>assert.fail('fallback'));
 const saved=await rpc('get_booking',{id:b.id});assert.equal(saved.cm_updated_by,email);assert.ok(saved.cm_updated_at);
 assert.ok((await row(b.id)).resolved_at);
});

test('concurrent senders claim each task once; acknowledgement stops reminders',async()=>{
 await device();const b=await booking('manual');let sends=0;
 const sender=createPushService(env,pushRpc,{send:async()=>{sends++;}});
 await Promise.all([sender.drain(),sender.drain()]);assert.equal(sends,1);
 let t=await row(b.id);assert.equal(t.notification_count,1);
 assert.ok(new Date(t.next_send_at)-Date.now()>14*60000);
 await due();await sender.drain();assert.equal(sends,2);
 t=await row(b.id);assert.ok(new Date(t.next_send_at)-Date.now()>59*60000);
 await push.handle('ack','POST',{booking_id:b.id,revision:1},user);await due();await sender.drain();assert.equal(sends,2);
});

test('transient failure retries only the failed device, without losing the booking',async()=>{
 await device('good');await device('flaky');const b=await booking('manual');const calls={good:0,flaky:0};let fail=true;
 const sender=createPushService(env,pushRpc,{send:async s=>{const name=s.endpoint.split('/').at(-1);calls[name]++;if(name==='flaky'&&fail)throw Object.assign(new Error('Temporary'),{statusCode:503});}});
 await sender.drain();assert.equal((await row(b.id)).notification_count,0);assert.equal((await row(b.id)).attempts,1);
 assert.equal((await rpc('get_booking',{id:b.id})).status,'confirmed');
 fail=false;await due();await sender.drain();assert.deepEqual(calls,{good:1,flaky:2});assert.equal((await row(b.id)).notification_count,1);
});

test('expired subscriptions are removed while other devices continue',async()=>{
 await device('expired');await device('good');await booking('manual');
 const sender=createPushService(env,pushRpc,{send:async s=>{if(s.endpoint.endsWith('/expired'))throw Object.assign(new Error('Gone'),{statusCode:410});}});
 await sender.drain();const state=await push.handle('status','GET',{},user);
 assert.equal(state.subscriptions.length,1);assert.equal(state.subscriptions[0].label,'good');assert.ok(state.subscriptions[0].last_success_at);
});

test('expired lease cannot finish a new claim, and snoozing invalidates an in-flight claim',async()=>{
 await device();const b=await booking('manual');
 const [first]=await pushRpc('claim',{owner_email:email});
 await db.exec("update ch_push_tasks set lease_until=now()-interval '1 second'");
 const [second]=await pushRpc('claim',{owner_email:email});assert.notEqual(first.lease_token,second.lease_token);
 await pushRpc('finish',{booking_id:b.id,revision:1,lease_token:first.lease_token,success:true});assert.equal((await row(b.id)).notification_count,0);
 await push.handle('snooze','POST',{booking_id:b.id,revision:1},user);
 assert.equal((await pushRpc('current',{booking_id:b.id,revision:1,lease_token:second.lease_token})).current,false);
 assert.ok(new Date((await row(b.id)).next_send_at)-Date.now()>14*60000);
});

test('first-alert-only setting suppresses recurring reminders and can be re-enabled',async()=>{
 await device();const b=await booking('manual');
 await push.handle('settings','POST',{reminder_minutes:0},user);await push.drain();
 assert.equal((await row(b.id)).notification_count,1);assert.equal((await db.query('select next_send_at::text as next from ch_push_tasks where booking_id=$1',[b.id])).rows[0].next,'infinity');
 await push.handle('settings','POST',{reminder_minutes:30},user);
 assert.ok(new Date((await row(b.id)).next_send_at)-Date.now()>29*60000);
});

test('status contains no delivery secrets; non-owner, missing auth, and cross-origin calls are blocked',async()=>{
 const d=await device();await booking('manual');
 const app=createApp(env,{rpc,push,auth:async(_p,_m,_b,token)=>token==='yes'?user:{email:'stranger@example.com',email_confirmed_at:'2026-01-01'}});
 assert.equal((await app(req('push/status',null,null))).status,401);
 assert.equal((await app(req('push/status',null,'other'))).status,403);
 assert.equal((await app(req('push/unsubscribe',{id:d.id},'yes','https://evil.example'))).status,403);
 const res=await app(req('push/status'));assert.equal(res.status,200);const text=await res.text();
 for(const key of ['private_key','endpoint','p256dh','token_hash','Private Guest','private@example.com'])assert.equal(text.includes(key),false);
 assert.equal((await app(req('push/credentials',{}))).status,404);
 assert.equal((await app(req('push/test',{id:d.id}))).status,200);
 const elsewhere=await app(req('booking?id='+(await db.query('select id from ch_bookings limit 1')).rows[0].id));
 assert.equal(elsewhere.status,200);assert.equal((await elsewhere.text()).includes('token_hash'),false);
});

test('device ownership and the five-device cap are enforced',async()=>{
 const d=await device();await assert.rejects(()=>push.handle('test','POST',{id:d.id},{email:'other@example.com'}),{code:'NOT_FOUND'});
 for(let i=1;i<5;i++)await device(`phone-${i}`);
 await assert.rejects(()=>device('too-many'),{code:'PUSH_DEVICE_LIMIT'});
 await push.handle('unsubscribe','POST',{id:d.id},{email:'other@example.com'});
 assert.equal((await push.handle('status','GET',{},user)).subscriptions.length,5);
});

test('preview and demo deployments cannot send or register phone notifications',async()=>{
 await device();await booking('manual');let called=false;
 for(const options of [{env:{...env,CONTEXT:'deploy-preview'},settings:{}},{env,settings:{demo:true}}]) {
   const preview=createPushService(options.env,pushRpc,{...options.settings,send:async()=>{called=true;}});
   assert.equal((await preview.drain()).processed,0);
   await assert.rejects(()=>preview.handle('prepare','POST',{},user));
 }
 assert.equal(called,false);
});

test('subscription validation blocks arbitrary network destinations and malformed keys',()=>{
 const valid=subscription();assert.equal(validateSubscription(valid).endpoint,valid.endpoint);
 for(const endpoint of ['https://127.0.0.1/secret','http://fcm.googleapis.com/x','https://fcm.googleapis.com.attacker.test/x','https://fcm.googleapis.com:8443/x','https://user:pass@fcm.googleapis.com/x'])assert.throws(()=>validateSubscription({...valid,endpoint}));
 assert.throws(()=>validateSubscription({...valid,keys:{...valid.keys,p256dh:'A'.repeat(87)}}));
 assert.throws(()=>validateSubscription({...valid,keys:{...valid.keys,auth:'short'}}));
});

test('migration can be rerun without rotating keys or losing pending tasks; anonymous access is denied',async()=>{
 const d=await device();const b=await booking('manual');const key=(await pushRpc('credentials')).private_key;
 await db.exec(await readFile(new URL('../database/migrations/002_owner_push.sql',import.meta.url),'utf8'));
 assert.equal((await pushRpc('credentials')).private_key,key);assert.equal((await row(b.id)).revision,1);
 assert.equal((await push.handle('status','GET',{},user)).subscriptions[0].id,d.id);
 await db.exec('set role anon');
 try {for(const table of ['ch_push_settings','ch_push_subscriptions','ch_push_tasks','ch_push_deliveries'])await assert.rejects(()=>db.query(`select * from ${table}`));await assert.rejects(()=>db.query("select ch_push('credentials')"));}
 finally {await db.exec('reset role');}
});

test('installations without migration keep existing bookings and CM controls usable',async()=>{
 const unavailable=async()=>{throw Object.assign(new Error(),{pushDatabase:{code:'PGRST202'}});};
 const missing=createPushService(env,unavailable);assert.equal((await missing.drain()).setup_required,true);
 await assert.rejects(()=>missing.handle('status','GET',{},user),{code:'PUSH_MIGRATION_REQUIRED'});
 const b=await booking('manual');const result=await missing.markSynced({id:b.id,synced:true},user,()=>rpc('admin_sync',{id:b.id,synced:true}));
 assert.equal(result.synced_to_cm,true);assert.equal(pushDatabaseError({code:'42883'}).status,503);
});

test('phone payload excludes guest data; worker click stays on the owner desk and never acknowledges tasks',async()=>{
 const b=await booking('manual');const payload=notificationFor({booking:{...b,quantity:1},kind:'manual',revision:1,notification_count:0});
 assert.equal(JSON.stringify(payload).includes('Private Guest'),false);assert.equal(JSON.stringify(payload).includes('private@example.com'),false);
 const handlers={},shown=[],opened=[];
 const self={location:{origin:env.SITE_URL},addEventListener:(name,fn)=>handlers[name]=fn,
   registration:{showNotification:async(...args)=>shown.push(args)},clients:{matchAll:async()=>[],openWindow:async url=>opened.push(url)}};
 vm.runInNewContext(await readFile(new URL('../public/owner-sw.js',import.meta.url),'utf8'),{self,URL,encodeURIComponent});
 let work;handlers.push({data:{json:()=>payload},waitUntil:p=>{work=p;}});await work;assert.equal(shown.length,1);
 handlers.notificationclick({notification:{data:{url:'https://evil.example'},close(){}},waitUntil:p=>{work=p;}});await work;
 assert.deepEqual(opened,[`${env.SITE_URL}/admin`]);assert.equal(handlers.notificationclose,undefined);
 assert.equal((await row(b.id)).resolved_at,null);
});


test('Netlify runtime publication metadata gates delivery even when env CONTEXT is misleading',async()=>{
 for(const context of [{},{deploy:{context:'deploy-preview',published:false}},{deploy:{context:'production',published:false}}]){
   const sender=createNetlifyPush(env,pushRpc,context);
   assert.equal((await sender.handle('status','GET',{},user)).delivery_enabled,false);
 }
 const production=createNetlifyPush({...env,CONTEXT:undefined},pushRpc,{deploy:{context:'production',published:true}});
 assert.equal((await production.handle('status','GET',{},user)).delivery_enabled,true);
});
