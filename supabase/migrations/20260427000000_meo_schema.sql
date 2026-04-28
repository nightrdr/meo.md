-- meo.md schema (per spec §2.2). Notes content is end-to-end encrypted before
-- it ever reaches this database — these tables hold ciphertext + metadata only.

create schema if not exists meo;

-- ----------------------------------------------------------------------------
-- accounts: per-user encryption wrapper (master key ciphertext + KDF params)
-- ----------------------------------------------------------------------------
create table if not exists meo.accounts (
  user_id              uuid primary key references auth.users(id) on delete cascade,
  salt                 bytea not null,
  encrypted_master_key bytea not null,
  master_key_nonce     bytea not null,
  kdf_params           jsonb not null,
  created_at           timestamptz not null default now()
);

alter table meo.accounts enable row level security;

drop policy if exists "accounts: read own" on meo.accounts;
create policy "accounts: read own"
  on meo.accounts for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "accounts: insert own once" on meo.accounts;
create policy "accounts: insert own once"
  on meo.accounts for insert
  to authenticated
  with check (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- notes: encrypted blobs, monotonic version, HLC timestamp
-- ----------------------------------------------------------------------------
create table if not exists meo.notes (
  id                uuid primary key,
  user_id           uuid not null references auth.users(id) on delete cascade,
  encrypted_content bytea not null,
  nonce             bytea not null,
  version           bigint not null,
  hlc_timestamp     text not null,
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  size_bytes        integer not null default 0
);

create index if not exists idx_notes_user_version on meo.notes(user_id, version);

alter table meo.notes enable row level security;

drop policy if exists "notes: read own" on meo.notes;
create policy "notes: read own"
  on meo.notes for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "notes: insert own" on meo.notes;
create policy "notes: insert own"
  on meo.notes for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "notes: update own" on meo.notes;
create policy "notes: update own"
  on meo.notes for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- per-user monotonic version counter (advances on every write, including delete)
-- ----------------------------------------------------------------------------
create table if not exists meo.sync_cursor (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  next_version bigint not null default 1
);

alter table meo.sync_cursor enable row level security;
-- no client-side policies: this is server-only via a SECURITY DEFINER function

-- ----------------------------------------------------------------------------
-- RPC: upsert a note in one transaction. Enforces last-write-wins by HLC.
-- Returns the saved row (including the server-assigned version).
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- RPC: tombstone a note (also bumps version)
-- ----------------------------------------------------------------------------
create or replace function meo.delete_note(p_id uuid) returns meo.notes
language plpgsql
security definer
set search_path = meo, public
as $$
declare
  v_user uuid := auth.uid();
  v_version bigint;
  v_row meo.notes%rowtype;
  v_existing meo.notes%rowtype;
begin
  if v_user is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  select * into v_existing from meo.notes where id = p_id;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_existing.user_id <> v_user then raise exception 'forbidden' using errcode = '42501'; end if;

  insert into meo.sync_cursor (user_id, next_version)
    values (v_user, 2)
  on conflict (user_id) do update
    set next_version = meo.sync_cursor.next_version + 1
  returning meo.sync_cursor.next_version - 1 into v_version;

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

-- ----------------------------------------------------------------------------
-- expose the meo schema to PostgREST
-- ----------------------------------------------------------------------------
grant usage on schema meo to authenticated, anon;
grant select on meo.notes to authenticated;
grant select, insert on meo.accounts to authenticated;
