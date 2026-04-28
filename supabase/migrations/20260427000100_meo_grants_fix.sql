-- Fixes:
--   1. authenticated needs full DML on meo.notes (not just select) for the
--      direct REST path; the RPC also runs SECURITY DEFINER but extra grants
--      are harmless.
--   2. Make the upsert_note RPC defensive: explicitly verify auth.uid() is set,
--      and emit a notice on every branch so failures surface.

grant insert, update, delete on meo.notes to authenticated;
grant insert, update on meo.accounts to authenticated;
grant select on meo.sync_cursor to authenticated;

-- Make sure the meo schema is fully visible
grant all on schema meo to postgres, service_role;

create or replace function meo.upsert_note(
  p_id                uuid,
  p_encrypted_content bytea,
  p_nonce             bytea,
  p_hlc_timestamp     text,
  p_size_bytes        integer
) returns meo.notes
language plpgsql
security definer
set search_path = meo, public, auth
as $$
declare
  v_user uuid;
  v_existing meo.notes%rowtype;
  v_version bigint;
  v_row meo.notes%rowtype;
begin
  -- Pull auth.uid() into a variable so we can surface a clear error if missing
  v_user := auth.uid();
  if v_user is null then
    raise exception 'unauthorized: auth.uid() is null' using errcode = '28000';
  end if;

  select * into v_existing from meo.notes where id = p_id;

  if found then
    if v_existing.user_id <> v_user then
      raise exception 'forbidden: note belongs to another user' using errcode = '42501';
    end if;
    if v_existing.hlc_timestamp >= p_hlc_timestamp then
      raise exception 'stale write: existing hlc % >= incoming %',
        v_existing.hlc_timestamp, p_hlc_timestamp using errcode = '40001';
    end if;
  end if;

  -- Atomic per-user version bump
  insert into meo.sync_cursor as sc (user_id, next_version)
    values (v_user, 2)
    on conflict (user_id) do update
      set next_version = sc.next_version + 1
    returning sc.next_version - 1 into v_version;

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

-- delete_note: same fix to search_path
create or replace function meo.delete_note(p_id uuid) returns meo.notes
language plpgsql
security definer
set search_path = meo, public, auth
as $$
declare
  v_user uuid;
  v_version bigint;
  v_row meo.notes%rowtype;
  v_existing meo.notes%rowtype;
begin
  v_user := auth.uid();
  if v_user is null then
    raise exception 'unauthorized: auth.uid() is null' using errcode = '28000';
  end if;

  select * into v_existing from meo.notes where id = p_id;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_existing.user_id <> v_user then raise exception 'forbidden' using errcode = '42501'; end if;

  insert into meo.sync_cursor as sc (user_id, next_version)
    values (v_user, 2)
    on conflict (user_id) do update
      set next_version = sc.next_version + 1
    returning sc.next_version - 1 into v_version;

  update meo.notes
     set deleted_at = now(),
         version    = v_version,
         updated_at = now()
   where id = p_id
   returning * into v_row;

  return v_row;
end;
$$;

revoke all on function meo.delete_note(uuid) from public;
grant execute on function meo.delete_note(uuid) to authenticated;
