-- Agent 10 - subscription, usage, and device-cap schema.
--
-- The actual money flow lives in Paddle (web/desktop) and RevenueCat (mobile).
-- This file gives us:
--   1. meo.subscriptions  - current tier of record per user (one row, upsert).
--   2. meo.usage_log       - append-only counter for LLM tokens / storage usage.
--   3. meo.devices         - device fingerprints used for the per-tier device cap.
--
-- Webhooks (paddle-webhook, revenuecat-webhook) call SECURITY DEFINER RPCs to
-- write into these tables under the service role; clients only ever read their
-- own rows via RLS.

-- ----------------------------------------------------------------------------
-- meo.subscriptions
-- ----------------------------------------------------------------------------

create table if not exists meo.subscriptions (
  user_id              uuid primary key references auth.users(id) on delete cascade,
  tier                 text not null
    check (tier in ('free','hobbyist','business','enterprise'))
    default 'free',
  source               text
    check (source in ('paddle','revenuecat','manual')),
  external_id          text,                                 -- paddle subscription_id or RC entitlement id
  current_period_end   timestamptz,
  cancel_at_period_end boolean not null default false,
  raw                  jsonb,                                -- last webhook payload (debug)
  updated_at           timestamptz not null default now()
);

alter table meo.subscriptions enable row level security;

drop policy if exists "subscriptions: self read" on meo.subscriptions;
create policy "subscriptions: self read"
  on meo.subscriptions for select
  to authenticated
  using (user_id = auth.uid());

-- No client write/update/delete policies. The webhook calls
-- meo.upsert_subscription() under service_role.

-- ----------------------------------------------------------------------------
-- meo.usage_log - append-only meter
-- ----------------------------------------------------------------------------

create table if not exists meo.usage_log (
  id          bigserial primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null
    check (kind in ('llm_input','llm_output','storage_bytes','attachment_bytes')),
  amount      bigint not null,
  recorded_at timestamptz not null default now()
);

create index if not exists idx_meo_usage_user_time
  on meo.usage_log (user_id, recorded_at desc);

alter table meo.usage_log enable row level security;

drop policy if exists "usage_log: self read" on meo.usage_log;
create policy "usage_log: self read"
  on meo.usage_log for select
  to authenticated
  using (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- meo.devices - used by the free-tier device cap (1 device for free, 3 for hobbyist).
-- ----------------------------------------------------------------------------

create table if not exists meo.devices (
  user_id    uuid not null references auth.users(id) on delete cascade,
  device_id  text not null,
  last_seen  timestamptz not null default now(),
  ua         text,
  ip         text,
  primary key (user_id, device_id)
);

create index if not exists idx_meo_devices_user_lastseen
  on meo.devices (user_id, last_seen desc);

alter table meo.devices enable row level security;

drop policy if exists "devices: self read" on meo.devices;
create policy "devices: self read"
  on meo.devices for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "devices: self delete" on meo.devices;
create policy "devices: self delete"
  on meo.devices for delete
  to authenticated
  using (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- meo.upsert_subscription - service-role-only writer used by webhooks.
-- ----------------------------------------------------------------------------

create or replace function meo.upsert_subscription(
  p_user_id     uuid,
  p_tier        text,
  p_source      text,
  p_external_id text,
  p_period_end  timestamptz,
  p_cancel      boolean,
  p_raw         jsonb
) returns void
language plpgsql
security definer
set search_path = meo, public
as $$
begin
  insert into meo.subscriptions(
    user_id, tier, source, external_id,
    current_period_end, cancel_at_period_end, raw, updated_at
  ) values (
    p_user_id, p_tier, p_source, p_external_id,
    p_period_end, coalesce(p_cancel, false), p_raw, now()
  )
  on conflict (user_id) do update set
    tier                 = excluded.tier,
    source               = excluded.source,
    external_id          = excluded.external_id,
    current_period_end   = excluded.current_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end,
    raw                  = excluded.raw,
    updated_at           = now();
end;
$$;

revoke all on function meo.upsert_subscription(uuid, text, text, text, timestamptz, boolean, jsonb) from public;
grant execute on function meo.upsert_subscription(uuid, text, text, text, timestamptz, boolean, jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- meo.subscription_source - read helper used by webhooks to detect cross-store
-- conflicts before they create a duplicate purchase. Service-role only.
-- ----------------------------------------------------------------------------

create or replace function meo.subscription_source(p_user_id uuid)
returns table (tier text, source text, current_period_end timestamptz)
language sql
security definer
set search_path = meo, public
as $$
  select tier, source, current_period_end
    from meo.subscriptions
   where user_id = p_user_id;
$$;

revoke all on function meo.subscription_source(uuid) from public;
grant execute on function meo.subscription_source(uuid) to service_role;

-- ----------------------------------------------------------------------------
-- meo.device_seen - upsert + cap enforcement.
--
-- Counts distinct devices seen in the last 30 days. Returns 'ok' or
-- 'cap_reached'. The client treats 'cap_reached' as a 403 from the sync layer
-- (Agent 9 owns the UX for "pick a device to sign out").
-- ----------------------------------------------------------------------------

create or replace function meo.device_seen(
  p_device_id text,
  p_ua        text,
  p_ip        text
) returns text
language plpgsql
security definer
set search_path = meo, public, auth
as $$
declare
  v_user      uuid;
  v_tier      text;
  v_count     bigint;
  v_cap       int;
  v_existed   boolean;
begin
  v_user := auth.uid();
  if v_user is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  -- Already-seen devices never trip the cap; just refresh last_seen.
  select true into v_existed
    from meo.devices
   where user_id = v_user and device_id = p_device_id
   limit 1;

  if v_existed is null then
    -- New device - count existing distinct devices in last 30 days.
    select coalesce(count(distinct device_id), 0) into v_count
      from meo.devices
     where user_id = v_user
       and last_seen > now() - interval '30 days';

    select coalesce(tier, 'free') into v_tier
      from meo.subscriptions
     where user_id = v_user;
    v_tier := coalesce(v_tier, 'free');

    v_cap := case v_tier
      when 'free'       then 1
      when 'hobbyist'   then 3
      else 2147483647    -- effectively unlimited for business / enterprise
    end;

    if v_count >= v_cap then
      return 'cap_reached';
    end if;
  end if;

  insert into meo.devices(user_id, device_id, last_seen, ua, ip)
  values (v_user, p_device_id, now(), p_ua, p_ip)
  on conflict (user_id, device_id) do update set
    last_seen = now(),
    ua        = coalesce(excluded.ua, meo.devices.ua),
    ip        = coalesce(excluded.ip, meo.devices.ip);

  return 'ok';
end;
$$;

revoke all on function meo.device_seen(text, text, text) from public;
grant execute on function meo.device_seen(text, text, text) to authenticated;
