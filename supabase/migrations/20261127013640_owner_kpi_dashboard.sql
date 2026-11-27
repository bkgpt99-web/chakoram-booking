-- Owner management KPIs. Existing amounts, stays and availability are retained.
begin;
alter table public.ch_bookings add column if not exists kpi jsonb not null default '{}'::jsonb;
alter table public.ch_room_nights add column if not exists out_of_order boolean not null default false;
create table if not exists public.ch_kpi_ledger (
 id uuid primary key, kind text not null check(kind in ('income','expense')),
 category text not null, amount_paise integer not null check(amount_paise>0 and amount_paise<=1000000000),
 start_date date not null,end_date date not null check(end_date>=start_date and end_date<=start_date+365),
 note text not null default '' check(length(note)<=300),created_at timestamptz not null default now(),created_by text,
 revision integer not null default 0,voided_at timestamptz,voided_by text,void_reason text
);
create index if not exists ch_kpi_ledger_period on public.ch_kpi_ledger(start_date,end_date);
create table if not exists public.ch_kpi_periods (
 month date primary key check(extract(day from month)=1),bookings_complete boolean not null default false,
 costs_complete boolean not null default false,reviewed_at timestamptz not null default now(),reviewed_by text
);
alter table public.ch_kpi_ledger enable row level security;
alter table public.ch_kpi_periods enable row level security;
drop policy if exists service_only on public.ch_kpi_ledger;
create policy service_only on public.ch_kpi_ledger for all to service_role using(true) with check(true);
drop policy if exists service_only on public.ch_kpi_periods;
create policy service_only on public.ch_kpi_periods for all to service_role using(true) with check(true);
revoke all on public.ch_kpi_ledger,public.ch_kpi_periods from anon,authenticated;
grant select,insert,update on public.ch_kpi_ledger,public.ch_kpi_periods to service_role;
grant select,insert,update on public.ch_room_nights to service_role;

create or replace function public.ch_kpi_validate(v jsonb,b public.ch_bookings)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare k jsonb:='{}';f text;n bigint;total bigint:=0;booked date;st text;kind text;
 today date:=(now() at time zone 'Asia/Kolkata')::date;sale bigint;
begin
 if jsonb_typeof(v) is distinct from 'object' then raise exception 'KPI_INVALID';end if;
 booked:=nullif(v->>'booked_on','')::date;
 if booked is not null and (booked>b.check_in or booked>today or booked<'2000-01-01') then raise exception 'KPI_BOOKED_DATE';end if;
 st:=coalesce(v->>'stay_status','unverified');kind:=coalesce(v->>'stay_kind','paid');
 if st not in ('unverified','in_house','checked_out','no_show') or kind not in ('paid','complimentary') then raise exception 'KPI_INVALID';end if;
 if (st='in_house' and (b.status<>'confirmed' or b.check_in>today or b.check_out<=today)) or
    (st='checked_out' and (b.status<>'confirmed' or b.check_out>today)) or
    (st='no_show' and (b.status<>'cancelled' or b.check_in>today)) then raise exception 'KPI_STAY_STATUS';end if;
 k:=jsonb_build_object('booked_on',booked,'stay_status',st,'stay_kind',kind);
 foreach f in array array['room_revenue_paise','food_revenue_paise','transfer_revenue_paise','other_revenue_paise','tax_paise','commission_paise','gateway_fee_paise'] loop
  if v->>f is null then n:=null;
  elsif jsonb_typeof(v->f)<>'number' or (v->>f)!~'^[0-9]+$' then raise exception 'KPI_INVALID';
  else n:=(v->>f)::bigint;if n<0 or n>1000000000 then raise exception 'KPI_INVALID';end if;end if;
  k:=k||jsonb_build_object(f,n);
 end loop;
 foreach f in array array['revenue_confirmed','costs_confirmed'] loop
  if v?f and jsonb_typeof(v->f)<>'boolean' then raise exception 'KPI_INVALID';end if;
  k:=k||jsonb_build_object(f,coalesce((v->>f)::boolean,false));
 end loop;
 if (k->>'revenue_confirmed')::boolean then
  foreach f in array array['room_revenue_paise','food_revenue_paise','transfer_revenue_paise','other_revenue_paise','tax_paise'] loop
   if k->>f is null then raise exception 'KPI_REVENUE_SPLIT';end if;total:=total+(k->>f)::bigint;
  end loop;
  sale:=coalesce(b.sale_amount_paise,case when not b.owner_entry and b.source='website' then b.total_paise end);
  if sale is null or total<>greatest(0,sale-b.refunded_paise) or (kind='complimentary' and (k->>'room_revenue_paise')::bigint<>0) then raise exception 'KPI_REVENUE_SPLIT';end if;
 end if;
 if (k->>'costs_confirmed')::boolean and (k->>'commission_paise' is null or k->>'gateway_fee_paise' is null) then raise exception 'KPI_COSTS';end if;
 return k;
end $$;

-- Old clients and gateway refunds must never leave stale confirmed allocations.
create or replace function public.ch_kpi_changed() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if (new.sale_amount_paise,new.total_paise,new.refunded_paise) is distinct from (old.sale_amount_paise,old.total_paise,old.refunded_paise) then
  new.kpi:=new.kpi||jsonb_build_object('revenue_confirmed',false);
 end if;
 if (new.check_in,new.check_out,new.status) is distinct from (old.check_in,old.check_out,old.status) then
  new.kpi:=new.kpi||jsonb_build_object('stay_status','unverified');
  if nullif(new.kpi->>'booked_on','')::date>new.check_in then new.kpi:=new.kpi||jsonb_build_object('booked_on',null);end if;
 end if;
 return new;
end $$;
drop trigger if exists ch_kpi_changed on public.ch_bookings;
create trigger ch_kpi_changed before update on public.ch_bookings for each row execute function public.ch_kpi_changed();
create or replace function public.ch_kpi_open_room() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
begin if new.is_open then new.out_of_order:=false;end if;return new;end $$;
drop trigger if exists ch_kpi_open_room on public.ch_room_nights;
create trigger ch_kpi_open_room before insert or update on public.ch_room_nights for each row execute function public.ch_kpi_open_room();

create or replace function public.ch_kpi_owner_booking(p_input jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare result jsonb;b ch_bookings%rowtype;existing ch_bookings%rowtype;k jsonb;
begin
 perform 1 from ch_settings where id=1 for update;
 if nullif(p_input->>'id','') is null then select * into existing from ch_bookings where request_key=(p_input->>'request_key')::uuid;end if;
 if existing.id is null and exists(select 1 from ch_room_nights n where n.out_of_order
  and n.room_id in (select jsonb_array_elements_text(p_input->'room_ids'))
  and n.stay_date>=(p_input->>'check_in')::date and n.stay_date<(p_input->>'check_out')::date) then raise exception 'KPI_ROOM_OUT_OF_ORDER';end if;
 result:=ch_owner_booking(p_input);
 select * into b from ch_bookings where id=(result->>'id')::uuid for update;
 if p_input?'kpi' then
  k:=ch_kpi_validate(p_input->'kpi',b);
  if existing.id is not null and existing.kpi is distinct from k then raise exception 'OWNER_REQUEST_REUSED';end if;
  if b.kpi is distinct from k then update ch_bookings set kpi=k where id=b.id returning * into b;end if;
 end if;
 return to_jsonb(b)-'token_hash'-'request_key';
end $$;
create or replace function public.ch_kpi_payments(p_action text,p_input jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare result jsonb;b ch_bookings%rowtype;k jsonb;
begin
 result:=ch_payments(p_action,p_input);
 if p_action='save_sale' and p_input?'kpi' then
  select * into b from ch_bookings where id=(p_input->>'id')::uuid for update;
  k:=ch_kpi_validate(p_input->'kpi',b);
  if b.kpi is distinct from k then update ch_bookings set kpi=k where id=b.id;end if;
  return ch_payments('booking',p_input);
 end if;
 return result;
end $$;

create or replace function public.ch_kpi(p_action text,p_input jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare a date;z date;b ch_bookings%rowtype;k jsonb;v_id uuid;v_revision integer;g integer;cap integer;
 e ch_kpi_ledger%rowtype;v_kind text;v_category text;v_amount integer;v_note text;ids text[];v_open boolean;ooo boolean;
 today date:=(now() at time zone 'Asia/Kolkata')::date;
begin
 if p_action='data' then
  a:=(p_input->>'start')::date;z:=(p_input->>'end')::date;
  if a is null or z is null or z<a or z>a+731 then raise exception 'KPI_RANGE';end if;
  return jsonb_build_object(
   'rooms',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from ch_rooms r),
   'bookings',(select coalesce(jsonb_agg(to_jsonb(x)-'token_hash'-'request_key'-'email'-'phone'-'guest_note'-'policy'-'nightly_rates' order by check_in),'[]') from ch_bookings x where x.check_in<=z and x.check_out>a and x.status in ('confirmed','cancelled')),
   'outages',(select coalesce(jsonb_agg(jsonb_build_object('room_id',room_id,'stay_date',stay_date)),'[]') from ch_room_nights where out_of_order and stay_date between a and z),
   'ledger',(select coalesce(jsonb_agg(to_jsonb(l) order by start_date desc,created_at desc),'[]') from ch_kpi_ledger l where start_date<=z and end_date>=a),
   'periods',(select coalesce(jsonb_agg(to_jsonb(p) order by month),'[]') from ch_kpi_periods p where month between date_trunc('month',a)::date and date_trunc('month',z)::date));
 end if;
 if p_action='booking' then
  perform 1 from ch_settings where id=1 for update;
  select * into b from ch_bookings where id=(p_input->>'id')::uuid for update;
  if not found then raise exception 'NOT_FOUND';end if;
  if b.owner_revision is distinct from (p_input->>'revision')::integer then raise exception 'OWNER_STALE';end if;
  if b.status not in ('confirmed','cancelled') then raise exception 'KPI_STAY_STATUS';end if;
  k:=ch_kpi_validate(p_input->'kpi',b);
  g:=nullif(p_input->>'guests','')::integer;
  select sum(t.max_guests) into cap from ch_rooms r join ch_room_types t on t.id=r.room_type where r.id=any(b.room_ids);
  if g is not null and (g<cardinality(b.room_ids) or g>cap) then raise exception 'INVALID_ROOM_OR_GUESTS';end if;
  if nullif(p_input->>'meal_plan','') is not null and p_input->>'meal_plan' not in ('ep','cp','ap','package') then raise exception 'OWNER_INVALID_PLAN';end if;
  if length(coalesce(p_input->>'meal_plan_note',''))>200 then raise exception 'OWNER_INVALID_PLAN';end if;
  update ch_bookings set kpi=k,guests=g,meal_plan=nullif(p_input->>'meal_plan',''),meal_plan_note=trim(coalesce(p_input->>'meal_plan_note','')),
   synced_to_cm=case when guests is distinct from g or meal_plan is distinct from nullif(p_input->>'meal_plan','') or meal_plan_note is distinct from trim(coalesce(p_input->>'meal_plan_note','')) then false else synced_to_cm end
   where id=b.id returning * into b;
  insert into ch_audit(action,details) values('owner_kpi_booking',jsonb_build_object('id',b.id,'actor',p_input->>'actor','revision',b.owner_revision));
  return to_jsonb(b)-'token_hash'-'request_key';
 end if;
 if p_action in ('ledger','void') then
  v_id:=(p_input->>'id')::uuid;if v_id is null then raise exception 'KPI_INVALID';end if;
  -- Settings lock serializes idempotent inserts, including retries on a new id.
  perform 1 from ch_settings where id=1 for update;
  select * into e from ch_kpi_ledger where id=v_id for update;
  if p_action='void' then
   if e.id is null then raise exception 'NOT_FOUND';end if;
   if e.voided_at is not null then return to_jsonb(e);end if;
   if e.revision is distinct from (p_input->>'revision')::integer then raise exception 'KPI_STALE';end if;
   if length(trim(coalesce(p_input->>'reason','')))<3 or length(p_input->>'reason')>300 then raise exception 'PAYMENT_CORRECTION_REASON';end if;
   update ch_kpi_ledger set voided_at=now(),voided_by=p_input->>'actor',void_reason=trim(p_input->>'reason'),revision=revision+1 where id=v_id returning * into e;
  else
   a:=(p_input->>'start_date')::date;z:=(p_input->>'end_date')::date;
   v_kind:=p_input->>'kind';v_category:=p_input->>'category';v_note:=trim(coalesce(p_input->>'note',''));v_amount:=(p_input->>'amount_paise')::integer;
   if a is null or z is null or z<a or z>a+365 or v_amount is null or v_amount<1 or v_amount>1000000000 or length(v_note)>300 then raise exception 'KPI_INVALID';end if;
   if v_kind is null or v_kind not in ('expense','income') or v_category is null or
    (v_kind='expense' and v_category not in ('salary','food','housekeeping','laundry','utilities','internet','repairs','marketing','other')) or
    (v_kind='income' and v_category not in ('food','transfer','other')) then raise exception 'KPI_INVALID';end if;
   if e.id is not null then
    if e.voided_at is null and (e.kind,e.category,e.amount_paise,e.start_date,e.end_date,e.note) is not distinct from (v_kind,v_category,v_amount,a,z,v_note) then return to_jsonb(e);end if;
    raise exception 'KPI_ENTRY_REUSED';
   end if;
   insert into ch_kpi_ledger(id,kind,category,amount_paise,start_date,end_date,note,created_by)
    values(v_id,v_kind,v_category,v_amount,a,z,v_note,p_input->>'actor') returning * into e;
  end if;
  -- New cost or income changes require a fresh month review.
  update ch_kpi_periods set costs_complete=false where month between date_trunc('month',e.start_date)::date and date_trunc('month',e.end_date)::date;
  insert into ch_audit(action,details) values('owner_kpi_'||p_action,jsonb_build_object('id',e.id,'actor',p_input->>'actor'));
  return to_jsonb(e);
 end if;
 if p_action='review' then
  a:=(p_input->>'month')::date;
  if a is null or extract(day from a)<>1 or jsonb_typeof(p_input->'bookings_complete') is distinct from 'boolean' or jsonb_typeof(p_input->'costs_complete') is distinct from 'boolean' then raise exception 'KPI_INVALID';end if;
  insert into ch_kpi_periods(month,bookings_complete,costs_complete,reviewed_by) values(a,(p_input->>'bookings_complete')::boolean,(p_input->>'costs_complete')::boolean,p_input->>'actor')
   on conflict(month) do update set bookings_complete=excluded.bookings_complete,costs_complete=excluded.costs_complete,reviewed_at=now(),reviewed_by=excluded.reviewed_by;
  insert into ch_audit(action,details) values('owner_kpi_review',p_input||jsonb_build_object('month',a));return jsonb_build_object('ok',true);
 end if;
 if p_action='inventory' then
  perform 1 from ch_settings where id=1 for update;
  a:=(p_input->>'start')::date;z:=(p_input->>'end')::date;
  if a is null or z is null or a<today-730 or z>today+365 or z<a or z>a+365 then raise exception 'KPI_RANGE';end if;
  if jsonb_typeof(p_input->'room_ids') is distinct from 'array' or jsonb_typeof(p_input->'is_open') is distinct from 'boolean' then raise exception 'KPI_INVALID';end if;
  select array_agg(distinct value) into ids from jsonb_array_elements_text(p_input->'room_ids');
  if coalesce(cardinality(ids),0)=0 or exists(select 1 from unnest(ids) x where not exists(select 1 from ch_rooms where id=x)) then raise exception 'INVALID_ROOMS';end if;
  v_open:=(p_input->>'is_open')::boolean;ooo:=coalesce((p_input->>'out_of_order')::boolean,false);v_note:=trim(coalesce(p_input->>'note',''));
  if length(v_note)>200 or (v_open and ooo) then raise exception 'KPI_INVALID';end if;
  if not v_open and exists(select 1 from ch_bookings where room_ids&&ids and check_in<=z and check_out>a and (status='confirmed' or (status='held' and expires_at>now()))) then raise exception 'RESERVATION_CONFLICT';end if;
  insert into ch_room_nights(room_id,stay_date,is_open,note,out_of_order)
   select id,ds::date,v_open,v_note,ooo from unnest(ids) id cross join generate_series(a,z,interval '1 day') ds
   on conflict(room_id,stay_date) do update set is_open=excluded.is_open,note=excluded.note,out_of_order=excluded.out_of_order;
  insert into ch_audit(action,details) values('owner_kpi_inventory',p_input);return jsonb_build_object('ok',true);
 end if;
 raise exception 'INVALID_REQUEST';
end $$;
-- Reviews are acknowledgements of the entered dataset, not permanent locks.
create or replace function public.ch_kpi_review_changed() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if tg_table_name='ch_bookings' then
  if tg_op='INSERT' then
   update ch_kpi_periods set bookings_complete=false,costs_complete=false where month between date_trunc('month',new.check_in)::date and date_trunc('month',new.check_out-1)::date;
  elsif (new.check_in,new.check_out,new.room_ids,new.guests,new.meal_plan,new.status,new.kpi,new.sale_amount_paise,new.refunded_paise) is distinct from (old.check_in,old.check_out,old.room_ids,old.guests,old.meal_plan,old.status,old.kpi,old.sale_amount_paise,old.refunded_paise) then
   update ch_kpi_periods set bookings_complete=false,costs_complete=false where month between date_trunc('month',least(old.check_in,new.check_in))::date and date_trunc('month',greatest(old.check_out,new.check_out)-1)::date;
  end if;
 else
  if tg_op='INSERT' then
   if new.out_of_order then update ch_kpi_periods set bookings_complete=false where month=date_trunc('month',new.stay_date)::date;end if;
  elsif new.out_of_order is distinct from old.out_of_order then
   update ch_kpi_periods set bookings_complete=false where month=date_trunc('month',new.stay_date)::date;
  end if;
 end if;
 return new;
end $$;
drop trigger if exists ch_kpi_review_changed on public.ch_bookings;
create trigger ch_kpi_review_changed after insert or update on public.ch_bookings for each row execute function public.ch_kpi_review_changed();
drop trigger if exists ch_kpi_review_changed on public.ch_room_nights;
create trigger ch_kpi_review_changed after insert or update on public.ch_room_nights for each row execute function public.ch_kpi_review_changed();
revoke execute on function public.ch_kpi_review_changed() from public,anon,authenticated;
create or replace function public.ch_owner_dashboard(p_month date)
returns jsonb language sql stable security invoker set search_path=public,pg_temp as $$
with bounds as (
 select date_trunc('month',coalesce(p_month,(now() at time zone 'Asia/Kolkata')::date))::date as a,
   (date_trunc('month',coalesce(p_month,(now() at time zone 'Asia/Kolkata')::date))+interval '1 month')::date as z
)
select jsonb_build_object('month_start',a,'month_end',z-1,
 'settings',(select to_jsonb(s) from ch_settings s where id=1),
 'room_types',(select jsonb_agg(to_jsonb(t) order by id) from ch_room_types t),
 'rooms',(select jsonb_agg(to_jsonb(r) order by id) from ch_rooms r),
 'calendar',(select jsonb_agg(jsonb_build_object('room_id',r.id,'date',ds::date,
   'is_open',coalesce(n.is_open,false),'out_of_order',coalesce(n.out_of_order,false),'note',coalesce(n.note,''),
   'booking',(select jsonb_build_object('id',bk.id,'reference',bk.reference,'guest_name',bk.guest_name,'status',bk.status)
     from ch_bookings bk where r.id=any(bk.room_ids) and bk.check_in<=ds::date and bk.check_out>ds::date
     and (bk.status='confirmed' or (bk.status='held' and bk.expires_at>now())) order by bk.created_at limit 1)) order by r.id,ds)
   from ch_rooms r cross join generate_series(a,z-1,interval '1 day') ds
   left join ch_room_nights n on n.room_id=r.id and n.stay_date=ds::date),
 'bookings',(select coalesce(jsonb_agg(to_jsonb(bk)-'token_hash'-'request_key' order by bk.created_at desc),'[]'::jsonb)
   from (select * from ch_bookings order by created_at desc limit 500) bk),
 'rates',(select coalesce(jsonb_agg(to_jsonb(r) order by stay_date,room_type),'[]'::jsonb) from ch_rates r
   where stay_date>=a and stay_date<z)) from bounds;
$$;
revoke execute on function public.ch_kpi_validate(jsonb,public.ch_bookings),public.ch_kpi_changed(),public.ch_kpi_open_room(),public.ch_kpi_owner_booking(jsonb),public.ch_kpi_payments(text,jsonb),public.ch_kpi(text,jsonb) from public,anon,authenticated;
grant execute on function public.ch_kpi_validate(jsonb,public.ch_bookings),public.ch_kpi_owner_booking(jsonb),public.ch_kpi_payments(text,jsonb),public.ch_kpi(text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
