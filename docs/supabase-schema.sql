-- ══════════════════════════════════════════════════════════
--  TeraSwap — Supabase Schema
--  Run this in Supabase SQL Editor (Dashboard → SQL → New query)
-- ══════════════════════════════════════════════════════════

-- ── Trade events table ───────────────────────────────────
create table if not exists trade_events (
  id            text primary key,
  type          text not null check (type in ('swap', 'dca_buy', 'limit_fill', 'sltp_trigger')),
  wallet        text not null,
  timestamp     bigint not null,
  hour          smallint not null check (hour >= 0 and hour <= 23),
  token_in      text not null,
  token_in_addr text not null default '',
  token_out     text not null,
  token_out_addr text not null default '',
  amount_in     text not null,
  amount_out    text not null,
  volume_usd    numeric(18,2) not null default 0,
  fee_usd       numeric(18,4) not null default 0,
  source        text not null,
  tx_hash       text not null default '',
  chain_id      integer not null default 1,
  created_at    timestamptz not null default now()
);

-- ── Indexes for fast queries ─────────────────────────────
create index if not exists idx_trade_events_timestamp on trade_events (timestamp desc);
create index if not exists idx_trade_events_wallet    on trade_events (wallet);
create index if not exists idx_trade_events_source    on trade_events (source);
create index if not exists idx_trade_events_type      on trade_events (type);

-- ── Row-Level Security ───────────────────────────────────
-- Enable RLS but allow anonymous inserts/reads (public analytics)
alter table trade_events enable row level security;

-- Anyone can read (public dashboard)
create policy "Public read" on trade_events
  for select using (true);

-- Anyone can insert (trades come from client-side)
create policy "Public insert" on trade_events
  for insert with check (true);

-- Only service role can delete (admin only)
-- (no policy = denied by default for anon)

-- ══════════════════════════════════════════════════════════
--  SETUP INSTRUCTIONS
-- ══════════════════════════════════════════════════════════
--
--  1. Go to https://supabase.com → New Project (free tier)
--  2. Copy your Project URL and anon key from Settings → API
--  3. Add to .env.local:
--       NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
--       NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...your-anon-key
--  4. Run this SQL in the SQL Editor
--  5. Deploy — analytics will auto-persist to Supabase
--
-- ══════════════════════════════════════════════════════════
