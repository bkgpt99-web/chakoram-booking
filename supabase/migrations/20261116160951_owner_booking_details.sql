-- Owner booking entry and editing. Guest checkout keeps its existing validation.
-- Does not change existing stays, prices, availability or payment records.
begin;
alter table public.ch_bookings alter column guests drop not null;
alter table public.ch_bookings add column if not exists owner_entry boolean not null default false;
alter table public.ch_bookings add column if not exists owner_revision integer not null default 0;

create or replace function public.ch_owner_revision()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 new.owner_revision:=old.owner_revision+1;
 return new;
end $$;
drop trigger if exists ch_owner_revision on public.ch_bookings;
create trigger ch_owner_revision before update on public.ch_bookings
 for each row execute function public.ch_owner_revision();

-- Called only by the server after verifying the owner session and request origin.
-- SECURITY INVOKER retains the service role's existing RLS boundary.
create or replace function public.ch_owner_booking(p_input jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare
 s ch_settings%rowtype; b ch_bookings%rowtype; rt ch_room_types%rowtype;
 a date; z date; ids text[]; q integer; g integer; total integer; nightly jsonb;
 v_id uuid; v_name text; v_email text; v_phone text; v_note text; v_source text;
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
 select t.* into rt from ch_room_types t join ch_rooms r on r.room_type=t.id where r.id=ids[1];
 if exists(select 1 from ch_rooms where id=any(ids) and room_type<>rt.id) then raise exception 'OWNER_MIXED_ROOMS'; end if;
 g:=nullif(p_input->>'guests','')::integer;
 if g is not null and (g<q or g>q*rt.max_guests) then raise exception 'INVALID_ROOM_OR_GUESTS'; end if;
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
   if v_id is null or v_source='website' then raise exception 'INVALID_REQUEST'; end if;
   select * into b from ch_bookings where request_key=v_id;
   if found then
     if not b.owner_entry or (b.guest_name,b.email,b.phone,b.guest_note,b.source,b.room_ids,b.check_in,b.check_out,b.guests)
       is distinct from (v_name,v_email,v_phone,v_note,v_source,ids,a,z,g) then raise exception 'OWNER_REQUEST_REUSED'; end if;
     return to_jsonb(b)-'token_hash'-'request_key';
   end if;
 end if;
 if exists(select 1 from ch_bookings other where other.id<>v_id and other.room_ids && ids
   and other.check_in<z and other.check_out>a and
   (other.status='confirmed' or (other.status='held' and other.expires_at>now())))
   then raise exception 'RESERVATION_CONFLICT'; end if;
 if editing then
   update ch_bookings set guest_name=v_name,email=v_email,phone=v_phone,guest_note=v_note,
     source=v_source,guests=g,room_type=rt.id,room_ids=ids,check_in=a,check_out=z,
     synced_to_cm=case when (guest_name,source,guests,room_ids,check_in,check_out) is distinct from
       (v_name,v_source,g,ids,a,z) then false else synced_to_cm end
   where id=v_id returning * into b;
 else
   select sum(coalesce(r.rate_paise,rt.rate_paise))::integer*q,
     jsonb_agg(jsonb_build_object('date',ds::date,'rate_paise',coalesce(r.rate_paise,rt.rate_paise)) order by ds)
   into total,nightly from generate_series(a,z-1,interval '1 day') ds
   left join ch_rates r on r.room_type=rt.id and r.stay_date=ds::date;
   insert into ch_bookings(id,reference,request_key,token_hash,room_type,room_ids,check_in,check_out,
     guests,guest_name,email,phone,guest_note,total_paise,deposit_paise,nightly_rates,policy,status,source,expires_at,owner_entry)
   values(v_id,'CH-'||upper(left(replace(v_id::text,'-',''),12)),v_id,
     encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex'),rt.id,ids,a,z,
     g,v_name,v_email,v_phone,v_note,total,ceil(total*s.deposit_percent/100.0)::integer,
     nightly,s.cancellation_policy,'confirmed',v_source,now(),true)
   returning * into b;
 end if;
 insert into ch_audit(action,details) values(case when editing then 'owner_booking_edit' else 'owner_booking_add' end,
   jsonb_build_object('id',b.id,'actor',p_input->>'actor','rooms',ids,'check_in',a,'check_out',z,'revision',b.owner_revision));
 return to_jsonb(b)-'token_hash'-'request_key';
end $$;

-- Complete calendar month, including bookings crossing either month boundary.
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
   'is_open',coalesce(n.is_open,false),'note',coalesce(n.note,''),
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

revoke execute on function public.ch_owner_booking(jsonb),public.ch_owner_revision(),public.ch_owner_dashboard(date) from public,anon,authenticated;
grant execute on function public.ch_owner_booking(jsonb) to service_role;
grant execute on function public.ch_owner_dashboard(date) to service_role;
grant select,update on public.ch_settings to service_role;
grant select on public.ch_rooms,public.ch_room_types,public.ch_rates,public.ch_room_nights to service_role;
grant select,insert,update on public.ch_bookings to service_role;
grant insert on public.ch_audit to service_role;
grant usage on sequence public.ch_audit_id_seq to service_role;
notify pgrst,'reload schema';
commit;
