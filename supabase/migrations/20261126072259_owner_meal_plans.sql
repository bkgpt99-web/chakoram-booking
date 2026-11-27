-- Owner rate / meal plans. Existing bookings intentionally remain unspecified.
-- Public guest checkout, agreed amounts and the reminder schedule are unchanged.
begin;
alter table public.ch_bookings add column if not exists meal_plan text
 check(meal_plan in ('ep','cp','ap','package'));
alter table public.ch_bookings add column if not exists meal_plan_note text not null default ''
 check(length(meal_plan_note)<=200);

create or replace function public.ch_owner_booking(p_input jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare
 s ch_settings%rowtype; b ch_bookings%rowtype; v_room_type text; capacity integer;
 a date; z date; ids text[]; q integer; g integer; total integer; nightly jsonb;
 v_id uuid; v_name text; v_email text; v_phone text; v_note text; v_source text;
 v_sale integer;v_advance integer;v_plan text;v_plan_note text;
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
 v_plan:=nullif(p_input->>'meal_plan','');v_plan_note:=trim(coalesce(p_input->>'meal_plan_note',''));
 if coalesce(jsonb_typeof(p_input->'meal_plan'),'null') not in ('null','string')
   or coalesce(jsonb_typeof(p_input->'meal_plan_note'),'null') not in ('null','string')
   or (v_plan is not null and v_plan not in ('ep','cp','ap','package')) or length(v_plan_note)>200
   then raise exception 'OWNER_INVALID_PLAN';end if;
 if editing then
   v_id:=(p_input->>'id')::uuid;
   select * into b from ch_bookings where id=v_id for update;
   if not found then raise exception 'NOT_FOUND'; end if;
   if b.owner_revision is distinct from (p_input->>'revision')::integer then raise exception 'OWNER_STALE'; end if;
   if b.status<>'confirmed' then raise exception 'OWNER_BOOKING_LOCKED'; end if;
   -- Older open tabs may omit these fields: preserve saved plans in that case.
   if not (p_input ? 'meal_plan') then v_plan:=b.meal_plan;end if;
   if not (p_input ? 'meal_plan_note') then v_plan_note:=b.meal_plan_note;end if;
   if v_plan is distinct from 'package' then v_plan_note:='';end if;
   if ((b.source='website' or b.order_id is not null or b.payment_id is not null) and v_source<>b.source)
     or (v_source='website' and b.source<>'website') then raise exception 'OWNER_SOURCE_LOCKED'; end if;
 else
   v_id:=(p_input->>'request_key')::uuid;
   v_sale:=(p_input->>'sale_amount_paise')::integer;
   v_advance:=coalesce((p_input->>'advance_paise')::integer,0);
   if v_sale<0 or v_sale>1000000000 or v_advance<0 or v_advance>1000000000 or
     (v_advance>0 and (v_sale is null or v_advance>v_sale)) then raise exception 'PAYMENT_INVALID_SALE'; end if;
   if v_id is null or v_source='website' then raise exception 'INVALID_REQUEST'; end if;
   if v_plan is distinct from 'package' then v_plan_note:='';end if;
   select * into b from ch_bookings where request_key=v_id;
   if found then
     if not b.owner_entry or (b.guest_name,b.email,b.phone,b.guest_note,b.source,b.room_ids,b.check_in,b.check_out,b.guests,b.meal_plan,b.meal_plan_note)
       is distinct from (v_name,v_email,v_phone,v_note,v_source,ids,a,z,g,v_plan,v_plan_note) then raise exception 'OWNER_REQUEST_REUSED'; end if;
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
     source=v_source,guests=g,room_type=v_room_type,room_ids=ids,check_in=a,check_out=z,meal_plan=v_plan,meal_plan_note=v_plan_note,
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
     guests,guest_name,email,phone,guest_note,total_paise,deposit_paise,nightly_rates,policy,status,source,expires_at,owner_entry,sale_amount_paise,offline_received_paise,meal_plan,meal_plan_note)
   values(v_id,'CH-'||upper(left(replace(v_id::text,'-',''),12)),v_id,
     encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex'),v_room_type,ids,a,z,
     g,v_name,v_email,v_phone,v_note,total,ceil(total*s.deposit_percent/100.0)::integer,
     nightly,s.cancellation_policy,'confirmed',v_source,now(),true,v_sale,v_advance,v_plan,v_plan_note)
   returning * into b;
   if v_advance>0 then
     insert into ch_booking_receipts(id,booking_id,amount_paise,method,note,created_by)
       values(v_id,v_id,v_advance,'other','Advance received when booking was entered',coalesce(p_input->>'actor','owner'));
     insert into ch_audit(action,details) values('payment_recorded',jsonb_build_object('id',v_id,'receipt_id',v_id,'amount_paise',v_advance,'actor',p_input->>'actor'));
   end if;
 end if;
 insert into ch_audit(action,details) values(case when editing then 'owner_booking_edit' else 'owner_booking_add' end,
   jsonb_build_object('id',b.id,'actor',p_input->>'actor','rooms',ids,'check_in',a,'check_out',z,'revision',b.owner_revision,'meal_plan',v_plan,'meal_plan_note',v_plan_note));
 return to_jsonb(b)-'token_hash'-'request_key';
end $$;


revoke execute on function public.ch_owner_booking(jsonb) from public,anon,authenticated;
grant execute on function public.ch_owner_booking(jsonb) to service_role;
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
     'booking',jsonb_build_object('id',b.id,'reference',b.reference,'guest_name',b.guest_name,'balance_paise',f->'balance_paise','meal_plan',b.meal_plan,'meal_plan_note',b.meal_plan_note));
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

revoke execute on function public.ch_payment_push(text,jsonb) from public,anon,authenticated;
grant execute on function public.ch_payment_push(text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
