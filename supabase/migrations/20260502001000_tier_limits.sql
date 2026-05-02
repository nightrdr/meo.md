-- Agent 6 — tier-aware storage + per-attachment limits.
--
-- The pricing matrix lives in mvp-development.md:
--   Free       → 1 GB total · 10 MB per attachment
--   Hobbyist   → 10 GB · 1 GB
--   Business   → 1 TB · 1 GB
--   Enterprise → custom (fall back to Business defaults until provisioned)
--
-- The client mirrors these in packages/shared/src/attachments.ts (`tierLimits`)
-- so users see immediate feedback when they pick a too-large file. The
-- server is authoritative — we re-check inside SECURITY DEFINER RPCs and
-- raise SQLSTATE codes the desktop client humanizes:
--   P0007 → attachment_too_large    (single file > tier max)
--   P0008 → storage_cap_exceeded    (total bytes > tier total)

-- ----------------------------------------------------------------------------
-- meo.tier_limits — single source of truth, callable by other RPCs.
-- ----------------------------------------------------------------------------

create or replace function meo.tier_limits(p_user_id uuid)
returns table (
  max_attachment_bytes bigint,
  total_storage_bytes  bigint
)
language plpgsql
security definer
set search_path = meo, public
as $$
declare
  v_tier text;
begin
  select coalesce(tier, 'free') into v_tier
    from meo.subscriptions
   where user_id = p_user_id;
  v_tier := coalesce(v_tier, 'free');

  if v_tier = 'free' then
    max_attachment_bytes := 10 * 1024::bigint * 1024;            -- 10 MiB
    total_storage_bytes  := 1 * 1024::bigint * 1024 * 1024;       -- 1 GiB
  elsif v_tier = 'hobbyist' then
    max_attachment_bytes := 1 * 1024::bigint * 1024 * 1024;       -- 1 GiB
    total_storage_bytes  := 10 * 1024::bigint * 1024 * 1024;      -- 10 GiB
  elsif v_tier = 'business' then
    max_attachment_bytes := 1 * 1024::bigint * 1024 * 1024;       -- 1 GiB
    total_storage_bytes  := 1024::bigint * 1024 * 1024 * 1024;    -- 1 TiB
  else
    -- enterprise: same defaults as business until provisioned individually.
    max_attachment_bytes := 1 * 1024::bigint * 1024 * 1024;
    total_storage_bytes  := 1024::bigint * 1024 * 1024 * 1024;
  end if;
  return next;
end;
$$;

revoke all on function meo.tier_limits(uuid) from public;
grant execute on function meo.tier_limits(uuid) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- meo.attachments_create v3 — tier-aware quota + per-attachment cap.
-- Drops the hardcoded constants from the previous migration (10 GiB workspace,
-- 110 MiB ciphertext) in favour of looking up the user's tier.
-- ----------------------------------------------------------------------------

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
  v_user            uuid;
  v_note_owner      uuid;
  v_used_attach     bigint;
  v_used_notes      bigint;
  v_row             meo.attachments%rowtype;
  v_max_attach      bigint;
  v_max_total       bigint;
  -- Allow ~1% slack for AES-GCM tags (12-byte nonce + 16-byte tag per
  -- chunk @ 1 MiB chunk size). Practically: if tier max is N, accept
  -- ciphertext up to N + 0.01*N + 16 bytes. Keeps the failure mode
  -- "the file would be larger than your tier even after fudge factor".
  c_overhead_bps    constant int := 100;  -- 1.00% in basis-points-of-1000
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

  -- Look up the caller's tier limits.
  select max_attachment_bytes, total_storage_bytes
    into v_max_attach, v_max_total
    from meo.tier_limits(v_user);

  -- Per-attachment cap (plaintext budget + ~1% GCM overhead).
  if p_encrypted_size > v_max_attach + (v_max_attach / 100) + 16 then
    raise exception 'attachment_too_large: % bytes (tier max % bytes)',
      p_encrypted_size, v_max_attach
      using errcode = 'P0007';
  end if;

  -- Workspace-wide quota: attachments + notes ciphertext counts together.
  select coalesce(sum(encrypted_size), 0) into v_used_attach
    from meo.attachments
   where user_id = v_user;
  select coalesce(sum(size_bytes), 0) into v_used_notes
    from meo.notes
   where user_id = v_user
     and deleted_at is null;
  if v_used_attach + v_used_notes + p_encrypted_size > v_max_total then
    raise exception 'storage_cap_exceeded: workspace would use % of % bytes',
      v_used_attach + v_used_notes + p_encrypted_size, v_max_total
      using errcode = 'P0008';
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

-- ----------------------------------------------------------------------------
-- meo.note_size_check — called from upsert_note to gate note ciphertext
-- against the tier's total storage cap. Notes count toward storage along
-- with attachments. Raises P0008 on over-cap.
-- ----------------------------------------------------------------------------

create or replace function meo.note_size_check(p_user_id uuid, p_size integer)
returns void
language plpgsql
security definer
set search_path = meo, public
as $$
declare
  v_used_attach bigint;
  v_used_notes  bigint;
  v_max_total   bigint;
begin
  if p_size is null or p_size <= 0 then
    return;
  end if;
  select total_storage_bytes into v_max_total
    from meo.tier_limits(p_user_id);

  select coalesce(sum(encrypted_size), 0) into v_used_attach
    from meo.attachments
   where user_id = p_user_id;
  select coalesce(sum(size_bytes), 0) into v_used_notes
    from meo.notes
   where user_id = p_user_id
     and deleted_at is null;

  if v_used_attach + v_used_notes + p_size > v_max_total then
    raise exception 'storage_cap_exceeded: workspace would use % of % bytes',
      v_used_attach + v_used_notes + p_size, v_max_total
      using errcode = 'P0008';
  end if;
end;
$$;

revoke all on function meo.note_size_check(uuid, integer) from public;
grant execute on function meo.note_size_check(uuid, integer) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- meo.upsert_note v3 — calls meo.note_size_check on every write so users
-- can't smuggle past the cap by uploading a giant ciphertext as a note.
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

  -- Tier-aware total storage cap. Skip when shrinking an existing note
  -- (the new ciphertext is smaller than what's already counted).
  if not found or p_size_bytes > coalesce(v_existing.size_bytes, 0) then
    perform meo.note_size_check(
      v_user,
      p_size_bytes - coalesce(v_existing.size_bytes, 0)
    );
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

-- ----------------------------------------------------------------------------
-- meo.storage_usage — read-only "X of Y bytes used" RPC for the Settings UI.
-- Returns a single row with attachment_bytes, note_bytes, total_bytes, cap_bytes.
-- ----------------------------------------------------------------------------

create or replace function meo.storage_usage()
returns table (
  attachment_bytes bigint,
  note_bytes       bigint,
  total_bytes      bigint,
  cap_bytes        bigint,
  max_attachment_bytes bigint
)
language plpgsql
security definer
set search_path = meo, public, auth
as $$
declare
  v_user uuid;
  v_attach bigint;
  v_notes  bigint;
  v_max_attach bigint;
  v_max_total  bigint;
begin
  v_user := auth.uid();
  if v_user is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  select coalesce(sum(encrypted_size), 0) into v_attach
    from meo.attachments
   where user_id = v_user;
  select coalesce(sum(size_bytes), 0) into v_notes
    from meo.notes
   where user_id = v_user
     and deleted_at is null;

  select max_attachment_bytes, total_storage_bytes
    into v_max_attach, v_max_total
    from meo.tier_limits(v_user);

  attachment_bytes := v_attach;
  note_bytes       := v_notes;
  total_bytes      := v_attach + v_notes;
  cap_bytes        := v_max_total;
  max_attachment_bytes := v_max_attach;
  return next;
end;
$$;

revoke all on function meo.storage_usage() from public;
grant execute on function meo.storage_usage() to authenticated;

-- ----------------------------------------------------------------------------
-- meo.attachments_quota_used — keep the existing surface (clients still call
-- it after Agent 10 shipped). Now consults tier_limits() so it reports the
-- right cap for non-Free tiers.
-- ----------------------------------------------------------------------------

create or replace function meo.attachments_quota_used()
returns table (used_bytes bigint, quota_bytes bigint)
language plpgsql
security definer
set search_path = meo, public, auth
as $$
declare
  v_user uuid;
  v_used bigint;
  v_cap  bigint;
begin
  v_user := auth.uid();
  if v_user is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  select coalesce(sum(encrypted_size), 0) into v_used
    from meo.attachments
   where user_id = v_user;

  select total_storage_bytes into v_cap
    from meo.tier_limits(v_user);

  used_bytes  := v_used;
  quota_bytes := v_cap;
  return next;
end;
$$;

revoke all on function meo.attachments_quota_used() from public;
grant execute on function meo.attachments_quota_used() to authenticated;
