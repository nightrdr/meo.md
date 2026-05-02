-- Agent 9 — Device list (Settings → Devices) + free-tier device cap.
--
-- Agent 10 already created the bare meo.devices table (user_id, device_id,
-- last_seen, ua, ip) for the cap probe. This migration:
--   1. adds the user-facing columns (name, platform, first_seen_at, current)
--      so the Settings → Devices pane has something to render;
--   2. exposes a meo.devices_list() helper that returns the caller's rows
--      with friendly column names (the table is in `meo` schema and the
--      Supabase client already routes through `meo`);
--   3. adds meo.device_register(p_device_id, p_platform, p_name, p_ua) used
--      on every cold start to upsert the row + bump last_seen;
--   4. adds meo.device_revoke(p_device_id) — explicit "sign out of this
--      device" called from the UI. We keep RLS DELETE for free-tier hard
--      cap fallback, but a DEFINER fn lets us also bump the cron-friendly
--      revoked_at column down the road.
--
-- The cap itself is enforced by a trigger on meo.notes (next migration);
-- this file only models the data.

-- ── Add user-friendly columns to meo.devices ──
alter table meo.devices
  add column if not exists name           text not null default 'Unnamed device',
  add column if not exists platform       text not null default 'unknown',
  add column if not exists first_seen_at  timestamptz not null default now();
-- We don't store a server-side `current` flag — "current" is a property
-- of *the caller's* device id, computed client-side.

-- ── RPC: list this user's devices ──
create or replace function meo.devices_list()
returns table (
  device_id      text,
  name           text,
  platform       text,
  ua             text,
  ip             text,
  first_seen_at  timestamptz,
  last_seen      timestamptz
)
language sql
security definer
set search_path = meo, public, auth
as $$
  select device_id, name, platform, ua, ip::text, first_seen_at, last_seen
    from meo.devices
   where user_id = auth.uid()
   order by last_seen desc;
$$;

revoke all on function meo.devices_list() from public;
grant execute on function meo.devices_list() to authenticated;

-- ── RPC: register / refresh this device's row ──
-- Called from a fresh cold start once the user is signed in. Splits into
-- "first time" (insert with name + platform) and "subsequent" (touch
-- last_seen + refresh ua/ip but never overwrite a user-edited name).
create or replace function meo.device_register(
  p_device_id text,
  p_platform  text,
  p_name      text,
  p_ua        text
) returns text
language plpgsql
security definer
set search_path = meo, public, auth
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  insert into meo.devices(user_id, device_id, name, platform, ua, last_seen, first_seen_at)
  values (v_user, p_device_id, coalesce(p_name, 'Unnamed device'),
          coalesce(p_platform, 'unknown'), p_ua, now(), now())
  on conflict (user_id, device_id) do update set
    last_seen = now(),
    -- Refresh ua only — name + platform stay sticky once a row is set.
    ua = coalesce(excluded.ua, meo.devices.ua);

  return 'ok';
end;
$$;

revoke all on function meo.device_register(text, text, text, text) from public;
grant execute on function meo.device_register(text, text, text, text) to authenticated;

-- ── RPC: revoke a single device row ──
-- (RLS DELETE policy already covers this; the named RPC just gives the
--  client a simple, audit-friendly entry point.)
create or replace function meo.device_revoke(p_device_id text)
returns text
language plpgsql
security definer
set search_path = meo, public, auth
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  delete from meo.devices
   where user_id = v_user and device_id = p_device_id;

  return 'ok';
end;
$$;

revoke all on function meo.device_revoke(text) from public;
grant execute on function meo.device_revoke(text) to authenticated;

-- Make sure PostgREST sees the column changes immediately.
notify pgrst, 'reload schema';
