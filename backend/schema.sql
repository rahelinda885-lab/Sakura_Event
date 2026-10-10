-- Sakura Event: jalankan di Supabase SQL Editor.
-- ERD (4 entitas): parties 1—N obligations, expense_categories 1—N obligations,
-- obligations 1—N payments. obligations membedakan utang dan reimbursement.

create extension if not exists pgcrypto;

create table if not exists public.parties (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  party_type text not null check (party_type in ('supplier', 'employee')),
  created_at timestamptz not null default now(),
  unique (name, party_type)
);

create table if not exists public.expense_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.obligations (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.parties(id) on delete restrict,
  category_id uuid references public.expense_categories(id) on delete set null,
  obligation_type text not null check (obligation_type in ('debt', 'reimbursement')),
  transaction_date date not null,
  due_date date,
  amount numeric(14,2) not null check (amount > 0),
  description text not null default '',
  status text not null default 'submitted' check (status in ('submitted', 'approved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (obligation_type = 'debt' and due_date is not null and status = 'approved')
    or (obligation_type = 'reimbursement' and category_id is not null and due_date is null)
  )
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  obligation_id uuid not null references public.obligations(id) on delete cascade,
  payment_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  method text not null check (method in ('Transfer bank', 'Tunai', 'E-wallet', 'Lainnya')),
  notes text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists obligations_type_date_idx
  on public.obligations (obligation_type, transaction_date desc);
create index if not exists obligations_party_idx on public.obligations (party_id);
create index if not exists payments_obligation_idx on public.payments (obligation_id);
create index if not exists payments_date_idx on public.payments (payment_date desc);

insert into public.expense_categories (name) values
  ('Transportasi'), ('Konsumsi'), ('Perlengkapan'), ('Akomodasi'), ('Komunikasi'), ('Lainnya')
on conflict (name) do nothing;

-- Akses langsung tanpa login: seluruh data di bawah ini dapat dibaca/diubah
-- oleh siapa pun yang mengetahui URL project. Gunakan hanya jika memang diinginkan.
alter table public.parties enable row level security;
alter table public.expense_categories enable row level security;
alter table public.obligations enable row level security;
alter table public.payments enable row level security;

grant usage on schema public to anon;
grant select, insert, update, delete on public.parties to anon;
grant select on public.expense_categories to anon;
grant select, insert, update, delete on public.obligations to anon;
grant select, insert, update, delete on public.payments to anon;

drop policy if exists "Authenticated users manage parties" on public.parties;
drop policy if exists "Public users manage parties" on public.parties;
create policy "Public users manage parties"
  on public.parties for all to anon
  using (true) with check (true);

drop policy if exists "Authenticated users read expense categories" on public.expense_categories;
drop policy if exists "Public users read expense categories" on public.expense_categories;
create policy "Public users read expense categories"
  on public.expense_categories for select to anon
  using (true);

drop policy if exists "Authenticated users manage obligations" on public.obligations;
drop policy if exists "Public users manage obligations" on public.obligations;
create policy "Public users manage obligations"
  on public.obligations for all to anon
  using (true) with check (true);

drop policy if exists "Authenticated users manage payments" on public.payments;
drop policy if exists "Public users manage payments" on public.payments;
create policy "Public users manage payments"
  on public.payments for all to anon
  using (true) with check (true);
