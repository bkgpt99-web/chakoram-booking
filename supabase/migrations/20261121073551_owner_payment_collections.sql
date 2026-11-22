-- Owner sale/receipt ledger and collection reminders. Gateway fields stay authoritative.
begin;
alter table public.ch_bookings add column if not exists sale_amount_paise integer
 check(sale_amount_paise between 0 and 1000000000);
alter table public.ch_bookings add column if not exists offline_received_paise integer not null default 0
 check(offline_received_paise between 0 and 1000000000);
create table if not exists public.ch_booking_receipts (
 id uuid primary key, booking_id uuid not null references public.ch_bookings(id),
 amount_paise integer not null check(amount_paise>0 and amount_paise<=1000000000),
 method text not null check(method in ('cash','upi','bank','ota','other')),
 note text not null default '' check(length(note)<=300),
 created_at timestamptz not null default now(),created_by text not null,
 voided_at timestamptz,voided_by text,void_reason text
);
create index if not exists ch_receipts_booking on public.ch_booking_receipts(booking_id,created_at);
create table if not exists public.ch_payment_settings (
 id integer primary key check(id=1),reminders_enabled boolean not null default true
);
insert into public.ch_payment_settings(id) values(1) on conflict do nothing;
create table if not exists public.ch_payment_reminders (
 id uuid primary key default gen_random_uuid(),booking_id uuid not null references public.ch_bookings(id),
 stage text not null check(stage in ('arrival','departure')),event_date date not null,
 due_at timestamptz not null,next_send_at timestamptz not null,
 sent_at timestamptz,lease_token uuid,lease_until timestamptz,attempts integer not null default 0,
 unique(booking_id,stage,event_date)
);
create index if not exists ch_payment_reminders_due on public.ch_payment_reminders(next_send_at) where sent_at is null;
create table if not exists public.ch_payment_reminder_deliveries (
 reminder_id uuid not null references public.ch_payment_reminders(id) on delete cascade,
 subscription_id uuid not null references public.ch_push_subscriptions(id) on delete cascade,
 sent_at timestamptz not null default now(),primary key(reminder_id,subscription_id)
);

create or replace function public.ch_booking_finance(b public.ch_bookings)
returns jsonb language sql immutable security invoker set search_path=public,pg_temp as $$
 with amounts as (select coalesce(b.sale_amount_paise,case when b.source='website' and not b.owner_entry then b.total_paise end) sale,
   greatest(0,b.paid_paise::bigint-b.refunded_paise) gateway,b.offline_received_paise::bigint offline)
 select jsonb_build_object('sale_amount_paise',sale,'gateway_received_paise',gateway,
   'offline_received_paise',offline,'received_paise',gateway+offline,
   'balance_paise',case when sale is null then null else greatest(0,sale-gateway-offline) end,
   'credit_paise',case when sale is null then 0 else greatest(0,gateway+offline-sale) end) from amounts;
$$;

create or replace function public.ch_payments(p_action text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare
 b ch_bookings%rowtype;r ch_booking_receipts%rowtype;f jsonb;result jsonb;
 actor text:=coalesce(p_input->>'actor','owner');v_amount integer;v_id uuid;
 page_size integer:=least(100,greatest(1,coalesce((p_input->>'limit')::integer,50)));
 page_offset integer:=greatest(0,coalesce((p_input->>'offset')::integer,0));
 a date:=nullif(p_input->>'start','')::date;z date:=nullif(p_input->>'end','')::date;
 scope text:=coalesce(p_input->>'scope','all');term text:=lower(coalesce(p_input->>'search',''));
 today date:=(now() at time zone 'Asia/Kolkata')::date;
begin
 if a is not null and z is not null and z<a then raise exception 'PAYMENT_FILTER_DATES'; end if;
 if p_action in ('list','website_report') then
   with rows as (
     select bk.*,ch_booking_finance(bk) finance,
       case when bk.status='held' and bk.expires_at<=now() then 'expired' else bk.status end display_status
     from ch_bookings bk
   ), filtered as (
     select * from rows where
       (a is null or check_in>=a) and (z is null or check_in<=z) and
       (term='' or position(term in lower(guest_name||' '||reference||' '||source))>0) and
       case when p_action='website_report' then source='website' and not owner_entry
         and (coalesce(p_input->>'status','all')='all' or display_status=p_input->>'status')
       else status='confirmed' and ((finance->>'balance_paise')::integer>0 or finance->>'sale_amount_paise' is null)
         and case scope when 'arrival' then check_in=today+1 when 'departure' then check_out=today+1
           when 'inhouse' then check_in<=today and check_out>today when 'overdue' then check_out<=today
           when 'unpriced' then finance->>'sale_amount_paise' is null else true end end
   ), page as (
     select * from filtered order by case when check_out<=today then 0 when check_in<=today then 1 else 2 end,check_in,id
     limit page_size offset page_offset
   )
   select jsonb_build_object('total',(select count(*) from filtered),'offset',page_offset,'limit',page_size,
     'summary',(select jsonb_build_object('sale_paise',coalesce(sum((finance->>'sale_amount_paise')::bigint),0),
       'received_paise',coalesce(sum((finance->>'received_paise')::bigint),0),
       'balance_paise',coalesce(sum((finance->>'balance_paise')::bigint) filter(where status='confirmed'),0),
       'unpriced',count(*) filter(where finance->>'sale_amount_paise' is null),
       'confirmed',count(*) filter(where status='confirmed')) from filtered),
     'reminders_enabled',(select reminders_enabled from ch_payment_settings where id=1),
     'device_count',(select count(*) from ch_push_subscriptions where owner_email=lower(actor)),
     'rows',(select coalesce(jsonb_agg((to_jsonb(page)-'token_hash'-'request_key'-'finance')||finance),'[]'::jsonb) from page)) into result;
   return result;
 elsif p_action='booking' then
   select * into b from ch_bookings where id=(p_input->>'id')::uuid;
   if not found then raise exception 'NOT_FOUND'; end if;
   return jsonb_build_object('booking',(to_jsonb(b)-'token_hash'-'request_key')||ch_booking_finance(b),
     'receipts',(select coalesce(jsonb_agg(to_jsonb(x) order by created_at desc),'[]'::jsonb) from ch_booking_receipts x where booking_id=b.id));
 elsif p_action='settings' then
   if jsonb_typeof(p_input->'enabled') is distinct from 'boolean' then raise exception 'INVALID_REQUEST'; end if;
   update ch_payment_settings set reminders_enabled=(p_input->>'enabled')::boolean where id=1;
   insert into ch_audit(action,details) values('payment_reminders_setting',jsonb_build_object('actor',actor,'enabled',p_input->'enabled'));
   return jsonb_build_object('ok',true);
 end if;
 if p_action not in ('save_sale','receipt','void') then raise exception 'INVALID_REQUEST'; end if;
 perform 1 from ch_settings where id=1 for update;
 select * into b from ch_bookings where id=(p_input->>'id')::uuid for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 if p_action='receipt' then
   v_id:=(p_input->>'request_key')::uuid;v_amount:=(p_input->>'amount_paise')::integer;
   select * into r from ch_booking_receipts where id=v_id;
   if found then
     if (r.booking_id,r.amount_paise,r.method,r.note) is distinct from
       (b.id,v_amount,p_input->>'method',coalesce(p_input->>'note','')) then raise exception 'PAYMENT_REQUEST_REUSED'; end if;
     return ch_payments('booking',jsonb_build_object('id',b.id));
   end if;
 elsif p_action='void' then
   select * into r from ch_booking_receipts where id=(p_input->>'receipt_id')::uuid and booking_id=b.id;
   if not found then raise exception 'NOT_FOUND'; end if;
   if r.voided_at is not null then return ch_payments('booking',jsonb_build_object('id',b.id)); end if;
 end if;
 if b.owner_revision is distinct from (p_input->>'revision')::integer then raise exception 'PAYMENT_STALE'; end if;
 if b.status<>'confirmed' and p_action<>'void' then raise exception 'PAYMENT_BOOKING_LOCKED'; end if;
 f:=ch_booking_finance(b);
 if p_action='save_sale' then
   if b.source='website' and not b.owner_entry then raise exception 'PAYMENT_WEBSITE_PRICE'; end if;
   v_amount:=(p_input->>'sale_amount_paise')::integer;
   if v_amount is null or v_amount<0 or v_amount>1000000000 or v_amount<(f->>'received_paise')::integer then raise exception 'PAYMENT_INVALID_SALE'; end if;
   update ch_bookings set sale_amount_paise=v_amount where id=b.id;
   insert into ch_audit(action,details) values('sale_amount_updated',jsonb_build_object('id',b.id,'actor',actor,'old',b.sale_amount_paise,'new',v_amount));
 elsif p_action='receipt' then
   if v_id is null or v_amount is null or v_amount<=0 or v_amount>1000000000 or f->>'sale_amount_paise' is null
     or v_amount>(f->>'balance_paise')::integer then raise exception 'PAYMENT_INVALID_RECEIPT'; end if;
   if p_input->>'method' is null or p_input->>'method' not in ('cash','upi','bank','ota','other') then raise exception 'INVALID_REQUEST'; end if;
   insert into ch_booking_receipts(id,booking_id,amount_paise,method,note,created_by)
     values(v_id,b.id,v_amount,p_input->>'method',coalesce(p_input->>'note',''),actor);
   update ch_bookings set offline_received_paise=(select coalesce(sum(amount_paise),0) from ch_booking_receipts where booking_id=b.id and voided_at is null) where id=b.id;
   insert into ch_audit(action,details) values('payment_recorded',jsonb_build_object('id',b.id,'receipt_id',v_id,'actor',actor,'amount_paise',v_amount));
 else
   if length(trim(coalesce(p_input->>'reason','')))<3 or length(p_input->>'reason')>300 then raise exception 'PAYMENT_CORRECTION_REASON'; end if;
   update ch_booking_receipts set voided_at=now(),voided_by=actor,void_reason=trim(p_input->>'reason') where id=r.id;
   update ch_bookings set offline_received_paise=(select coalesce(sum(amount_paise),0) from ch_booking_receipts where booking_id=b.id and voided_at is null) where id=b.id;
   insert into ch_audit(action,details) values('payment_entry_voided',jsonb_build_object('id',b.id,'receipt_id',r.id,'actor',actor,'amount_paise',r.amount_paise,'reason',p_input->>'reason'));
 end if;
 return ch_payments('booking',jsonb_build_object('id',b.id));
end $$;

-- One notification per stay event and device. Only due, unpaid, confirmed stays qualify.
create or replace function public.ch_payment_push(p_action text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare t ch_payment_reminders%rowtype;b ch_bookings%rowtype;f jsonb;result jsonb:='[]'::jsonb;
 v_owner text:=lower(p_input->>'owner_email');today date:=(now() at time zone 'Asia/Kolkata')::date;
begin
 if p_action='claim' then
   if not (select reminders_enabled from ch_payment_settings where id=1)
     or not exists(select 1 from ch_push_subscriptions where owner_email=v_owner) then return result; end if;
   insert into ch_payment_reminders(booking_id,stage,event_date,due_at,next_send_at)
   select booking.id,event.stage,event.day,((event.day-1)+time '09:00') at time zone 'Asia/Kolkata',
     ((event.day-1)+time '09:00') at time zone 'Asia/Kolkata'
   from ch_bookings booking cross join lateral (values ('arrival',booking.check_in),('departure',booking.check_out)) event(stage,day)
   where booking.status='confirmed' and event.day=today+1 and (ch_booking_finance(booking)->>'balance_paise')::integer>0
   on conflict(booking_id,stage,event_date) do nothing;
   for t in select reminder.* from ch_payment_reminders reminder join ch_bookings booking on booking.id=reminder.booking_id
     where reminder.sent_at is null and reminder.next_send_at<=now() and reminder.event_date=today+1
       and (reminder.lease_until is null or reminder.lease_until<now()) and booking.status='confirmed'
       and reminder.event_date=case when reminder.stage='arrival' then booking.check_in else booking.check_out end
       and (ch_booking_finance(booking)->>'balance_paise')::integer>0
     order by reminder.next_send_at limit 3 for update of reminder skip locked loop
     update ch_payment_reminders set lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes' where id=t.id returning * into t;
     result:=result||jsonb_build_array(jsonb_build_object('id',t.id,'lease_token',t.lease_token,
       'subscriptions',(select coalesce(jsonb_agg(to_jsonb(device)),'[]'::jsonb) from ch_push_subscriptions device
         where device.owner_email=v_owner and not exists(select 1 from ch_payment_reminder_deliveries d where d.reminder_id=t.id and d.subscription_id=device.id))));
   end loop;
   return result;
 elsif p_action='current' then
   select * into t from ch_payment_reminders where id=(p_input->>'id')::uuid
     and lease_token=(p_input->>'lease_token')::uuid and lease_until>now() and sent_at is null and event_date=today+1;
   if not found or not (select reminders_enabled from ch_payment_settings where id=1) then return jsonb_build_object('current',false); end if;
   select * into b from ch_bookings where id=t.booking_id;
   f:=ch_booking_finance(b);
   if b.status<>'confirmed' or t.event_date<>(case when t.stage='arrival' then b.check_in else b.check_out end)
     or coalesce((f->>'balance_paise')::integer,0)<=0 then return jsonb_build_object('current',false); end if;
   return jsonb_build_object('current',true,'stage',t.stage,'event_date',t.event_date,
     'booking',jsonb_build_object('id',b.id,'reference',b.reference,'guest_name',b.guest_name,'balance_paise',f->'balance_paise'));
 elsif p_action='delivered' then
   insert into ch_payment_reminder_deliveries(reminder_id,subscription_id)
   select id,(p_input->>'subscription_id')::uuid from ch_payment_reminders
     where id=(p_input->>'id')::uuid and lease_token=(p_input->>'lease_token')::uuid and lease_until>now()
       and exists(select 1 from ch_push_subscriptions where id=(p_input->>'subscription_id')::uuid)
   on conflict do nothing;
   return jsonb_build_object('ok',true);
 elsif p_action='finish' then
   update ch_payment_reminders set sent_at=case when (p_input->>'success')::boolean then now() else null end,
     next_send_at=now()+make_interval(mins=>least(60,power(2,least(attempts,6))::integer)),
     attempts=attempts+1,lease_token=null,lease_until=null
     where id=(p_input->>'id')::uuid and lease_token=(p_input->>'lease_token')::uuid and lease_until>now() and sent_at is null;
   return jsonb_build_object('ok',true);
 end if;
 raise exception 'INVALID_REQUEST';
end $$;

alter table public.ch_booking_receipts enable row level security;
alter table public.ch_payment_settings enable row level security;
alter table public.ch_payment_reminders enable row level security;
alter table public.ch_payment_reminder_deliveries enable row level security;
revoke all on public.ch_booking_receipts,public.ch_payment_settings,public.ch_payment_reminders,public.ch_payment_reminder_deliveries from public,anon,authenticated;
grant select,insert,update on public.ch_booking_receipts,public.ch_payment_settings,public.ch_payment_reminders,public.ch_payment_reminder_deliveries to service_role;
do $$ declare n text;begin foreach n in array array['ch_booking_receipts','ch_payment_settings','ch_payment_reminders','ch_payment_reminder_deliveries'] loop
 if not exists(select 1 from pg_policies where schemaname='public' and tablename=n and policyname='service_only') then
   execute format('create policy service_only on public.%I for all to service_role using (true) with check (true)',n);
 end if;end loop;end $$;
revoke execute on function public.ch_booking_finance(public.ch_bookings),public.ch_payments(text,jsonb),public.ch_payment_push(text,jsonb) from public,anon,authenticated;
grant execute on function public.ch_booking_finance(public.ch_bookings),public.ch_payments(text,jsonb),public.ch_payment_push(text,jsonb) to service_role;

create or replace function public.ch_owner_booking(p_input jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare
 s ch_settings%rowtype; b ch_bookings%rowtype; v_room_type text; capacity integer;
 a date; z date; ids text[]; q integer; g integer; total integer; nightly jsonb;
 v_id uuid; v_name text; v_email text; v_phone text; v_note text; v_source text;
 v_sale integer;v_advance integer;
 editing boolean:=coalesce(p_input->>'id','')<>'';
 today date:=(now() at time zone 'Asia/Kolkata')::date;
begin
 -- Same lock used by public checkout, cancellation and bulk inventory changes.
 select * into s from ch_settings where id=1 for update;
 a:=(p_input->>'check_in')::date; z:=(p_input->>'check_out')::date;
 if a is null or z is null or a<today-365 or a>today+365 or z<=a or z>a+30
   then raise exception 'OWNER_INVALID_DATES'; end if;
 if jsonb_typeof(p_input->'room_ids') is distinct from 'array' then raise exception 'INVALID_ROOMS'; end if;
 select array_agg(value order by value) into ids from jsonb_array_elements_text(p_input->'room_ids');
 q:=coalesce(cardinality(ids),0);
 if q<1 or q>6 or q<>(select count(distinct x) from unnest(ids) x) or
   exists(select 1 from unnest(ids) x where not exists(select 1 from ch_rooms where id=x))
   then raise exception 'INVALID_ROOMS'; end if;
 -- Room IDs are authoritative. NULL type explicitly denotes a mixed allocation;
 -- it is never inserted into the sellable room-type catalogue.
 select case when count(distinct r.room_type)=1 then min(r.room_type) else null end,
   sum(t.max_guests)::integer into v_room_type,capacity
 from ch_rooms r join ch_room_types t on t.id=r.room_type where r.id=any(ids);
 g:=nullif(p_input->>'guests','')::integer;
 if g is not null and (g<q or g>capacity) then raise exception 'INVALID_ROOM_OR_GUESTS'; end if;
 v_name:=trim(coalesce(p_input->>'guest_name',''));
 v_email:=trim(coalesce(p_input->>'email',''));v_phone:=trim(coalesce(p_input->>'phone',''));
 v_note:=trim(coalesce(p_input->>'guest_note',''));v_source:=p_input->>'source';
 if length(v_name)<1 or length(v_name)>100 or length(v_email)>180 or length(v_phone)>22 or length(v_note)>500
   then raise exception 'OWNER_INVALID_GUEST'; end if;
 if v_source is null or v_source not in ('Direct','phone','walk-in','Booking.com','Agoda','Airbnb','Expedia','MMT/Goibibo','OTA','Other','website')
   then raise exception 'INVALID_REQUEST'; end if;
 if editing then
   v_id:=(p_input->>'id')::uuid;
   select * into b from ch_bookings where id=v_id for update;
   if not found then raise exception 'NOT_FOUND'; end if;
   if b.owner_revision is distinct from (p_input->>'revision')::integer then raise exception 'OWNER_STALE'; end if;
   if b.status<>'confirmed' then raise exception 'OWNER_BOOKING_LOCKED'; end if;
   if ((b.source='website' or b.order_id is not null or b.payment_id is not null) and v_source<>b.source)
     or (v_source='website' and b.source<>'website') then raise exception 'OWNER_SOURCE_LOCKED'; end if;
 else
   v_id:=(p_input->>'request_key')::uuid;
   v_sale:=(p_input->>'sale_amount_paise')::integer;
   v_advance:=coalesce((p_input->>'advance_paise')::integer,0);
   if v_sale<0 or v_sale>1000000000 or v_advance<0 or v_advance>1000000000 or
     (v_advance>0 and (v_sale is null or v_advance>v_sale)) then raise exception 'PAYMENT_INVALID_SALE'; end if;
   if v_id is null or v_source='website' then raise exception 'INVALID_REQUEST'; end if;
   select * into b from ch_bookings where request_key=v_id;
   if found then
     if not b.owner_entry or (b.guest_name,b.email,b.phone,b.guest_note,b.source,b.room_ids,b.check_in,b.check_out,b.guests)
       is distinct from (v_name,v_email,v_phone,v_note,v_source,ids,a,z,g) then raise exception 'OWNER_REQUEST_REUSED'; end if;
     if b.sale_amount_paise is distinct from v_sale or
       coalesce((select amount_paise from ch_booking_receipts where id=v_id),0)<>v_advance
       then raise exception 'OWNER_REQUEST_REUSED'; end if;
     return to_jsonb(b)-'token_hash'-'request_key';
   end if;
 end if;
 if exists(select 1 from ch_bookings other where other.id<>v_id and other.room_ids && ids
   and other.check_in<z and other.check_out>a and
   (other.status='confirmed' or (other.status='held' and other.expires_at>now())))
   then raise exception 'RESERVATION_CONFLICT'; end if;
 if editing then
   update ch_bookings set guest_name=v_name,email=v_email,phone=v_phone,guest_note=v_note,
     source=v_source,guests=g,room_type=v_room_type,room_ids=ids,check_in=a,check_out=z,
     synced_to_cm=case when (guest_name,source,guests,room_ids,check_in,check_out) is distinct from
       (v_name,v_source,g,ids,a,z) then false else synced_to_cm end
   where id=v_id returning * into b;
 else
   -- Each selected physical room uses its own type's rate on each stay night.
   with room_nightly as (
     select ds::date as stay_date,room.id as room_id,room.room_type,
       coalesce(rate.rate_paise,kind.rate_paise) as rate_paise
     from generate_series(a,z-1,interval '1 day') ds cross join ch_rooms room
     join ch_room_types kind on kind.id=room.room_type
     left join ch_rates rate on rate.room_type=room.room_type and rate.stay_date=ds::date
     where room.id=any(ids)
   ), daily as (
     select stay_date,sum(rate_paise)::integer as total_paise,
       case when v_room_type is not null then min(rate_paise) else null end as per_room_paise,
       jsonb_agg(jsonb_build_object('room_id',room_id,'room_type',room_type,'rate_paise',rate_paise)
         order by room_id) as rooms
     from room_nightly group by stay_date
   )
   select sum(total_paise)::integer,
     jsonb_agg(jsonb_build_object('date',stay_date,'rate_paise',per_room_paise,
       'total_paise',total_paise,'rooms',rooms) order by stay_date)
   into total,nightly from daily;
   insert into ch_bookings(id,reference,request_key,token_hash,room_type,room_ids,check_in,check_out,
     guests,guest_name,email,phone,guest_note,total_paise,deposit_paise,nightly_rates,policy,status,source,expires_at,owner_entry,sale_amount_paise,offline_received_paise)
   values(v_id,'CH-'||upper(left(replace(v_id::text,'-',''),12)),v_id,
     encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex'),v_room_type,ids,a,z,
     g,v_name,v_email,v_phone,v_note,total,ceil(total*s.deposit_percent/100.0)::integer,
     nightly,s.cancellation_policy,'confirmed',v_source,now(),true,v_sale,v_advance)
   returning * into b;
   if v_advance>0 then
     insert into ch_booking_receipts(id,booking_id,amount_paise,method,note,created_by)
       values(v_id,v_id,v_advance,'other','Advance received when booking was entered',coalesce(p_input->>'actor','owner'));
     insert into ch_audit(action,details) values('payment_recorded',jsonb_build_object('id',v_id,'receipt_id',v_id,'amount_paise',v_advance,'actor',p_input->>'actor'));
   end if;
 end if;
 insert into ch_audit(action,details) values(case when editing then 'owner_booking_edit' else 'owner_booking_add' end,
   jsonb_build_object('id',b.id,'actor',p_input->>'actor','rooms',ids,'check_in',a,'check_out',z,'revision',b.owner_revision));
 return to_jsonb(b)-'token_hash'-'request_key';
end $$;


revoke execute on function public.ch_owner_booking(jsonb) from public,anon,authenticated;
grant execute on function public.ch_owner_booking(jsonb) to service_role;

grant select on public.ch_push_subscriptions to service_role;
notify pgrst,'reload schema';
commit;
