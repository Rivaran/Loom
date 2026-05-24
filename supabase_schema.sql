-- Thread
create table threads (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  tags text[] default '{}',
  archived boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Message
create table messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references threads(id) on delete cascade,
  agent_name text not null,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  created_at timestamptz default now()
);

-- Context Card
create table context_cards (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null unique references threads(id) on delete cascade,
  summary text,
  decisions text,
  open_questions text,
  next_actions text,
  agent_views jsonb default '{}',
  updated_at timestamptz default now()
);

-- Memory Pin
create table memory_pins (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid references threads(id) on delete set null,
  content text not null,
  tags text[] default '{}',
  created_at timestamptz default now()
);

-- API Tokens（MCP認証用）
create table loom_api_tokens (
  id uuid primary key default gen_random_uuid(),
  label text,
  created_at timestamptz default now()
);

alter table threads enable row level security;
alter table messages enable row level security;
alter table context_cards enable row level security;
alter table memory_pins enable row level security;
alter table loom_api_tokens enable row level security;

-- RLS Policies（全員読み書き可、Loomは共有メモリなのでユーザー制限なし）
create policy "threads_all" on threads for all to anon, authenticated using (true) with check (true);
create policy "messages_all" on messages for all to anon, authenticated using (true) with check (true);
create policy "context_cards_all" on context_cards for all to anon, authenticated using (true) with check (true);
create policy "memory_pins_all" on memory_pins for all to anon, authenticated using (true) with check (true);
create policy "loom_api_tokens_select" on loom_api_tokens for select to anon, authenticated using (true);
