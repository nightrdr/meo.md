-- Workspace-wide attachment quota.
--
-- Spec §3.8 calls for a 10 GB per-account quota signaled to the client and
-- enforced server-side via SUM(encrypted_size). The 100 MB per-attachment
-- cap is already enforced inside meo.attachments_create; this migration adds
-- the workspace-wide ceiling.
--
-- We enforce inside the same SECURITY DEFINER function (rather than a trigger)
-- so the cap check and the insert sit in the same transaction with no
-- TOCTOU race. The query is fast: we have idx_meo_attachments_user (user_id,
-- created_at desc), and the row count per user is small relative to typical
-- Postgres working set.

create or replace function meo.attachments_create(
  p_id                 uuid,
  p_note_id            uuid,
  p_storage_key        text,
  p_storage_backend    text,
  p_encrypted_size     bigint,
  p_nonce              bytea,
  p_encrypted_metadata bytea,
  p_metadata_nonce     bytea
) returns meo.attachments
language plpgsql
security definer
set search_path = meo, public, auth
as $$
declare
  v_user        uuid;
  v_note_owner  uuid;
  v_used        bigint;
  v_row         meo.attachments%rowtype;
  -- 10 GiB per the spec.
  c_quota       constant bigint := 10 * 1024::bigint * 1024 * 1024;
  c_per_attach  constant bigint := 110 * 1024::bigint * 1024;     -- 110 MiB ciphertext budget
begin
  v_user := auth.uid();
  if v_user is null then
    raise exception 'unauthorized: auth.uid() is null' using errcode = '28000';
  end if;

  -- The note must exist AND belong to the caller.
  select user_id into v_note_owner from meo.notes where id = p_note_id;
  if not found then
    raise exception 'note not found' using errcode = 'P0002';
  end if;
  if v_note_owner <> v_user then
    raise exception 'forbidden: note belongs to another user' using errcode = '42501';
  end if;

  -- Per-attachment cap (100 MiB plaintext + per-chunk GCM tags).
  if p_encrypted_size > c_per_attach then
    raise exception 'attachment too large: % bytes (max % bytes ciphertext)',
      p_encrypted_size, c_per_attach
      using errcode = '22000';
  end if;

  -- Workspace-wide quota.
  select coalesce(sum(encrypted_size), 0)
    into v_used
    from meo.attachments
   where user_id = v_user;
  if v_used + p_encrypted_size > c_quota then
    raise exception 'quota exceeded: workspace would use % of % bytes',
      v_used + p_encrypted_size, c_quota
      using errcode = '53100';   -- disk_full SQLSTATE; closest semantic match
  end if;

  insert into meo.attachments (
    id, note_id, user_id, storage_key, storage_backend,
    encrypted_size, nonce, encrypted_metadata, metadata_nonce
  )
  values (
    p_id, p_note_id, v_user, p_storage_key, p_storage_backend,
    p_encrypted_size, p_nonce, p_encrypted_metadata, p_metadata_nonce
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function meo.attachments_create(uuid, uuid, text, text, bigint, bytea, bytea, bytea) from public;
grant execute on function meo.attachments_create(uuid, uuid, text, text, bigint, bytea, bytea, bytea) to authenticated;

-- Companion read-only function so the client can show "X of 10 GiB used"
-- without RLS-fighting a SUM. RLS on meo.attachments doesn't permit a
-- naive SUM-via-PostgREST (returns 0 with the user's own rows visible only).
create or replace function meo.attachments_quota_used()
returns table (used_bytes bigint, quota_bytes bigint)
language sql
security definer
set search_path = meo, public, auth
as $$
  select coalesce(sum(encrypted_size), 0)::bigint as used_bytes,
         (10::bigint * 1024 * 1024 * 1024) as quota_bytes
    from meo.attachments
   where user_id = auth.uid();
$$;

revoke all on function meo.attachments_quota_used() from public;
grant execute on function meo.attachments_quota_used() to authenticated;
