-- A biblioteca pertence ao perfil, não ao dispositivo. Clientes não acessam esta
-- tabela diretamente: a API usa as RPCs abaixo com service_role.

create table public.profile_library (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  profile_id uuid not null,
  addon_id text not null check (char_length(trim(addon_id)) between 1 and 200),
  media_id text not null check (char_length(trim(media_id)) between 1 and 255),
  media_type public.cebola_media_type not null,
  name text not null check (char_length(trim(name)) between 1 and 300),
  poster_url text check (
    poster_url is null
    or (char_length(poster_url) <= 2048 and starts_with(lower(poster_url), 'https://'))
  ),
  background_url text check (
    background_url is null
    or (char_length(background_url) <= 2048 and starts_with(lower(background_url), 'https://'))
  ),
  description text check (description is null or char_length(description) <= 5000),
  release_info text check (release_info is null or char_length(release_info) <= 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profile_library_profile_household_fk
    foreign key (profile_id, household_id)
    references public.profiles(id, household_id)
    on delete cascade,
  constraint profile_library_profile_media_unique
    unique (profile_id, media_type, media_id)
);

create index profile_library_profile_updated_idx
  on public.profile_library (profile_id, updated_at desc);

alter table public.profile_library enable row level security;

comment on table public.profile_library is
  'Biblioteca sincronizada e isolada por perfil; acesso exclusivo da API Cebola.';

create or replace function public.cebola_list_library(
  p_household_id uuid,
  p_profile_id uuid
)
returns setof public.profile_library
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
    from public.profiles
    where id = p_profile_id and household_id = p_household_id
  ) then
    raise exception 'profile_not_found' using errcode = 'P0002';
  end if;

  return query
  select item.*
  from public.profile_library as item
  where item.household_id = p_household_id
    and item.profile_id = p_profile_id
  order by item.updated_at desc, item.media_type, item.media_id;
end;
$$;

create or replace function public.cebola_upsert_library_item(
  p_id uuid,
  p_household_id uuid,
  p_profile_id uuid,
  p_addon_id text,
  p_media_id text,
  p_media_type public.cebola_media_type,
  p_name text,
  p_poster_url text,
  p_background_url text,
  p_description text,
  p_release_info text,
  p_created_at timestamptz,
  p_updated_at timestamptz
)
returns public.profile_library
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result public.profile_library;
begin
  if not exists (
    select 1
    from public.profiles
    where id = p_profile_id and household_id = p_household_id
  ) then
    raise exception 'profile_not_found' using errcode = 'P0002';
  end if;

  insert into public.profile_library (
    id,
    household_id,
    profile_id,
    addon_id,
    media_id,
    media_type,
    name,
    poster_url,
    background_url,
    description,
    release_info,
    created_at,
    updated_at
  ) values (
    p_id,
    p_household_id,
    p_profile_id,
    trim(p_addon_id),
    trim(p_media_id),
    p_media_type,
    trim(p_name),
    p_poster_url,
    p_background_url,
    p_description,
    p_release_info,
    p_created_at,
    p_updated_at
  )
  on conflict (profile_id, media_type, media_id)
  do update set
    addon_id = excluded.addon_id,
    name = excluded.name,
    poster_url = excluded.poster_url,
    background_url = excluded.background_url,
    description = excluded.description,
    release_info = excluded.release_info,
    updated_at = excluded.updated_at
  returning * into result;

  return result;
end;
$$;

create or replace function public.cebola_remove_library_item(
  p_household_id uuid,
  p_profile_id uuid,
  p_media_type public.cebola_media_type,
  p_media_id text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  removed_count integer;
begin
  if not exists (
    select 1
    from public.profiles
    where id = p_profile_id and household_id = p_household_id
  ) then
    raise exception 'profile_not_found' using errcode = 'P0002';
  end if;

  delete from public.profile_library
  where household_id = p_household_id
    and profile_id = p_profile_id
    and media_type = p_media_type
    and media_id = trim(p_media_id);
  get diagnostics removed_count = row_count;
  return removed_count > 0;
end;
$$;

revoke all on table public.profile_library from public, anon, authenticated;
revoke all on function public.cebola_list_library(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.cebola_upsert_library_item(
  uuid, uuid, uuid, text, text, public.cebola_media_type, text, text, text,
  text, text, timestamptz, timestamptz
) from public, anon, authenticated;
revoke all on function public.cebola_remove_library_item(
  uuid, uuid, public.cebola_media_type, text
) from public, anon, authenticated;

grant execute on function public.cebola_list_library(uuid, uuid)
  to service_role;
grant execute on function public.cebola_upsert_library_item(
  uuid, uuid, uuid, text, text, public.cebola_media_type, text, text, text,
  text, text, timestamptz, timestamptz
) to service_role;
grant execute on function public.cebola_remove_library_item(
  uuid, uuid, public.cebola_media_type, text
) to service_role;
