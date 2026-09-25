-- Run once in a NEW Supabase project, using the SQL Editor.
-- All amounts are integer paise; displayed room rates include applicable taxes.
-- No dates are on sale until the owner opens them in the admin calendar.
begin;

create table if not exists public.ch_settings (
  id integer primary key check (id=1),
  booking_open boolean not null default false,
  deposit_percent integer not null default 100 check (deposit_percent between 10 and 100),
  cancellation_policy text not null default 'Contact Chakoram for cancellation terms before booking.',
  policy_reviewed boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.ch_settings(id) values(1) on conflict do nothing;

create table if not exists public.ch_room_types (
  id text primary key, name text not null,
  rate_paise integer not null check (rate_paise between 10000 and 100000000),
  max_guests integer not null default 2 check(max_guests between 1 and 6)
);
insert into public.ch_room_types values
  ('deluxe','Deluxe Room',320000,2),('premium','Premium Room',380000,2)
on conflict do nothing;

create table if not exists public.ch_rooms (
  id text primary key, name text not null, room_type text not null references public.ch_room_types(id)
);
insert into public.ch_rooms values
('D1','Deluxe 1','deluxe'),('D2','Deluxe 2','deluxe'),('D3','Deluxe 3','deluxe'),
('D4','Deluxe 4','deluxe'),('D5','Deluxe 5','deluxe'),('P1','Premium 1','premium')
on conflict do nothing;

create table if not exists public.ch_room_nights (
  room_id text not null references public.ch_rooms(id), stay_date date not null,
  is_open boolean not null default false, note text not null default '',
  primary key(room_id,stay_date)
);
create table if not exists public.ch_rates (
  room_type text not null references public.ch_room_types(id), stay_date date not null,
  rate_paise integer not null check(rate_paise between 10000 and 100000000),
  primary key(room_type,stay_date)
);
create table if not exists public.ch_bookings (
  id uuid primary key, reference text not null unique, request_key uuid not null unique,
  token_hash text not null, room_type text not null references public.ch_room_types(id),
  room_ids text[] not null, check_in date not null, check_out date not null,
  guests integer not null, guest_name text not null, email text not null, phone text not null,
  guest_note text not null default '',
  total_paise integer not null check(total_paise>0), deposit_paise integer not null check(deposit_paise>0),
  paid_paise integer not null default 0, refunded_paise integer not null default 0,
  nightly_rates jsonb not null, policy text not null,
  status text not null check(status in ('held','confirmed','expired','cancelled','payment_review')),
  source text not null default 'website',
  expires_at timestamptz not null, created_at timestamptz not null default now(),
  order_id text unique, payment_id text unique,
  synced_to_cm boolean not null default false, attention text not null default '',
  check(check_out>check_in), check(cardinality(room_ids)>0)
);
create index if not exists ch_booking_stay on public.ch_bookings(check_in,check_out,status);
create table if not exists public.ch_audit (
 id bigint generated always as identity primary key, created_at timestamptz not null default now(),
 action text not null, details jsonb not null
);
create table if not exists public.ch_rate_limits (
 key text primary key, started_at timestamptz not null, attempts integer not null
);

-- One row lock serialises inventory mutations for this six-room property.
-- Dates use [check-in, check-out); departure day is available to another guest.
create or replace function public.ch_available_rooms(t text, a date, z date, exclude_id uuid default null)
returns text[] language sql stable security definer set search_path=public as $$
select coalesce(array_agg(r.id order by r.id),array[]::text[])
from ch_rooms r where r.room_type=t
and (select count(*) from ch_room_nights n where n.room_id=r.id and n.stay_date>=a
  and n.stay_date<z and n.is_open) = z-a
and not exists(select 1 from ch_bookings b where r.id=any(b.room_ids)
  and (exclude_id is null or b.id<>exclude_id) and b.check_in<z and b.check_out>a
  and (b.status='confirmed' or (b.status='held' and b.expires_at>now())));
$$;

create or replace function public.ch_engine(p_action text, p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
 s ch_settings%rowtype; b ch_bookings%rowtype; rt ch_room_types%rowtype;
 a date; z date; d date; q integer; g integer; total integer; dep integer;
 available text[]; ids text[]; nightly jsonb; result jsonb; n integer; oldpaid integer;
 amount integer; today date := (now() at time zone 'Asia/Kolkata')::date;
begin
 select * into s from ch_settings where id=1 for update;
 if p_action='rate_limit' then
   delete from ch_rate_limits where started_at<now()-interval '1 day';
   insert into ch_rate_limits(key,started_at,attempts) values(p_input->>'key',now(),1)
   on conflict(key) do update set
     attempts=case when ch_rate_limits.started_at<now()-make_interval(secs=>(p_input->>'seconds')::integer)
                   then 1 else ch_rate_limits.attempts+1 end,
     started_at=case when ch_rate_limits.started_at<now()-make_interval(secs=>(p_input->>'seconds')::integer)
                   then now() else ch_rate_limits.started_at end
   returning attempts into n;
   return jsonb_build_object('allowed',n<=(p_input->>'limit')::integer);
 end if;

 if p_action='config' then
   return jsonb_build_object('booking_open',s.booking_open and s.policy_reviewed,
    'deposit_percent',s.deposit_percent,'policy',s.cancellation_policy,
    'room_types',(select jsonb_agg(to_jsonb(t) order by id) from ch_room_types t));
 end if;

 if p_action in ('availability','hold','manual') then
   a := (p_input->>'check_in')::date; z := (p_input->>'check_out')::date;
   q := (p_input->>'quantity')::integer; g := (p_input->>'guests')::integer;
   if a is null or z is null or a<today or a>today+365 or z<=a or z>a+30 or q is null or q<1 or q>6
     or g is null or g<q or g>36 then raise exception 'INVALID_DATES_OR_GUESTS'; end if;
   if p_action='availability' then
     result := '[]'::jsonb;
     for rt in select * from ch_room_types order by id loop
       available := ch_available_rooms(rt.id,a,z);
       select coalesce(sum(coalesce(r.rate_paise,rt.rate_paise)),0)::integer*q,
         jsonb_agg(jsonb_build_object('date',ds::date,'rate_paise',coalesce(r.rate_paise,rt.rate_paise)) order by ds)
       into total,nightly from generate_series(a,z-1,interval '1 day') ds
       left join ch_rates r on r.room_type=rt.id and r.stay_date=ds::date;
       result := result || jsonb_build_array(jsonb_build_object('id',rt.id,'name',rt.name,
         'max_guests',rt.max_guests,'available',cardinality(available),'fits',g<=q*rt.max_guests,
         'total_paise',total,'deposit_paise',ceil(total*s.deposit_percent/100.0)::integer,
         'nightly_rates',nightly));
     end loop;
     return jsonb_build_object('rooms',result,'nights',z-a,'deposit_percent',s.deposit_percent,
       'booking_open',s.booking_open and s.policy_reviewed,'policy',s.cancellation_policy);
   end if;

   select * into b from ch_bookings where request_key=(p_input->>'request_key')::uuid;
   if found then
     if b.token_hash<>p_input->>'token_hash' then raise exception 'INVALID_REQUEST'; end if;
     if b.status='held' and b.expires_at<=now() then raise exception 'HOLD_EXPIRED'; end if;
     return to_jsonb(b);
   end if;
   if p_action='hold' and not(s.booking_open and s.policy_reviewed) then raise exception 'BOOKING_CLOSED'; end if;
   select * into rt from ch_room_types where id=p_input->>'room_type';
   if not found or g>q*rt.max_guests then raise exception 'INVALID_ROOM_OR_GUESTS'; end if;
   available := ch_available_rooms(rt.id,a,z);
   if cardinality(available)<q then raise exception 'NO_AVAILABILITY'; end if;
   ids := available[1:q];
   select sum(coalesce(r.rate_paise,rt.rate_paise))::integer*q,
     jsonb_agg(jsonb_build_object('date',ds::date,'rate_paise',coalesce(r.rate_paise,rt.rate_paise)) order by ds)
   into total,nightly from generate_series(a,z-1,interval '1 day') ds
   left join ch_rates r on r.room_type=rt.id and r.stay_date=ds::date;
   dep:=ceil(total*s.deposit_percent/100.0)::integer;
   if (p_input->>'expected_total')::integer is distinct from total or
      (p_input->>'expected_deposit')::integer is distinct from dep or
      (p_input->>'accepted_policy') is distinct from s.cancellation_policy
      then raise exception 'QUOTE_CHANGED'; end if;
   insert into ch_bookings(id,reference,request_key,token_hash,room_type,room_ids,check_in,check_out,
     guests,guest_name,email,phone,guest_note,total_paise,deposit_paise,nightly_rates,policy,status,source,expires_at)
   values((p_input->>'id')::uuid,p_input->>'reference',(p_input->>'request_key')::uuid,p_input->>'token_hash',
     rt.id,ids,a,z,g,p_input->>'guest_name',p_input->>'email',p_input->>'phone',coalesce(p_input->>'guest_note',''),
     total,dep,nightly,s.cancellation_policy,case when p_action='manual' then 'confirmed' else 'held' end,
     case when p_action='manual' then coalesce(p_input->>'source','phone') else 'website' end,now()+interval '15 minutes')
   returning * into b;
   insert into ch_audit(action,details) values(p_action,jsonb_build_object('id',b.id,'rooms',ids));
   return to_jsonb(b);
 end if;

 if p_action='attach_order' then
   update ch_bookings set order_id=p_input->>'order_id'
   where id=(p_input->>'id')::uuid and order_id is null and status='held';
   select * into b from ch_bookings where id=(p_input->>'id')::uuid;
   return to_jsonb(b);
 end if;
 if p_action in ('get_booking','admin_cancel','admin_sync','captured','refund') then
   if p_input ? 'order_id' then select * into b from ch_bookings where order_id=p_input->>'order_id';
   else select * into b from ch_bookings where id=(p_input->>'id')::uuid; end if;
   if b.id is null then raise exception 'NOT_FOUND'; end if;
   if p_action='get_booking' then return to_jsonb(b); end if;
   if p_action='admin_sync' then
     update ch_bookings set synced_to_cm=(p_input->>'synced')::boolean where id=b.id returning * into b;
   elsif p_action='admin_cancel' then
     update ch_bookings set status='cancelled',synced_to_cm=false,
       attention=case when paid_paise>refunded_paise then 'Cancelled: refund must be handled in Razorpay.' else '' end
     where id=b.id returning * into b;
   elsif p_action='captured' then
     amount:=(p_input->>'amount')::integer;
     if p_input->>'currency'<>'INR' or amount<>b.deposit_paise or p_input->>'payment_id' is null then
       raise exception 'PAYMENT_MISMATCH'; end if;
     if b.payment_id is not null then
       if b.payment_id<>p_input->>'payment_id' then raise exception 'PAYMENT_MISMATCH'; end if;
       return to_jsonb(b); -- duplicate webhook; never regress a refund or cancellation
     end if;
     available:=ch_available_rooms(b.room_type,b.check_in,b.check_out,b.id);
     if b.status in ('cancelled','payment_review') then
       update ch_bookings set status='payment_review',attention='Payment received after cancellation. Review and refund.' where id=b.id;
     elsif not(b.room_ids <@ available) then
       update ch_bookings set status='payment_review',attention='Payment received after room hold expired; room unavailable. Review and refund.' where id=b.id;
     else update ch_bookings set status='confirmed',attention='' where id=b.id;
     end if;
     update ch_bookings set payment_id=p_input->>'payment_id',paid_paise=amount,synced_to_cm=false
       where id=b.id returning * into b;
   elsif p_action='refund' then
     amount:=(p_input->>'amount_refunded')::integer;
     if b.payment_id is distinct from (p_input->>'payment_id') or amount<0 or amount>b.paid_paise
       then raise exception 'PAYMENT_MISMATCH'; end if;
     update ch_bookings set refunded_paise=greatest(refunded_paise,amount),
       attention=case when amount=paid_paise and status in ('cancelled','payment_review') then ''
       when amount=paid_paise and status='confirmed' then 'Fully refunded: review reservation and cancel if appropriate.' else attention end
     where id=b.id returning * into b;
   end if;
   insert into ch_audit(action,details) values(p_action,jsonb_build_object('id',b.id));
   return to_jsonb(b);
 end if;

 if p_action='admin_dashboard' then
   a:=coalesce((p_input->>'start')::date,today); z:=a+14;
   return jsonb_build_object('settings',to_jsonb(s),
    'room_types',(select jsonb_agg(to_jsonb(t) order by id) from ch_room_types t),
    'rooms',(select jsonb_agg(to_jsonb(r) order by id) from ch_rooms r),
    'calendar',(select jsonb_agg(jsonb_build_object('room_id',r.id,'date',ds::date,
       'is_open',coalesce(n.is_open,false),'note',coalesce(n.note,''),
       'booking',(select jsonb_build_object('id',bk.id,'reference',bk.reference,'guest_name',bk.guest_name,'status',bk.status)
        from ch_bookings bk where r.id=any(bk.room_ids) and bk.check_in<=ds::date and bk.check_out>ds::date
        and (bk.status='confirmed' or (bk.status='held' and bk.expires_at>now())) limit 1)) order by r.id,ds)
     from ch_rooms r cross join generate_series(a,z-1,interval '1 day') ds
     left join ch_room_nights n on n.room_id=r.id and n.stay_date=ds::date),
    'bookings',(select coalesce(jsonb_agg(to_jsonb(bk)-'token_hash' order by bk.created_at desc),'[]'::jsonb)
      from (select * from ch_bookings order by created_at desc limit 500) bk),
    'rates',(select coalesce(jsonb_agg(to_jsonb(r) order by stay_date,room_type),'[]'::jsonb) from ch_rates r
      where stay_date>=a and stay_date<z));
 end if;

 if p_action='admin_inventory' then
   a:=(p_input->>'start')::date; z:=(p_input->>'end')::date;
   if a is null or z is null or a<today or z<a or z>a+365 then raise exception 'INVALID_DATES'; end if;
   select array_agg(value) into ids from jsonb_array_elements_text(p_input->'room_ids');
   if coalesce(cardinality(ids),0)=0 or exists(select 1 from unnest(ids) x where not exists(select 1 from ch_rooms where id=x))
      then raise exception 'INVALID_ROOMS'; end if;
   if not (p_input->>'is_open')::boolean and exists(select 1 from ch_bookings bk
      where bk.room_ids && ids and bk.check_in<=z and bk.check_out>a
      and (bk.status='confirmed' or (bk.status='held' and bk.expires_at>now()))) then raise exception 'RESERVATION_CONFLICT'; end if;
   insert into ch_room_nights(room_id,stay_date,is_open,note)
     select x,ds::date,(p_input->>'is_open')::boolean,left(coalesce(p_input->>'note',''),200)
     from unnest(ids) x cross join generate_series(a,z,interval '1 day') ds
   on conflict(room_id,stay_date) do update set is_open=excluded.is_open,note=excluded.note;
   result:=jsonb_build_object('ok',true);
 elsif p_action='admin_rates' then
   a:=(p_input->>'start')::date; z:=(p_input->>'end')::date;
   if a is null or z is null or a<today or z<a or z>a+365 then raise exception 'INVALID_DATES'; end if;
   if (p_input->>'reset')::boolean then
     delete from ch_rates where room_type=p_input->>'room_type' and stay_date between a and z;
   else
     insert into ch_rates(room_type,stay_date,rate_paise)
     select p_input->>'room_type',ds::date,(p_input->>'rate_paise')::integer from generate_series(a,z,interval '1 day') ds
     on conflict(room_type,stay_date) do update set rate_paise=excluded.rate_paise;
   end if;
   result:=jsonb_build_object('ok',true);
 elsif p_action='admin_settings' then
   if length(p_input->>'cancellation_policy')<30 then raise exception 'POLICY_REQUIRED'; end if;
   update ch_settings set booking_open=(p_input->>'booking_open')::boolean,
     deposit_percent=(p_input->>'deposit_percent')::integer,
     cancellation_policy=left(p_input->>'cancellation_policy',4000),
     policy_reviewed=(p_input->>'policy_reviewed')::boolean,updated_at=now() where id=1;
   for result in select value from jsonb_array_elements(p_input->'room_types') loop
     update ch_room_types set rate_paise=(result->>'rate_paise')::integer,
       max_guests=(result->>'max_guests')::integer where id=result->>'id';
   end loop;
   result:=jsonb_build_object('ok',true);
 else raise exception 'UNKNOWN_ACTION';
 end if;
 insert into ch_audit(action,details) values(p_action,p_input);
 return result;
end;
$$;

-- No browser role can read guests, modify stock or invoke privileged functions.
alter table public.ch_settings enable row level security;
alter table public.ch_room_types enable row level security;
alter table public.ch_rooms enable row level security;
alter table public.ch_room_nights enable row level security;
alter table public.ch_rates enable row level security;
alter table public.ch_bookings enable row level security;
alter table public.ch_audit enable row level security;
alter table public.ch_rate_limits enable row level security;
revoke all on public.ch_settings,public.ch_room_types,public.ch_rooms,public.ch_room_nights,
  public.ch_rates,public.ch_bookings,public.ch_audit,public.ch_rate_limits from anon,authenticated;
revoke execute on function public.ch_available_rooms(text,date,date,uuid) from public,anon,authenticated;
revoke execute on function public.ch_engine(text,jsonb) from public,anon,authenticated;
grant execute on function public.ch_engine(text,jsonb) to service_role;
commit;
