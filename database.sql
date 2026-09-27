-- ERD tepat 3 entitas untuk Supabase PostgreSQL
create extension if not exists "uuid-ossp";
create table suppliers (id uuid primary key default uuid_generate_v4(),name text not null unique,contact text,created_at timestamptz default now());
create table debts (id uuid primary key default uuid_generate_v4(),supplier_id uuid not null references suppliers(id),transaction_date date not null,amount numeric(15,2) not null check(amount>=0),paid_amount numeric(15,2) default 0 check(paid_amount>=0 and paid_amount<=amount),due_date date not null,payment_date date,payment_method text,note text,created_at timestamptz default now());
create table reimbursements (id uuid primary key default uuid_generate_v4(),employee_name text not null,expense_date date not null,category text not null,amount numeric(15,2) not null check(amount>=0),paid_amount numeric(15,2) default 0 check(paid_amount>=0 and paid_amount<=amount),status text default 'Diajukan' check(status in ('Diajukan','Disetujui','Dibayar')),payment_date date,payment_method text,note text,created_at timestamptz default now());
create index debts_due_idx on debts(due_date);create index debts_supplier_idx on debts(supplier_id);create index reimbursements_status_idx on reimbursements(status);
alter table suppliers enable row level security;alter table debts enable row level security;alter table reimbursements enable row level security;
-- Policy development agar publishable key dapat dipakai dari backend.
drop policy if exists suppliers_public_access on suppliers;
create policy suppliers_public_access on suppliers for all to anon, authenticated using (true) with check (true);
drop policy if exists debts_public_access on debts;
create policy debts_public_access on debts for all to anon, authenticated using (true) with check (true);
drop policy if exists reimbursements_public_access on reimbursements;
create policy reimbursements_public_access on reimbursements for all to anon, authenticated using (true) with check (true);
create or replace view finance_summary as select 'utang' type,coalesce(sum(amount),0) total,coalesce(sum(paid_amount),0) paid from debts union all select 'reimbursement',coalesce(sum(amount),0),coalesce(sum(paid_amount),0) from reimbursements;