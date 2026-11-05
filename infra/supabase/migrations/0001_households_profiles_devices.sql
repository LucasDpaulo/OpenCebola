-- Cebola: schema inicial. Execute por meio das migrations do Supabase.
-- Clientes não recebem acesso direto a estas tabelas: RLS permanece habilitado
-- e somente a API, com credencial de servidor, poderá acessá-las.

create extension if not exists pgcrypto;

create type public.cebola_device_type as enum ('web', 'mobile', 'tv', 'desktop');
create type public.cebola_device_status as enum ('active', 'revoked');

create table public.households (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references auth.users(id) on delete restrict,
  name text not null check (char_length(trim(name)) between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 80),
  avatar_url text check (avatar_url is null or char_length(avatar_url) <= 2048),
  pin_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, name)
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 1 and 100),
  type public.cebola_device_type not null,
  status public.cebola_device_status not null default 'active',
  device_secret_hash text not null unique,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index profiles_household_id_idx on public.profiles (household_id);
create index devices_active_household_id_idx on public.devices (household_id) where status = 'active';

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger households_set_updated_at
before update on public.households
for each row execute function public.set_updated_at();

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create function public.enforce_profile_limit()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and old.household_id = new.household_id then
    return new;
  end if;

  -- O lock no household evita que duas criações simultâneas ultrapassem o limite.
  perform 1 from public.households where id = new.household_id for update;

  if (select count(*) from public.profiles where household_id = new.household_id) >= 8 then
    raise exception 'profile_limit_reached' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger profiles_enforce_limit
before insert or update of household_id on public.profiles
for each row execute function public.enforce_profile_limit();

create function public.enforce_active_device_limit()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  becomes_active boolean;
begin
  if tg_op = 'INSERT' then
    becomes_active := new.status = 'active';
  else
    becomes_active := new.status = 'active' and (
      old.status is distinct from 'active' or old.household_id is distinct from new.household_id
    );
  end if;

  if becomes_active then
    perform 1 from public.households where id = new.household_id for update;

    if (select count(*) from public.devices where household_id = new.household_id and status = 'active') >= 20 then
      raise exception 'device_limit_reached' using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger devices_enforce_limit
before insert or update of household_id, status on public.devices
for each row execute function public.enforce_active_device_limit();

alter table public.households enable row level security;
alter table public.profiles enable row level security;
alter table public.devices enable row level security;

-- Sem policies deliberadamente: o browser não pode consultar ou alterar o banco.
comment on table public.households is 'Acesso exclusivo da API Cebola; RLS sem policies bloqueia clientes diretos.';
comment on table public.profiles is 'Máximo de oito perfis por household, imposto também no banco.';
comment on table public.devices is 'Máximo de vinte dispositivos ativos por household, imposto também no banco.';
