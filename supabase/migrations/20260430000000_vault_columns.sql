-- Agent 8 - Vault feature.
--
-- Adds an `is_vault` flag to meo.notes so the server-side sync path can hand
-- the client a row tagged "this body is double-wrapped, render locked
-- preview before any unlock prompt fires". The actual second crypto layer
-- happens entirely on the client (HKDF-derived vault_key wrapping the body
-- string before the existing per-note AES-GCM); the server only stores the
-- bool so it can return it on syncNotes() without forcing the client to peek
-- inside ciphertext.
--
-- We also widen meo.upsert_note() to accept and persist the flag, and
-- meo.delete_note() returns the new column so callers can keep using
-- `EncryptedNoteRow` everywhere.

alter table meo.notes
  add column if not exists is_vault boolean not null default false;

create index if not exists idx_notes_user_vault
  on meo.notes (user_id, is_vault) where is_vault = true;

-- ----------------------------------------------------------------------------
-- meo.upsert_note v2 - adds p_is_vault. We replace the function in-place
-- (same name, new arg list) so the existing 5-arg signature can be dropped
-- once the desktop client picks up the new shape. Both signatures coexist
-- during the rollout to avoid breaking older clients between deploy and
-- desktop autoupdate.
-- ----------------------------------------------------------------------------
create or replace function meo.upsert_note(
  p_id                uuid,
  p_encrypted_content bytea,
  p_nonce             bytea,
  p_hlc_timestamp     text,
  p_size_bytes        integer,
  p_is_vault          boolean
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
begin
  if v_user is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  select * into v_existing from meo.notes where id = p_id;

  if found and v_existing.user_id <> v_user then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- last-write-wins by HLC: if existing row's HLC >= incoming, reject as stale
  if found and v_existing.hlc_timestamp >= p_hlc_timestamp then
    raise exception 'stale write: existing hlc % >= incoming %',
      v_existing.hlc_timestamp, p_hlc_timestamp
      using errcode = '40001';
  end if;

  -- bump per-user version counter atomically
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
           size_bytes        = p_size_bytes,
           is_vault          = coalesce(p_is_vault, false)
     where id = p_id
     returning * into v_row;
  else
    insert into meo.notes (id, user_id, encrypted_content, nonce, version, hlc_timestamp, updated_at, deleted_at, size_bytes, is_vault)
      values (p_id, v_user, p_encrypted_content, p_nonce, v_version, p_hlc_timestamp, now(), null, p_size_bytes, coalesce(p_is_vault, false))
      returning * into v_row;
  end if;

  return v_row;
end;
$$;

revoke all on function meo.upsert_note(uuid, bytea, bytea, text, integer, boolean) from public;
grant execute on function meo.upsert_note(uuid, bytea, bytea, text, integer, boolean) to authenticated;

-- Keep the legacy 5-arg signature alive: defaults to is_vault=false. Lets
-- mid-update older clients keep saving notes during the rollout window.
create or replace function meo.upsert_note(
  p_id                uuid,
  p_encrypted_content bytea,
  p_nonce             bytea,
  p_hlc_timestamp     text,
  p_size_bytes        integer
) returns meo.notes
language sql
security definer
set search_path = meo, public
as $$
  select meo.upsert_note(p_id, p_encrypted_content, p_nonce, p_hlc_timestamp, p_size_bytes, false);
$$;

revoke all on function meo.upsert_note(uuid, bytea, bytea, text, integer) from public;
grant execute on function meo.upsert_note(uuid, bytea, bytea, text, integer) to authenticated;
