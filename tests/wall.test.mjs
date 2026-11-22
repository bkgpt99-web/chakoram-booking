import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createECDH,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createLocalDatabase} from '../scripts/dev-support.mjs';
import {createApp} from '../server/core.mjs';
import {createPushService,createNetlifyPush} from '../server/push.mjs';
import {wallNotificationFor} from '../server/wall.mjs';
let s,db,day,push;
const email='owner@example.com',user={email,email_confirmed_at:'2026-01-01'},env={ADMIN_EMAIL:email,SITE_URL:'https://book.example.com',RATE_LIMIT_SECRET:'local-wall',CONTEXT:'production'};
const date=n=>{const d=new Date(`${day}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const input=(extra={})=>({request_key:randomUUID(),guest_name:'SAMPLE WALL GUEST',room_ids:['D1','P1'],source:'Agoda',check_in:date(2),check_out:date(4),...extra});
const row=id=>s.wallRpc('booking',{booking_id:id});
const ack=(task,updated=true)=>s.wallRpc('ack',{...task,updated,owner_email:email});
const raw=async id=>(await db.query('select * from ch_bookings where id=$1',[id])).rows[0];
const edit=(b,extra={})=>s.ownerRpc({id:b.id,revision:b.owner_revision,guest_name:b.guest_name,room_ids:b.room_ids,source:b.source,check_in:b.check_in,check_out:b.check_out,...extra});
before(async()=>{s=await createLocalDatabase();db=s.db;day=(await db.query("select ((now() at time zone 'Asia/Kolkata')::date)::text as today")).rows[0].today;await db.exec('alter role service_role bypassrls');});
beforeEach(async()=>{await db.exec('truncate ch_bookings,ch_push_subscriptions,ch_push_settings,ch_rate_limits cascade;update ch_wall_settings set reminder_minutes=60');push=createPushService(env,s.pushRpc,{wallRpc:s.wallRpc,send:async()=>({statusCode:201})});});
after(()=>db.close());
async function device(name='one'){
 const keys=await push.handle('prepare','POST',{},user),ecdh=createECDH('prime256v1');ecdh.generateKeys();
 return push.handle('subscribe','POST',{public_key:keys.public_key,label:name,subscription:{endpoint:`https://fcm.googleapis.com/fcm/send/${name}`,keys:{p256dh:ecdh.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}}},user);
}
test('wall and Yanolja acknowledgements are independent in both directions',async()=>{
 let b=await s.ownerRpc(input());const task=await row(b.id);assert.equal(task.pending,true);
 await s.pushRpc('ack',{booking_id:b.id,revision:b.cm_revision,synced:true,owner_email:email});
 assert.equal((await row(b.id)).pending,true);await ack(task);assert.equal((await row(b.id)).pending,false);assert.equal((await raw(b.id)).synced_to_cm,true);
 await s.pushRpc('ack',{booking_id:b.id,revision:b.cm_revision,synced:false,owner_email:email});assert.equal((await row(b.id)).pending,false);
 await ack(await row(b.id),false);await ack(await row(b.id));assert.equal((await raw(b.id)).synced_to_cm,false);
});
test('guest name, room/date changes and cancellation reopen the wall task; money changes do not',async()=>{
 let b=await s.ownerRpc(input({sale_amount_paise:100000})),task=await row(b.id);await ack(task);
 b=await edit(b,{guest_name:'RENAMED SAMPLE'});let next=await row(b.id);assert.equal(next.revision,task.revision+1);assert.equal(next.pending,true);
 await assert.rejects(()=>ack(task),{code:'WALL_STALE'});await ack(next);
 b=(await s.financeRpc('receipt',{id:b.id,revision:b.owner_revision,request_key:randomUUID(),amount_paise:10000,method:'cash',actor:email})).booking;
 assert.equal((await row(b.id)).pending,false);
 b=await edit(b,{check_in:date(3),check_out:date(6),room_ids:['D2']});next=await row(b.id);assert.equal(next.pending,true);await ack(next);
 await s.rpc('admin_cancel',{id:b.id});const status=await s.wallRpc('status');assert.equal(status.tasks[0].kind,'cancelled');assert.equal(status.tasks[0].guest_name,'RENAMED SAMPLE');assert.equal(status.tasks[0].previous_states.at(-1).room_ids[0],'D2');
});
test('wall tasks have their own snooze, repeat interval and revision leases',async()=>{
 const b=await s.ownerRpc(input());await device();let task=(await s.wallRpc('claim',{owner_email:email}))[0];
 assert.equal((await s.wallRpc('current',task)).current,true);assert.equal((await s.wallRpc('claim',{owner_email:email})).length,0);
 await s.wallRpc('snooze',task);assert.equal((await s.wallRpc('current',task)).current,false);assert.equal((await s.wallRpc('claim',{owner_email:email})).length,0);
 await db.exec("update ch_wall_tasks set next_send_at=now()-interval '1 second'");task=(await s.wallRpc('claim',{owner_email:email}))[0];
 await s.wallRpc('settings',{reminder_minutes:0});await s.wallRpc('finish',{...task,success:true});assert.equal((await s.wallRpc('claim',{owner_email:email})).length,0);
 await s.wallRpc('settings',{reminder_minutes:30});const timing=(await db.query('select extract(epoch from next_send_at-now()) as seconds from ch_wall_tasks')).rows[0];assert.ok(timing.seconds>1790&&timing.seconds<=1800);
 const changed=await edit(await raw(b.id),{guest_name:'CHANGED AGAIN'});assert.equal((await row(changed.id)).pending,true);assert.equal((await s.wallRpc('current',task)).current,false);
});
test('wall reminders send after CM completion, retry only failed devices, and stop after wall acknowledgement',async()=>{
 const b=await s.ownerRpc(input());await device('one');await device('two');await s.pushRpc('ack',{booking_id:b.id,revision:b.cm_revision,synced:true,owner_email:email});
 const sent=[];let fail=true;push=createPushService(env,s.pushRpc,{wallRpc:s.wallRpc,send:async(sub,payload)=>{const p=JSON.parse(payload);assert.equal(p.kind,'wall');assert.match(p.body,/SAMPLE WALL GUEST/);sent.push(sub.endpoint);if(fail&&sub.endpoint.endsWith('/two'))throw new Error('Sample failure');}});
 assert.equal((await push.drain()).wall_reminders,1);assert.equal(sent.length,2);
 await db.exec("update ch_wall_tasks set next_send_at=now()-interval '1 second'");fail=false;await push.drain();assert.equal(sent.length,3);assert.ok(sent.at(-1).endsWith('/two'));
 await ack(await row(b.id));await db.exec("update ch_wall_tasks set next_send_at=now()-interval '1 second'");await push.drain();assert.equal(sent.length,3);
});
test('existing current/upcoming bookings are queued once without changing bookings or already-completed walls',async()=>{
 const b=await s.ownerRpc(input());await ack(await row(b.id));
 const old=await s.ownerRpc(input({check_in:date(-4),check_out:date(-2)}));assert.equal((await s.wallRpc('status')).pending_count,0);
 await db.query('delete from ch_wall_tasks where booking_id=$1',[b.id]);const before=await raw(b.id);
 const migration=await readFile(new URL('../supabase/migrations/20261122104009_owner_booking_wall.sql',import.meta.url),'utf8');await db.exec(migration);
 assert.deepEqual(await raw(b.id),before);assert.equal((await row(b.id)).pending,true);assert.equal((await s.wallRpc('status')).pending_count,1);
 await ack(await row(b.id));await db.exec(migration);assert.equal((await row(b.id)).pending,false);assert.equal((await s.wallRpc('status')).pending_count,0);assert.ok(await row(old.id));
});
test('anonymous roles cannot read wall data, while service role supports the owner workflow',async()=>{
 for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);await assert.rejects(()=>db.query("select ch_wall('status','{}')"),/permission denied/);await assert.rejects(()=>db.query('select * from ch_wall_tasks'),/permission denied/);await db.exec('reset role');}
 await db.exec('set role service_role');const b=await s.ownerRpc(input());await ack(await row(b.id));assert.equal((await row(b.id)).pending,false);await db.exec('reset role');
});
test('wall endpoints require verified owner and same-origin writes; actor is supplied by server',async()=>{
 const b=await s.ownerRpc(input()),task=await row(b.id),app=createApp(env,{...s,auth:async()=>user});
 const req=(action,body,cookie=true,origin=env.SITE_URL)=>new Request(`${env.SITE_URL}/api/admin/wall/${action}`,{method:body?'POST':'GET',headers:{...(cookie?{cookie:'ch_access=yes'}:{}),...(body?{origin,'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await app(req('status',null,false))).status,401);assert.equal((await app(req('ack',{...task,updated:true},true,'https://evil.example'))).status,403);
 assert.equal((await app(req('ack',{...task,updated:true,owner_email:'attacker'}))).status,200);
 assert.equal((await db.query('select resolved_by from ch_wall_tasks where booking_id=$1',[b.id])).rows[0].resolved_by,email);
});
test('wall notification uses its own tag and deep link; preview deploys never claim tasks',async()=>{
 let called=0;assert.deepEqual(await createNetlifyPush(env,s.pushRpc,{deploy:{published:false,context:'production'}},undefined,async()=>{called++;}).drain(),{processed:0});assert.equal(called,0);
 const listeners={},shown=[];const sandbox={URL,self:{location:{origin:env.SITE_URL},addEventListener:(n,fn)=>listeners[n]=fn,registration:{showNotification:async(title,o)=>shown.push(o)}}};
 vm.runInNewContext(await readFile(new URL('../public/owner-sw.js',import.meta.url),'utf8'),sandbox);
 const id=randomUUID();let pending;listeners.push({data:{json:()=>wallNotificationFor({kind:'cancelled',booking:{id,guest_name:'SAMPLE',reference:'SAMPLE',room_ids:['D1'],check_in:date(1),check_out:date(2)}})},waitUntil:p=>pending=p});await pending;
 assert.equal(shown[0].tag,`chakoram-wall-${id}`);assert.equal(shown[0].data.url,`/admin?wall=${id}`);
});
