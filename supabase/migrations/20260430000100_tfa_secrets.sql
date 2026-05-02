-- Agent 8 — 2FA (Business+) TOTP storage.
--
-- TOTP requires the verifier to hold the shared secret in plaintext at
-- validation time, so we cannot use the per-user master key. Instead the
-- secret is encrypted at rest with a server-side AES-GCM key (`TFA_KEK`,
-- 32 hex bytes, set via Supabase Edge Function secret). The Edge Function
-- decrypts on every verify call; the client never sees other users' rows.
--
-- RLS has no SELECT policy: only service_role (the Edge Function) can read
-- this table. Clients call the tfa-enroll / tfa-verify Edge Functions and
-- receive only what they need (otpauth URL on enroll; ok/fail on verify).

create table if not exists meo.tfa_secrets (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  secret_enc   bytea not null,
  secret_nonce bytea not null,
  enabled      boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table meo.tfa_secrets enable row level security;

-- No SELECT / INSERT / UPDATE / DELETE policy is defined — that means
-- authenticated users can never reach this table directly. Only the
-- Edge Functions, running with the service role, see the rows.

-- ----------------------------------------------------------------------------
-- meo.tfa_status — the *only* read clients are allowed: yes/no flag for the
-- current user. Used by App.tsx on cold start to decide whether to mount
-- the TOTP screen between OTP-verify and the unlock screen.
-- ----------------------------------------------------------------------------
create or replace function meo.tfa_status() returns boolean
language sql
security definer
set search_path = meo, public, auth
as $$
  select coalesce(
    (select enabled from meo.tfa_secrets where user_id = auth.uid()),
    false
  );
$$;

revoke all on function meo.tfa_status() from public;
grant execute on function meo.tfa_status() to authenticated;
