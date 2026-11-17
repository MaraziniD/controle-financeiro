-- Banco de dados do controle financeiro do casal.
-- Nenhum dado real fica neste arquivo: e-mails, telefones e valores
-- são cadastrados direto no Supabase (veja supabase/LEIA-ME.md).

-- Uma "casa" agrupa o casal. Os ajustes (renda, cartões, limites,
-- contas fixas) ficam em JSON, no mesmo formato que o app já usa.
create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Casa',
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Quem faz parte da casa. O user_id é preenchido sozinho no primeiro login
-- pelo e-mail; o telefone é o WhatsApp de cada um (só números, ex: 5547999999999).
create table public.members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  email text unique,
  phone text unique,
  user_id uuid unique references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.expenses (
  id text primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  text text not null,
  amount numeric(12,2) not null check (amount > 0),
  category text not null default 'Outros',
  card text,
  person text,
  date timestamptz not null default now(),
  source text not null default 'app',  -- 'app' ou 'whatsapp'
  created_at timestamptz not null default now()
);
create index expenses_household_date on public.expenses (household_id, date desc);

create table public.bills_paid (
  household_id uuid not null references public.households(id) on delete cascade,
  month text not null,        -- '2026-11'
  bill_id text not null,
  primary key (household_id, month, bill_id)
);

-- Guarda o maior aviso já mandado (70, 90 ou 100) por cartão/categoria e período,
-- para o app e o WhatsApp não repetirem o mesmo alerta.
create table public.alerts_sent (
  household_id uuid not null references public.households(id) on delete cascade,
  key text not null,          -- ex: 'card:c6:2026-12' ou 'cat:Mercado:2026-11'
  level int not null,
  primary key (household_id, key)
);

-- ---------- Segurança: cada pessoa só enxerga a própria casa ----------
create or replace function public.my_household()
returns uuid language sql stable security definer set search_path = public as $$
  select household_id from public.members where user_id = auth.uid() limit 1
$$;

alter table public.households  enable row level security;
alter table public.members     enable row level security;
alter table public.expenses    enable row level security;
alter table public.bills_paid  enable row level security;
alter table public.alerts_sent enable row level security;

create policy "casa: ler"      on public.households for select using (id = public.my_household());
create policy "casa: alterar"  on public.households for update using (id = public.my_household()) with check (id = public.my_household());
create policy "membros: ler"   on public.members    for select using (household_id = public.my_household());

create policy "gastos: tudo" on public.expenses
  for all using (household_id = public.my_household()) with check (household_id = public.my_household());
create policy "contas pagas: tudo" on public.bills_paid
  for all using (household_id = public.my_household()) with check (household_id = public.my_household());
create policy "avisos: tudo" on public.alerts_sent
  for all using (household_id = public.my_household()) with check (household_id = public.my_household());

-- No primeiro login, liga a conta à pessoa cadastrada com o mesmo e-mail.
create or replace function public.link_member_on_signup()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.members set user_id = new.id
   where lower(email) = lower(new.email) and user_id is null;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.link_member_on_signup();

-- Para o app atualizar na hora quando o outro lança um gasto.
alter publication supabase_realtime add table public.expenses, public.bills_paid, public.households;
