const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);

// Auto-provision schema if tables don't exist.
// Called on first admin load — safe to call repeatedly (uses IF NOT EXISTS).
async function provision() {
  const statements = [
    `create table if not exists google_tokens (
      user_id text primary key,
      email text,
      name text,
      picture text,
      access_token text,
      refresh_token text,
      expiry_date bigint,
      session_token text,
      created_at timestamptz default now()
    )`,
    `create table if not exists modules (
      name text primary key,
      created_at timestamptz default now()
    )`,
    `create table if not exists objectives (
      id uuid primary key default gen_random_uuid(),
      module text not null,
      brief text not null,
      active boolean default true,
      session_notes text,
      created_at timestamptz default now()
    )`,
    `create table if not exists sources (
      id uuid primary key default gen_random_uuid(),
      module text not null,
      objective_id uuid references objectives(id),
      url text not null,
      source_name text,
      authority_weight numeric default 1.0,
      crawl_frequency text default 'weekly',
      approved boolean default false,
      proposed_by_gemini boolean default true,
      created_at timestamptz default now()
    )`,
    `create table if not exists findings (
      id uuid primary key default gen_random_uuid(),
      module text not null,
      source_id uuid references sources(id),
      url text,
      topic_tags text[],
      confidence numeric,
      technical text,
      plain text,
      practical text,
      crawled_at timestamptz default now(),
      status text default 'pending' check (status in ('pending','approved','discarded'))
    )`,
    `create table if not exists knowledge (
      id uuid primary key default gen_random_uuid(),
      module text not null,
      finding_id uuid references findings(id),
      topic_tags text[],
      confidence numeric,
      technical text,
      plain text,
      practical text,
      approved_at timestamptz default now()
    )`
  ];

  const errors = [];
  for (const sql of statements) {
    const { error } = await supabase.rpc('exec_sql', { sql }).catch(() => ({ error: { message: 'rpc unavailable' } }));
    // Supabase free tier doesn't expose exec_sql — fall back silently.
    // Tables are created manually via SQL Editor on first deploy.
    if (error) errors.push(error.message);
  }
  return errors.length === 0;
}

module.exports = { supabase, provision };
