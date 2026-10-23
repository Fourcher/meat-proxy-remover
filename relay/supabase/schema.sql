-- MPR relay storage for the hosted Supabase edge function (relay/supabase/mpr-relay).
-- Lives in its own `mpr` schema, which is NOT exposed through the Data API (PostgREST).
-- RLS is on with no policies, and anon/authenticated have no grants, so the only way in
-- is the edge function's direct Postgres connection, which does its own Ed25519 auth.
create schema if not exists mpr;
revoke all on schema mpr from public, anon, authenticated;

create table if not exists mpr.registry (
  handle  text primary key,
  key     text not null,
  created timestamptz not null default now(),
  last_seen timestamptz,
  last_poll timestamptz            -- last time the owner checked its mail (shown to senders waiting on a reply)
);

create table if not exists mpr.messages (
  id       text primary key,
  handle   text not null references mpr.registry(handle) on delete cascade,
  envelope text not null,
  bytes    int  not null,
  created  timestamptz not null default now()
);
create index if not exists messages_handle_idx on mpr.messages (handle, id);

create table if not exists mpr.nonces (
  sig text primary key,
  ts  timestamptz not null default now()
);
create index if not exists nonces_ts_idx on mpr.nonces (ts);

create table if not exists mpr.rate (
  bucket text not null,
  win    timestamptz not null,
  n      int not null default 0,
  primary key (bucket, win)
);

-- Read receipts: a deposit id is recorded when its recipient acks it. Ids are random, so only the sender knows them.
create table if not exists mpr.receipts (
  id      text primary key,
  read_at timestamptz not null default now()
);

alter table mpr.registry enable row level security;
alter table mpr.receipts enable row level security;
alter table mpr.rate     enable row level security;
alter table mpr.messages enable row level security;
alter table mpr.nonces   enable row level security;
revoke all on all tables in schema mpr from public, anon, authenticated;
alter default privileges in schema mpr revoke all on tables from public, anon, authenticated;
