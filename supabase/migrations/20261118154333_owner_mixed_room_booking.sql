-- One owner reservation can contain Deluxe and Premium rooms.
-- Existing rows, prices, payment details and inventory remain untouched.
begin;
alter table public.ch_bookings alter column room_type drop not null;
comment on column public.ch_bookings.room_type is
 'Single room type, or NULL when room_ids span multiple types. Physical room_ids are authoritative.';

create or replace function public.ch_owner_booking(p_input jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare
 s ch_settings%rowtype; b ch_bookings%rowtype; v_room_type text; capacity integer;
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
     guests,guest_name,email,phone,guest_note,total_paise,deposit_paise,nightly_rates,policy,status,source,expires_at,owner_entry)
   values(v_id,'CH-'||upper(left(replace(v_id::text,'-',''),12)),v_id,
     encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex'),v_room_type,ids,a,z,
     g,v_name,v_email,v_phone,v_note,total,ceil(total*s.deposit_percent/100.0)::integer,
     nightly,s.cancellation_policy,'confirmed',v_source,now(),true)
   returning * into b;
 end if;
 insert into ch_audit(action,details) values(case when editing then 'owner_booking_edit' else 'owner_booking_add' end,
   jsonb_build_object('id',b.id,'actor',p_input->>'actor','rooms',ids,'check_in',a,'check_out',z,'revision',b.owner_revision));
 return to_jsonb(b)-'token_hash'-'request_key';
end $$;


revoke execute on function public.ch_owner_booking(jsonb) from public,anon,authenticated;
grant execute on function public.ch_owner_booking(jsonb) to service_role;
notify pgrst,'reload schema';
commit;
