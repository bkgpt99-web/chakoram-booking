-- Independent reminders for the property's physical booking wall.
begin;
create table if not exists public.ch_wall_settings (
 id integer primary key check(id=1),reminder_minutes integer not null default 60 check(reminder_minutes in (0,15,30,60,120))
);
insert into public.ch_wall_settings(id) values(1) on conflict do nothing;
create table if not exists public.ch_wall_tasks (
 booking_id uuid primary key references public.ch_bookings(id) on delete cascade,
 revision integer not null default 1,kind text not null,
 previous_states jsonb not null default '[]'::jsonb,changed_at timestamptz not null default now(),
 resolved_at timestamptz,resolved_by text,next_send_at timestamptz not null default now(),
 notification_count integer not null default 0,attempts integer not null default 0,lease_token uuid,lease_until timestamptz
);
create index if not exists ch_wall_due on public.ch_wall_tasks(next_send_at) where resolved_at is null;
create table if not exists public.ch_wall_deliveries (
 booking_id uuid not null references public.ch_wall_tasks(booking_id) on delete cascade,
 revision integer not null,notification_number integer not null,
 subscription_id uuid not null references public.ch_push_subscriptions(id) on delete cascade,
 sent_at timestamptz not null default now(),primary key(booking_id,revision,notification_number,subscription_id)
);
create index if not exists ch_wall_delivery_device on public.ch_wall_deliveries(subscription_id);

create or replace function public.ch_wall_queue()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
declare important boolean;prior jsonb:='[]'::jsonb;k text;
begin
 if tg_op='INSERT' then important:=new.status in ('confirmed','payment_review');
 else
   important:=(new.status in ('confirmed','payment_review') and
     (new.status,new.guest_name,new.check_in,new.check_out,new.room_ids,new.source,new.guests) is distinct from
     (old.status,old.guest_name,old.check_in,old.check_out,old.room_ids,old.source,old.guests)) or
     (new.status='cancelled' and old.status in ('confirmed','payment_review'));
   if important then prior:=jsonb_build_array(jsonb_build_object('guest_name',old.guest_name,'room_ids',old.room_ids,
     'check_in',old.check_in,'check_out',old.check_out,'status',old.status));end if;
 end if;
 if important then
   k:=case when new.status='cancelled' then 'cancelled' when new.status='payment_review' then 'review'
     when tg_op='UPDATE' and old.status='confirmed' then 'changed' else 'new' end;
   insert into ch_wall_tasks(booking_id,kind,previous_states) values(new.id,k,prior)
   on conflict(booking_id) do update set revision=ch_wall_tasks.revision+1,kind=excluded.kind,
     previous_states=case when ch_wall_tasks.resolved_at is null then ch_wall_tasks.previous_states||excluded.previous_states else excluded.previous_states end,
     changed_at=now(),resolved_at=null,resolved_by=null,next_send_at=now(),notification_count=0,attempts=0,lease_token=null,lease_until=null;
 end if;
 return new;
end $$;
drop trigger if exists ch_wall_queue on public.ch_bookings;
create trigger ch_wall_queue after insert or update on public.ch_bookings for each row execute function public.ch_wall_queue();
-- Existing active stays need an explicit wall check; CM completion does not imply wall completion.
insert into public.ch_wall_tasks(booking_id,kind)
 select id,'existing' from public.ch_bookings where status in ('confirmed','payment_review')
 and check_out>(now() at time zone 'Asia/Kolkata')::date on conflict do nothing;

create or replace function public.ch_wall(p_action text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare t ch_wall_tasks%rowtype;b ch_bookings%rowtype;result jsonb:='[]'::jsonb;
 v_owner text:=lower(p_input->>'owner_email');today date:=(now() at time zone 'Asia/Kolkata')::date;
 minutes integer;page_offset integer:=greatest(0,coalesce((p_input->>'offset')::integer,0));
begin
 if p_action='status' then
   return jsonb_build_object('reminder_minutes',(select reminder_minutes from ch_wall_settings where id=1),
    'pending_count',(select count(*) from ch_wall_tasks task join ch_bookings booking on booking.id=task.booking_id where task.resolved_at is null and booking.check_out>today),
    'offset',page_offset,'tasks',(select coalesce(jsonb_agg(to_jsonb(p)),'[]'::jsonb) from (
      select task.booking_id,task.revision,task.kind,task.previous_states,task.next_send_at,
       booking.reference,booking.guest_name,booking.room_ids,booking.check_in,booking.check_out,booking.status
      from ch_wall_tasks task join ch_bookings booking on booking.id=task.booking_id
      where task.resolved_at is null and booking.check_out>today order by booking.check_in,task.changed_at,task.booking_id
      limit 50 offset page_offset) p));
 elsif p_action='booking' then
   select * into t from ch_wall_tasks where booking_id=(p_input->>'booking_id')::uuid;
   if not found then return 'null'::jsonb;end if;
   return jsonb_build_object('booking_id',t.booking_id,'revision',t.revision,'pending',t.resolved_at is null,'updated_at',t.resolved_at);
 elsif p_action='settings' then
   minutes:=(p_input->>'reminder_minutes')::integer;
   if minutes is null or minutes not in (0,15,30,60,120) then raise exception 'INVALID_REQUEST';end if;
   update ch_wall_settings set reminder_minutes=minutes where id=1;
   update ch_wall_tasks set next_send_at=case when minutes=0 then 'infinity'::timestamptz else now()+make_interval(mins=>minutes) end where resolved_at is null and notification_count>0;
   insert into ch_audit(action,details) values('wall_reminders_setting',jsonb_build_object('owner',v_owner,'minutes',minutes));
   return jsonb_build_object('ok',true);
 elsif p_action='ack' then
   if jsonb_typeof(p_input->'updated') is distinct from 'boolean' then raise exception 'INVALID_REQUEST';end if;
   perform 1 from ch_settings where id=1 for update;
   perform 1 from ch_bookings where id=(p_input->>'booking_id')::uuid for update;
   select * into t from ch_wall_tasks where booking_id=(p_input->>'booking_id')::uuid for update;
   if not found then raise exception 'NOT_FOUND';end if;
   if t.revision is distinct from (p_input->>'revision')::integer then raise exception 'WALL_STALE';end if;
   if (p_input->>'updated')::boolean then
     update ch_wall_tasks set resolved_at=now(),resolved_by=v_owner,lease_token=null,lease_until=null where booking_id=t.booking_id;
   elsif t.resolved_at is not null then
     update ch_wall_tasks set resolved_at=null,resolved_by=null,revision=revision+1,kind='existing',next_send_at=now(),notification_count=0,attempts=0,lease_token=null,lease_until=null where booking_id=t.booking_id;
   end if;
   insert into ch_audit(action,details) values('wall_acknowledged',jsonb_build_object('id',t.booking_id,'owner',v_owner,'revision',t.revision,'updated',p_input->'updated'));
   return ch_wall('booking',p_input);
 elsif p_action='snooze' then
   update ch_wall_tasks set next_send_at=now()+interval '15 minutes',lease_token=null,lease_until=null
    where booking_id=(p_input->>'booking_id')::uuid and revision=(p_input->>'revision')::integer and resolved_at is null;
   if not found then raise exception 'WALL_STALE';end if;
   return jsonb_build_object('ok',true);
 elsif p_action='claim' then
   if not exists(select 1 from ch_push_subscriptions where owner_email=v_owner) then return result;end if;
   for t in select task.* from ch_wall_tasks task join ch_bookings booking on booking.id=task.booking_id
    where task.resolved_at is null and task.next_send_at<=now() and (task.lease_until is null or task.lease_until<now())
      and booking.check_out>today order by task.next_send_at limit 3 for update of task skip locked loop
    update ch_wall_tasks set lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes' where booking_id=t.booking_id returning * into t;
    result:=result||jsonb_build_array(jsonb_build_object('booking_id',t.booking_id,'revision',t.revision,'lease_token',t.lease_token,
     'subscriptions',(select coalesce(jsonb_agg(to_jsonb(device)),'[]'::jsonb) from ch_push_subscriptions device where device.owner_email=v_owner
      and not exists(select 1 from ch_wall_deliveries d where d.booking_id=t.booking_id and d.revision=t.revision and d.notification_number=t.notification_count and d.subscription_id=device.id))));
   end loop;
   return result;
 elsif p_action='current' then
   select * into t from ch_wall_tasks where booking_id=(p_input->>'booking_id')::uuid and revision=(p_input->>'revision')::integer
    and lease_token=(p_input->>'lease_token')::uuid and lease_until>now() and resolved_at is null;
   if not found then return jsonb_build_object('current',false);end if;
   select * into b from ch_bookings where id=t.booking_id;
   if b.check_out<=today then return jsonb_build_object('current',false);end if;
   return jsonb_build_object('current',true,'kind',t.kind,'booking',jsonb_build_object('id',b.id,'guest_name',b.guest_name,'reference',b.reference,'room_ids',b.room_ids,'check_in',b.check_in,'check_out',b.check_out));
 elsif p_action='delivered' then
   insert into ch_wall_deliveries(booking_id,revision,notification_number,subscription_id)
   select booking_id,revision,notification_count,(p_input->>'subscription_id')::uuid from ch_wall_tasks
    where booking_id=(p_input->>'booking_id')::uuid and revision=(p_input->>'revision')::integer
      and lease_token=(p_input->>'lease_token')::uuid and lease_until>now() and resolved_at is null
      and exists(select 1 from ch_push_subscriptions where id=(p_input->>'subscription_id')::uuid)
   on conflict do nothing;
   return jsonb_build_object('ok',true);
 elsif p_action='finish' then
   select reminder_minutes into minutes from ch_wall_settings where id=1;
   update ch_wall_tasks set lease_token=null,lease_until=null,
    next_send_at=case when (p_input->>'success')::boolean then case when minutes=0 then 'infinity'::timestamptz else now()+make_interval(mins=>minutes) end
      else now()+make_interval(mins=>least(15,power(2,least(attempts,4))::integer)) end,
    notification_count=notification_count+case when (p_input->>'success')::boolean then 1 else 0 end,
    attempts=case when (p_input->>'success')::boolean then 0 else attempts+1 end
    where booking_id=(p_input->>'booking_id')::uuid and revision=(p_input->>'revision')::integer
      and lease_token=(p_input->>'lease_token')::uuid and lease_until>now() and resolved_at is null;
   delete from ch_wall_deliveries d using ch_wall_tasks task where d.booking_id=task.booking_id
     and (d.revision<>task.revision or d.notification_number<task.notification_count-1 or task.resolved_at is not null);
   return jsonb_build_object('ok',true);
 end if;
 raise exception 'INVALID_REQUEST';
end $$;
alter table public.ch_wall_tasks enable row level security;
alter table public.ch_wall_settings enable row level security;
alter table public.ch_wall_deliveries enable row level security;
revoke all on public.ch_wall_tasks,public.ch_wall_settings,public.ch_wall_deliveries from public,anon,authenticated;
grant select,insert,update,delete on public.ch_wall_tasks,public.ch_wall_settings,public.ch_wall_deliveries to service_role;
do $$ declare n text;begin foreach n in array array['ch_wall_tasks','ch_wall_settings','ch_wall_deliveries'] loop
 if not exists(select 1 from pg_policies where schemaname='public' and tablename=n and policyname='service_only') then
  execute format('create policy service_only on public.%I for all to service_role using (true) with check (true)',n);
 end if;end loop;end $$;
revoke execute on function public.ch_wall_queue(),public.ch_wall(text,jsonb) from public,anon,authenticated;
grant execute on function public.ch_wall_queue(),public.ch_wall(text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
