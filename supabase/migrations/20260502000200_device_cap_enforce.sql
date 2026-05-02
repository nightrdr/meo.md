-- Agent 9 - enforce per-tier device cap on every note write.
--
-- Strategy: meo.devices is updated on app cold-start via meo.device_register
-- (and was already touched by Agent 10's meo.device_seen). The cap is a
-- *count of distinct devices in the last 30 days*. We enforce it in
-- meo.upsert_note so a brand-new device past the cap can read its own data
-- but can't push new edits - the client surfaces a friendly modal asking
-- the user to free a device slot first.
--
-- We *don't* enforce on meo.device_register itself - registering a row past
-- the cap is fine; the row exists so the user can see it in Settings →
-- Devices and remove the *other* device. Enforcing here would lock a user
-- out of even seeing their device list. The Settings UI then explains why
-- new edits are blocked.

create or replace function meo.check_device_quota()
returns text
language plpgsql
security definer
set search_path = meo, public, auth
as $$
declare
  v_user  uuid := auth.uid();
  v_tier  text;
  v_count bigint;
  v_cap   int;
begin
  if v_user is null then
    return 'unauthorized';
  end if;

  select coalesce(count(distinct device_id), 0) into v_count
    from meo.devices
   where user_id = v_user
     and last_seen > now() - interval '30 days';

  if v_count <= 0 then
    -- A user with zero active device rows is implicitly inside the cap.
    -- Most likely a fresh sign-up where device_register hasn't fired yet.
    return 'ok';
  end if;

  select coalesce(tier, 'free') into v_tier
    from meo.subscriptions
   where user_id = v_user;
  v_tier := coalesce(v_tier, 'free');

  v_cap := case v_tier
    when 'free'     then 1
    when 'hobbyist' then 3
    else 2147483647
  end;

  if v_count > v_cap then
    return 'cap_reached';
  end if;
  return 'ok';
end;
$$;

revoke all on function meo.check_device_quota() from public;
grant execute on function meo.check_device_quota() to authenticated;

-- Re-create meo.upsert_note with a quota check at the top. Body is the
-- original logic verbatim except for the new check.
create or replace function meo.upsert_note(
  p_id                uuid,
  p_encrypted_content bytea,
  p_nonce             bytea,
  p_hlc_timestamp     text,
  p_size_bytes        integer
) returns meo.notes
language plpgsql
security definer
set search_path = meo, public
as $$
declare
  v_user uuid := auth.uid();
  v_existing meo.notes%rowtype;
  v_version bigint;
  v_row meo.notes%rowtype;
  v_quota text;
begin
  if v_user is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  -- Per-tier device cap (Agent 9). Counts distinct devices seen in the
  -- last 30 days; rejects new writes with SQLSTATE 'P0009' which the
  -- shared API layer maps to ApiError(429, code 'device_cap_exceeded').
  v_quota := meo.check_device_quota();
  if v_quota = 'cap_reached' then
    raise exception 'device_cap_exceeded' using errcode = 'P0009';
  end if;

  select * into v_existing from meo.notes where id = p_id;

  if found and v_existing.user_id <> v_user then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if found and v_existing.hlc_timestamp >= p_hlc_timestamp then
    raise exception 'stale write: existing hlc % >= incoming %',
      v_existing.hlc_timestamp, p_hlc_timestamp
      using errcode = '40001';
  end if;

  insert into meo.sync_cursor (user_id, next_version)
    values (v_user, 2)
  on conflict (user_id) do update
    set next_version = meo.sync_cursor.next_version + 1
  returning meo.sync_cursor.next_version - 1 into v_version;

  if found then
    update meo.notes
       set encrypted_content = p_encrypted_content,
           nonce             = p_nonce,
           version           = v_version,
           hlc_timestamp     = p_hlc_timestamp,
           updated_at        = now(),
           deleted_at        = null,
           size_bytes        = p_size_bytes
     where id = p_id
     returning * into v_row;
  else
    insert into meo.notes (id, user_id, encrypted_content, nonce, version, hlc_timestamp, updated_at, deleted_at, size_bytes)
      values (p_id, v_user, p_encrypted_content, p_nonce, v_version, p_hlc_timestamp, now(), null, p_size_bytes)
      returning * into v_row;
  end if;

  return v_row;
end;
$$;

revoke all on function meo.upsert_note(uuid, bytea, bytea, text, integer) from public;
grant execute on function meo.upsert_note(uuid, bytea, bytea, text, integer) to authenticated;

notify pgrst, 'reload schema';
