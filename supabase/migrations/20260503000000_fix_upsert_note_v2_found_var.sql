-- ----------------------------------------------------------------------------
-- Bug fix: the v2 (6-arg, vault-aware) meo.upsert_note shipped in
-- 20260430000000_vault_columns.sql regressed the same FOUND-clobber bug
-- that 20260427000200_fix_found_var.sql had already fixed for the 5-arg
-- version. PL/pgSQL's implicit FOUND is overwritten by the intermediate
-- INSERT INTO meo.sync_cursor, so the subsequent `if found then UPDATE
-- ... else INSERT ...` branches on the WRONG value.
--
-- Net effect for a brand-new note:
--   1. SELECT INTO v_existing finds nothing -> FOUND = false (correct)
--   2. INSERT INTO meo.sync_cursor inserts a row -> FOUND = true (clobber)
--   3. `if found then UPDATE meo.notes WHERE id = p_id` -> matches 0 rows
--   4. RETURNING * INTO v_row leaves v_row entirely NULL
--   5. The actual INSERT INTO meo.notes never runs
--   6. Function returns a row of all NULLs; client thinks save succeeded
--      but the note is not in the database
--
-- AI-driven CRUD via Ask Meo surfaced this most visibly because the
-- chip flips to "Applied" then the note vanishes on next sync pull.
-- Manual edits hit the same bug for any first-write of a new uuid;
-- updates of existing notes happened to work because the SELECT INTO
-- found the row and the UPDATE branch matches by id regardless of
-- the bogus FOUND value.
--
-- Fix: capture FOUND into a local v_existed boolean immediately after
-- the SELECT, then key all subsequent decisions off v_existed. Same
-- pattern that the 5-arg version uses; we should have copied it
-- when adding p_is_vault and didn't.
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
set search_path = meo, public, auth
as $$
declare
  v_user      uuid;
  v_existing  meo.notes%rowtype;
  v_existed   boolean;
  v_version   bigint;
  v_row       meo.notes%rowtype;
begin
  v_user := auth.uid();
  if v_user is null then
    raise exception 'unauthorized: auth.uid() is null' using errcode = '28000';
  end if;

  select * into v_existing from meo.notes where id = p_id;
  v_existed := found;

  if v_existed then
    if v_existing.user_id <> v_user then
      raise exception 'forbidden: note belongs to another user'
        using errcode = '42501';
    end if;
    if v_existing.hlc_timestamp >= p_hlc_timestamp then
      raise exception 'stale write: existing hlc % >= incoming %',
        v_existing.hlc_timestamp, p_hlc_timestamp
        using errcode = '40001';
    end if;
  end if;

  -- Bump per-user version counter atomically. NB: this INSERT clobbers
  -- the implicit FOUND, which is exactly what the original bug missed.
  -- We've already snapshotted FOUND into v_existed, so it's safe.
  insert into meo.sync_cursor as sc (user_id, next_version)
    values (v_user, 2)
    on conflict (user_id) do update
      set next_version = sc.next_version + 1
    returning sc.next_version - 1 into v_version;

  if v_existed then
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
    insert into meo.notes (
      id, user_id, encrypted_content, nonce, version,
      hlc_timestamp, updated_at, deleted_at, size_bytes, is_vault
    )
    values (
      p_id, v_user, p_encrypted_content, p_nonce, v_version,
      p_hlc_timestamp, now(), null, p_size_bytes, coalesce(p_is_vault, false)
    )
    returning * into v_row;
  end if;

  return v_row;
end;
$$;

revoke all on function meo.upsert_note(uuid, bytea, bytea, text, integer, boolean) from public;
grant execute on function meo.upsert_note(uuid, bytea, bytea, text, integer, boolean) to authenticated;

-- Nudge PostgREST to drop its cached function signatures so clients
-- see the corrected body immediately instead of after the next manual
-- restart. (Idempotent; the LISTEN side ignores it if no one is
-- subscribed.)
notify pgrst, 'reload schema';
