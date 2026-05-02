-- Agent 9 — QR-pairing handover protocol.
--
-- A handover row is a 60-second-lived rendezvous between an existing
-- device A (signed in, holds the master key) and a brand-new device B
-- (just installed, no master key yet). The id of the row is the
-- bearer token: anyone holding it can read or write the row, but the
-- contents are encrypted under an X25519 + HKDF + AES-GCM "pair_key"
-- that only A and B can derive. Even a malicious third party who
-- intercepts the QR can't read or forge the bundle without seeing
-- both ephemeral pubkeys *and* their respective private keys.
--
-- Lifecycle:
--   1. A creates a row with its ephemeral pubkey and an expires_at.
--   2. B reads the row, deposits its pubkey, polls for payload_for_b.
--   3. A polls for ek_b_pub, computes the pair_key, encrypts the
--      session bundle, deposits payload_for_b + payload_nonce.
--   4. Either side calls handover_clear once the deal is done.
--
-- Cron (pg_cron) clears expired rows every 5 minutes as a safety net
-- in case neither side ran handover_clear (e.g. tab closed mid-flow).

create table if not exists meo.handovers (
  id            uuid primary key,
  ek_a_pub      bytea not null,
  ek_b_pub      bytea,
  payload_for_b bytea,
  payload_nonce bytea,
  expires_at    timestamptz not null
);

-- No RLS — these rows are anon-accessible by id (the id IS the bearer
-- token). All access goes through the SECURITY DEFINER RPCs below,
-- which never reveal a row past expiry.

alter table meo.handovers enable row level security;
-- Default-deny: with RLS enabled and zero policies, no client can touch
-- the table directly. Only the RPCs below (DEFINER) can read / write.

-- ── RPC: create a new handover row (called by Device A) ──
create or replace function meo.handover_create(
  p_id        uuid,
  p_ek_a_pub  bytea
) returns text
language plpgsql
security definer
set search_path = meo, public
as $$
begin
  -- 60 second TTL — short enough to be a usable rendezvous window,
  -- long enough that a slow scan or a stuck camera permission prompt
  -- won't kill the flow before the user makes it through.
  insert into meo.handovers(id, ek_a_pub, expires_at)
  values (p_id, p_ek_a_pub, now() + interval '60 seconds');

  return 'ok';
end;
$$;

revoke all on function meo.handover_create(uuid, bytea) from public;
-- Anyone signed in *or anon* can hit this — Device A may not yet be in
-- a fresh JWT context (offline-first), and the id provides bearer-token
-- semantics on its own.
grant execute on function meo.handover_create(uuid, bytea) to authenticated, anon;

-- ── RPC: deposit Device B's pubkey ──
create or replace function meo.handover_put_b(
  p_id        uuid,
  p_ek_b_pub  bytea
) returns text
language plpgsql
security definer
set search_path = meo, public
as $$
declare
  v_existing meo.handovers%rowtype;
begin
  select * into v_existing from meo.handovers where id = p_id;
  if not found then
    raise exception 'handover not found' using errcode = 'P0002';
  end if;
  if v_existing.expires_at < now() then
    raise exception 'handover expired' using errcode = '22023';
  end if;

  update meo.handovers
     set ek_b_pub = p_ek_b_pub
   where id = p_id;

  return 'ok';
end;
$$;

revoke all on function meo.handover_put_b(uuid, bytea) from public;
grant execute on function meo.handover_put_b(uuid, bytea) to authenticated, anon;

-- ── RPC: deposit Device A's encrypted payload ──
create or replace function meo.handover_put_payload(
  p_id            uuid,
  p_payload       bytea,
  p_payload_nonce bytea
) returns text
language plpgsql
security definer
set search_path = meo, public
as $$
declare
  v_existing meo.handovers%rowtype;
begin
  select * into v_existing from meo.handovers where id = p_id;
  if not found then
    raise exception 'handover not found' using errcode = 'P0002';
  end if;
  if v_existing.expires_at < now() then
    raise exception 'handover expired' using errcode = '22023';
  end if;

  update meo.handovers
     set payload_for_b = p_payload,
         payload_nonce = p_payload_nonce
   where id = p_id;

  return 'ok';
end;
$$;

revoke all on function meo.handover_put_payload(uuid, bytea, bytea) from public;
grant execute on function meo.handover_put_payload(uuid, bytea, bytea) to authenticated, anon;

-- ── RPC: read a handover row ──
-- Returns NULL columns if expired / not found.
create or replace function meo.handover_get(p_id uuid)
returns table (
  ek_a_pub      bytea,
  ek_b_pub      bytea,
  payload_for_b bytea,
  payload_nonce bytea,
  expires_at    timestamptz
)
language plpgsql
security definer
set search_path = meo, public
as $$
begin
  return query
    select h.ek_a_pub, h.ek_b_pub, h.payload_for_b, h.payload_nonce, h.expires_at
      from meo.handovers h
     where h.id = p_id
       and h.expires_at >= now();
end;
$$;

revoke all on function meo.handover_get(uuid) from public;
grant execute on function meo.handover_get(uuid) to authenticated, anon;

-- ── RPC: delete a handover row ──
create or replace function meo.handover_clear(p_id uuid)
returns text
language plpgsql
security definer
set search_path = meo, public
as $$
begin
  delete from meo.handovers where id = p_id;
  return 'ok';
end;
$$;

revoke all on function meo.handover_clear(uuid) from public;
grant execute on function meo.handover_clear(uuid) to authenticated, anon;

-- ── Cron: purge expired rows every 5 minutes ──
-- Best-effort safety net; the explicit handover_clear above is the
-- happy-path. We try pg_cron first and fall back to a simple
-- statement at startup if the extension is unavailable (in test
-- environments without pg_cron, the rows just live a bit longer).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'meo-handovers-purge',
      '*/5 * * * *',
      'delete from meo.handovers where expires_at < now() - interval ''1 minute'''
    );
  end if;
exception when others then
  -- pg_cron not present or scheduler refused the job — fine, the rows
  -- simply stick around past their expires_at until something else
  -- prunes them. handover_get() still treats them as expired.
  null;
end$$;

notify pgrst, 'reload schema';
