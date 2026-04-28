-- Switch from SQLSTATE 40001 (serialization_failure — PostgREST retries this!)
-- to P0001 (raise_exception, the plpgsql default) so the 409 propagates
-- immediately without retries.

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
  v_user      uuid;
  v_existing  meo.notes%rowtype;
  v_existed   boolean;
  v_version   bigint;
  v_row       meo.notes%rowtype;
begin
  v_user := auth.uid();
  if v_user is null then
    raise exception 'unauthorized: auth.uid() is null';
  end if;

  select * into v_existing from meo.notes where id = p_id;
  v_existed := found;

  if v_existed then
    if v_existing.user_id <> v_user then
      raise exception 'forbidden: note belongs to another user';
    end if;
    if v_existing.hlc_timestamp >= p_hlc_timestamp then
      raise exception 'stale write: existing hlc % >= incoming %',
        v_existing.hlc_timestamp, p_hlc_timestamp;
    end if;
  end if;

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
  if v_user is null then raise exception 'unauthorized: auth.uid() is null'; end if;

  select * into v_existing from meo.notes where id = p_id;
  if not found then raise exception 'not found'; end if;
  if v_existing.user_id <> v_user then raise exception 'forbidden'; end if;

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
