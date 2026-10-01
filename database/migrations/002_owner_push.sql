-- Run once in the EXISTING booking Supabase project's SQL Editor.
-- Safe to rerun. Does not change room availability, payments or booking rules.
begin;
alter table public.ch_bookings add column if not exists cm_revision integer not null default 0;
alter table public.ch_bookings add column if not exists cm_updated_at timestamptz;
alter table public.ch_bookings add column if not exists cm_updated_by text;

-- Credentials are created server-side on first enable and never returned to browsers.
create table if not exists public.ch_push_settings (
 id integer primary key check(id=1), public_key text not null, private_key text not null,
 reminder_minutes integer not null default 60 check(reminder_minutes in (0,15,30,60,120)),
 created_at timestamptz not null default now()
);
create table if not exists public.ch_push_subscriptions (
 id uuid primary key default gen_random_uuid(), owner_email text not null,
 endpoint text not null unique, p256dh text not null, auth text not null,
 public_key text not null, label text not null default 'Phone or browser',
 created_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
 last_success_at timestamptz, last_error text
);
create table if not exists public.ch_push_tasks (
 booking_id uuid primary key references public.ch_bookings(id) on delete cascade,
 revision integer not null, kind text not null, previous_states jsonb not null default '[]'::jsonb,
 changed_at timestamptz not null default now(), resolved_at timestamptz,
 next_send_at timestamptz not null default now(), notification_count integer not null default 0,
 attempts integer not null default 0, lease_token uuid, lease_until timestamptz
);
create index if not exists ch_push_due on public.ch_push_tasks(next_send_at) where resolved_at is null;
create table if not exists public.ch_push_deliveries (
 booking_id uuid not null references public.ch_push_tasks(booking_id) on delete cascade,
 revision integer not null, notification_number integer not null,
 subscription_id uuid not null references public.ch_push_subscriptions(id) on delete cascade,
 sent_at timestamptz not null default now(),
 primary key(booking_id,revision,notification_number,subscription_id)
);

create or replace function public.ch_push_booking_change()
returns trigger language plpgsql security definer set search_path=public as $$
declare important boolean := false;
begin
 if tg_op='INSERT' then
   important := new.status in ('confirmed','payment_review');
 else
   important := (new.status in ('confirmed','payment_review') and
     (new.status is distinct from old.status or
      (new.check_in,new.check_out,new.room_type,new.room_ids) is distinct from
        (old.check_in,old.check_out,old.room_type,old.room_ids) or
      (new.attention<>'' and new.attention is distinct from old.attention))) or
     (new.status='cancelled' and old.status in ('confirmed','payment_review')) or
     (not new.synced_to_cm and old.synced_to_cm and new.status in ('confirmed','cancelled','payment_review'));
 end if;
 if important then
   new.cm_revision := coalesce(new.cm_revision,0)+1;
   new.synced_to_cm := false; new.cm_updated_at := null; new.cm_updated_by := null;
 elsif new.synced_to_cm and tg_op='UPDATE' and not old.synced_to_cm then
   new.cm_updated_at := now();
 end if;
 return new;
end $$;

create or replace function public.ch_push_booking_queue()
returns trigger language plpgsql security definer set search_path=public as $$
declare kind text; prior jsonb := '[]'::jsonb;
begin
 if new.synced_to_cm then
   update ch_push_tasks set resolved_at=now(),lease_token=null,lease_until=null
     where booking_id=new.id and resolved_at is null;
 elsif (tg_op='INSERT' and new.cm_revision>0) or
       (tg_op='UPDATE' and new.cm_revision is distinct from old.cm_revision) then
   kind := case when new.status='cancelled' then 'cancelled'
     when new.status='payment_review' or new.attention<>'' then 'review'
     when new.source='OTA' then 'external'
     when tg_op='UPDATE' and old.status='confirmed' then 'changed'
     when new.source<>'website' then 'manual' else 'confirmed' end;
   if tg_op='UPDATE' then
     prior := jsonb_build_array(jsonb_build_object('check_in',old.check_in,'check_out',old.check_out,
       'room_type',old.room_type,'room_ids',old.room_ids,'status',old.status));
   end if;
   insert into ch_push_tasks(booking_id,revision,kind,previous_states)
   values(new.id,new.cm_revision,kind,prior)
   on conflict(booking_id) do update set revision=excluded.revision,kind=excluded.kind,
     previous_states=case when ch_push_tasks.resolved_at is null
       then ch_push_tasks.previous_states || excluded.previous_states else excluded.previous_states end,
     changed_at=now(),resolved_at=null,next_send_at=now(),notification_count=0,attempts=0,
     lease_token=null,lease_until=null;
 end if;
 return new;
end $$;
drop trigger if exists ch_push_change on public.ch_bookings;
create trigger ch_push_change before insert or update on public.ch_bookings
 for each row execute function public.ch_push_booking_change();
drop trigger if exists ch_push_queue on public.ch_bookings;
create trigger ch_push_queue after insert or update on public.ch_bookings
 for each row execute function public.ch_push_booking_queue();

-- Only the server's service role can call this RPC. owner_email is supplied by
-- verified server authentication, never taken from a browser's request body.
create or replace function public.ch_push(p_action text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare s ch_push_settings%rowtype; sub ch_push_subscriptions%rowtype;
 t ch_push_tasks%rowtype; b ch_bookings%rowtype; result jsonb := '[]'::jsonb;
 v_owner text := lower(p_input->>'owner_email');
 today date := (now() at time zone 'Asia/Kolkata')::date;
begin
 if p_action='status' then
   return jsonb_build_object('ready',true,
     'public_key',(select public_key from ch_push_settings where id=1),
     'reminder_minutes',coalesce((select reminder_minutes from ch_push_settings where id=1),60),
     'subscriptions',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'label',label,
       'last_success_at',last_success_at,'last_error',last_error,'created_at',created_at)),'[]'::jsonb)
       from ch_push_subscriptions where owner_email=v_owner),
     'pending_count',(select count(*) from ch_push_tasks where resolved_at is null),
     'tasks',(select coalesce(jsonb_agg(x order by x->>'changed_at'),'[]'::jsonb) from
       (select jsonb_build_object('booking_id',task.booking_id,'revision',task.revision,'kind',task.kind,
         'previous_states',task.previous_states,'changed_at',task.changed_at,'next_send_at',task.next_send_at,
         'reference',booking.reference,'room_type',booking.room_type,'room_ids',booking.room_ids,
         'check_in',booking.check_in,'check_out',booking.check_out,'status',booking.status) x
       from ch_push_tasks task join ch_bookings booking on booking.id=task.booking_id
       where task.resolved_at is null order by task.changed_at limit 100) tasks));
 end if;
 if p_action='prepare' then
   insert into ch_push_settings(id,public_key,private_key)
    values(1,p_input->>'public_key',p_input->>'private_key') on conflict do nothing;
   -- Surface pre-existing FUTURE unsynced bookings when owner enables alerts.
   insert into ch_push_tasks(booking_id,revision,kind)
    select id,cm_revision,case when status='cancelled' then 'cancelled'
      when status='payment_review' or attention<>'' then 'review' when source='OTA' then 'external' else 'existing' end
    from ch_bookings where not synced_to_cm and check_out>today and
      (status in ('confirmed','payment_review') or (status='cancelled' and (paid_paise>0 or source<>'website')))
    on conflict do nothing;
   return jsonb_build_object('public_key',(select public_key from ch_push_settings where id=1));
 elsif p_action='subscribe' then
   select * into s from ch_push_settings where id=1 for update;
   if not found or s.public_key is distinct from p_input->>'public_key' then raise exception 'PUSH_KEY_CHANGED'; end if;
   if v_owner is null or length(v_owner)>180 then raise exception 'INVALID_REQUEST'; end if;
   if (select count(*) from ch_push_subscriptions where owner_email=v_owner)>=5
     and not exists(select 1 from ch_push_subscriptions where endpoint=p_input->>'endpoint' and owner_email=v_owner)
     then raise exception 'PUSH_DEVICE_LIMIT'; end if;
   insert into ch_push_subscriptions(owner_email,endpoint,p256dh,auth,public_key,label)
    values(v_owner,p_input->>'endpoint',p_input->>'p256dh',p_input->>'auth',s.public_key,left(p_input->>'label',80))
   on conflict(endpoint) do update set owner_email=excluded.owner_email,p256dh=excluded.p256dh,
    auth=excluded.auth,public_key=excluded.public_key,label=excluded.label,last_seen_at=now(),last_error=null
   returning * into sub;
   return jsonb_build_object('id',sub.id);
 elsif p_action='unsubscribe' then
   delete from ch_push_subscriptions where owner_email=v_owner and id=(p_input->>'id')::uuid;
   return jsonb_build_object('ok',true);
 elsif p_action='settings' then
   update ch_push_settings set reminder_minutes=(p_input->>'reminder_minutes')::integer where id=1;
   -- Changing reminder preferences applies to already-notified pending tasks.
   update ch_push_tasks set next_send_at=case when (p_input->>'reminder_minutes')::integer=0 then 'infinity'::timestamptz
     else now()+make_interval(mins=>(p_input->>'reminder_minutes')::integer) end
    where resolved_at is null and notification_count>0;
   return jsonb_build_object('ok',true);
 elsif p_action='ack' then
   -- Same lock order as ch_engine: settings, booking, task.
   perform 1 from ch_settings where id=1 for update;
   select * into b from ch_bookings where id=(p_input->>'booking_id')::uuid for update;
   if not found then raise exception 'NOT_FOUND'; end if;
   if b.cm_revision is distinct from (p_input->>'revision')::integer then raise exception 'PUSH_STALE'; end if;
   update ch_bookings set synced_to_cm=(p_input->>'synced')::boolean,cm_updated_by=v_owner where id=b.id returning * into b;
   insert into ch_audit(action,details) values('cm_acknowledged',jsonb_build_object('id',b.id,
     'owner',v_owner,'revision',b.cm_revision,'synced',b.synced_to_cm));
   return to_jsonb(b)-'token_hash';
 elsif p_action='snooze' then
   update ch_push_tasks set next_send_at=now()+interval '15 minutes',lease_token=null,lease_until=null
    where booking_id=(p_input->>'booking_id')::uuid and revision=(p_input->>'revision')::integer and resolved_at is null;
   if not found then raise exception 'PUSH_STALE'; end if;
   return jsonb_build_object('ok',true);
 elsif p_action='credentials' then
   select * into s from ch_push_settings where id=1;
   return coalesce(to_jsonb(s),'{}'::jsonb);
 elsif p_action='test_device' then
   select * into sub from ch_push_subscriptions where id=(p_input->>'id')::uuid and owner_email=v_owner;
   if not found then raise exception 'NOT_FOUND'; end if;
   return to_jsonb(sub);
 elsif p_action='claim' then
   if not exists(select 1 from ch_push_subscriptions where owner_email=v_owner) then return '[]'::jsonb; end if;
   for t in select task.* from ch_push_tasks task join ch_bookings booking on booking.id=task.booking_id
     where task.resolved_at is null and task.next_send_at<=now() and
       (task.lease_until is null or task.lease_until<now()) and not booking.synced_to_cm
       and booking.check_out>today
     order by task.next_send_at limit 3 for update of task skip locked loop
     update ch_push_tasks set lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes'
       where booking_id=t.booking_id returning * into t;
     select * into b from ch_bookings where id=t.booking_id;
     result := result || jsonb_build_array(to_jsonb(t) || jsonb_build_object('booking',
       jsonb_build_object('id',b.id,'reference',b.reference,'room_type',b.room_type,'quantity',cardinality(b.room_ids),
         'check_in',b.check_in,'check_out',b.check_out,'status',b.status),
       'subscriptions',(select coalesce(jsonb_agg(to_jsonb(device)),'[]'::jsonb) from ch_push_subscriptions device
         where device.owner_email=v_owner and not exists(select 1 from ch_push_deliveries d
           where d.booking_id=t.booking_id and d.revision=t.revision and d.notification_number=t.notification_count
             and d.subscription_id=device.id))));
   end loop;
   return result;
 elsif p_action='current' then
   return jsonb_build_object('current',exists(select 1 from ch_push_tasks
     where booking_id=(p_input->>'booking_id')::uuid and revision=(p_input->>'revision')::integer
       and lease_token=(p_input->>'lease_token')::uuid and lease_until>now() and resolved_at is null));
 elsif p_action='delivered' then
   insert into ch_push_deliveries(booking_id,revision,notification_number,subscription_id)
    select booking_id,revision,notification_count,(p_input->>'subscription_id')::uuid from ch_push_tasks
    where booking_id=(p_input->>'booking_id')::uuid and revision=(p_input->>'revision')::integer
      and lease_token=(p_input->>'lease_token')::uuid and resolved_at is null
      and exists(select 1 from ch_push_subscriptions where id=(p_input->>'subscription_id')::uuid)
    on conflict do nothing;
   update ch_push_subscriptions set last_success_at=now(),last_error=null where id=(p_input->>'subscription_id')::uuid;
   return jsonb_build_object('ok',true);
 elsif p_action='device_error' then
   if coalesce((p_input->>'expired')::boolean,false) then
     delete from ch_push_subscriptions where id=(p_input->>'subscription_id')::uuid;
   else
     update ch_push_subscriptions set last_error=left(p_input->>'error',100) where id=(p_input->>'subscription_id')::uuid;
   end if;
   return jsonb_build_object('ok',true);
 elsif p_action='finish' then
   select * into s from ch_push_settings where id=1;
   update ch_push_tasks set lease_token=null,lease_until=null,
     next_send_at=case when (p_input->>'success')::boolean then
       case when s.reminder_minutes=0 then 'infinity'::timestamptz
         when notification_count=0 then now()+interval '15 minutes'
         else now()+make_interval(mins=>s.reminder_minutes) end
       else now()+make_interval(mins=>least(15,power(2,least(attempts,4))::integer)) end,
     notification_count=notification_count+case when (p_input->>'success')::boolean then 1 else 0 end,
     attempts=case when (p_input->>'success')::boolean then 0 else attempts+1 end
    where booking_id=(p_input->>'booking_id')::uuid and revision=(p_input->>'revision')::integer
      and lease_token=(p_input->>'lease_token')::uuid and resolved_at is null;
   -- Keep small delivery receipts for retries; old revisions are no longer useful.
   delete from ch_push_deliveries d using ch_push_tasks task where d.booking_id=task.booking_id
     and (d.revision<>task.revision or d.notification_number<task.notification_count-1 or task.resolved_at is not null);
   return jsonb_build_object('ok',true);
 end if;
 raise exception 'INVALID_REQUEST';
end $$;

alter table public.ch_push_settings enable row level security;
alter table public.ch_push_subscriptions enable row level security;
alter table public.ch_push_tasks enable row level security;
alter table public.ch_push_deliveries enable row level security;
revoke all on public.ch_push_settings,public.ch_push_subscriptions,public.ch_push_tasks,public.ch_push_deliveries from public,anon,authenticated;
revoke execute on function public.ch_push_booking_change(),public.ch_push_booking_queue(),public.ch_push(text,jsonb) from public,anon,authenticated;
grant execute on function public.ch_push(text,jsonb) to service_role;
-- Existing pending stays appear in the owner desk even before phone permission.
insert into ch_push_tasks(booking_id,revision,kind)
 select id,cm_revision,case when status='cancelled' then 'cancelled'
   when status='payment_review' or attention<>'' then 'review'
   when source='OTA' then 'external' else 'existing' end
 from ch_bookings where not synced_to_cm and check_out>(now() at time zone 'Asia/Kolkata')::date and
   (status in ('confirmed','payment_review') or (status='cancelled' and (paid_paise>0 or source<>'website')))
 on conflict do nothing;
notify pgrst,'reload schema';
commit;
