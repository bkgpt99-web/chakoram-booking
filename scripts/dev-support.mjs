import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {dbError} from '../server/core.mjs';
export async function createLocalDatabase(path){
  const db=new PGlite(path);
  await db.exec(`do $$ begin
    if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
    if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
    if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
  end $$;`);
  await db.exec(await readFile(new URL('../database/setup.sql',import.meta.url),'utf8'));
  const rpc=async(action,input={})=>{try{const r=await db.query('select ch_engine($1,$2::jsonb) as result',[action,JSON.stringify(input)]);return r.rows[0].result;}catch(e){throw dbError(e.message);}};
  return {db,rpc};
}
export async function seedDemo(db){
  await db.exec(`update ch_settings set booking_open=true,policy_reviewed=true,
    cancellation_policy='SAMPLE POLICY — for preview only. Cancel at least 7 days before arrival for a full refund. Later cancellations retain the first night. The owner must replace this sample policy before going live.' where id=1;
    insert into ch_room_nights(room_id,stay_date,is_open,note)
      select r.id,ds::date,true,'' from ch_rooms r cross join generate_series(
        (now() at time zone 'Asia/Kolkata')::date,
        (now() at time zone 'Asia/Kolkata')::date+75,interval '1 day') ds
    on conflict do nothing;
    insert into ch_room_nights(room_id,stay_date,is_open,note)
      select 'D2',ds::date,false,'Sample external booking' from generate_series(
        (now() at time zone 'Asia/Kolkata')::date+1,
        (now() at time zone 'Asia/Kolkata')::date+3,interval '1 day') ds
    on conflict(room_id,stay_date) do update set is_open=excluded.is_open,note=excluded.note;`);
}
export function demoGateway(db){return async(path,body)=>{
  if(path==='orders')return {id:`order_demo_${body.notes.booking_id}`,amount:body.amount};
  if(path.startsWith('payments/')){
    const id=decodeURIComponent(path.slice(9)).replace('pay_demo_','');
    const b=(await db.query('select * from ch_bookings where id=$1',[id])).rows[0];
    return {id:`pay_demo_${id}`,order_id:b.order_id,amount:b.deposit_paise,currency:'INR',status:'captured',captured:true,amount_refunded:0};
  }
  if(path.startsWith('orders/'))return {items:[]};
  throw new Error('Unknown local payment operation');
};}
