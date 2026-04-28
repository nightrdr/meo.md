-- meo.attachments — per spec §2.2 / §3.8.
--
-- The server only ever sees:
--   * an opaque storage_key (random UUID, no semantic info)
--   * the ciphertext size (encrypted_size, post-AES-GCM-with-tags)
--   * an aggregate nonce_base (8 bytes) reused across chunks (with chunk index)
--   * encrypted_metadata (filename / mime / dims / sha256 / original size)
--
-- Filename, mime type, dimensions, etc. are NEVER stored in plaintext.
-- The actual ciphertext bytes are stored elsewhere (Supabase Storage / iDrive
-- S3) keyed by storage_key.

create table if not exists meo.attachments (
  id                  uuid primary key,
  note_id             uuid not null references meo.notes(id) on delete cascade,
  user_id             uuid not null references auth.users(id) on delete cascade,
  storage_key         text not null,
  storage_backend     text not null default 'supabase',
  encrypted_size      bigint not null,
  nonce               bytea not null,            -- 8-byte nonce_base; per-chunk nonce = base || chunk_index
  encrypted_metadata  bytea not null,            -- AES-GCM ciphertext of {filename, mime, dims?, original_size, sha256}
  metadata_nonce      bytea not null,            -- 12-byte GCM nonce for the metadata blob
  created_at          timestamptz not null default now()
);

create index if not exists idx_attachments_note_user
  on meo.attachments(note_id, user_id);

create index if not exists idx_attachments_user_created
  on meo.attachments(user_id, created_at desc);

alter table meo.attachments enable row level security;

drop policy if exists "attachments: read own" on meo.attachments;
create policy "attachments: read own"
  on meo.attachments for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "attachments: insert own" on meo.attachments;
create policy "attachments: insert own"
  on meo.attachments for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "attachments: delete own" on meo.attachments;
create policy "attachments: delete own"
  on meo.attachments for delete
  to authenticated
  using (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- RPC: validate note ownership and insert an attachment row in one shot.
-- The actual blob upload happens out-of-band via signed PUT URL (Edge Function);
-- this row is the database "claim" that the bytes exist + how to decrypt them.
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
  v_user uuid;
  v_note_owner uuid;
  v_row meo.attachments%rowtype;
begin
  v_user := auth.uid();
  if v_user is null then
    raise exception 'unauthorized: auth.uid() is null' using errcode = '28000';
  end if;

  -- The note must exist AND belong to the caller. RLS doesn't help here
  -- because we're bypassing it (security definer); enforce manually.
  select user_id into v_note_owner from meo.notes where id = p_note_id;
  if not found then
    raise exception 'note not found' using errcode = 'P0002';
  end if;
  if v_note_owner <> v_user then
    raise exception 'forbidden: note belongs to another user' using errcode = '42501';
  end if;

  -- Sanity: 100 MB / attachment cap (spec §3.8). Keep slightly above the
  -- ciphertext budget (16-byte tag per chunk amortizes to <0.01% overhead).
  if p_encrypted_size > 110 * 1024 * 1024 then
    raise exception 'attachment too large: % bytes (max 110 MiB ciphertext)', p_encrypted_size
      using errcode = '22000';
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
-- RPC: list all attachments for a note (RLS-respecting via explicit check).
-- ----------------------------------------------------------------------------
create or replace function meo.attachments_for_note(p_note_id uuid)
returns setof meo.attachments
language plpgsql
security definer
set search_path = meo, public, auth
as $$
declare
  v_user uuid;
begin
  v_user := auth.uid();
  if v_user is null then
    raise exception 'unauthorized: auth.uid() is null' using errcode = '28000';
  end if;

  return query
    select *
      from meo.attachments
     where note_id = p_note_id
       and user_id = v_user
     order by created_at asc;
end;
$$;

revoke all on function meo.attachments_for_note(uuid) from public;
grant execute on function meo.attachments_for_note(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Direct table grants — for the fallback cases where the client bypasses the
-- RPC (e.g. selecting a single attachment row by id during download).
-- RLS still enforces user_id = auth.uid().
-- ----------------------------------------------------------------------------
grant select, insert, delete on meo.attachments to authenticated;
