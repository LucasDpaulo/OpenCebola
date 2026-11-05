-- A senha Stremio nunca é persistida. O authKey e a coleção de add-ons são
-- cifrados pela API com AES-256-GCM antes de chegarem ao PostgreSQL.

create table public.stremio_connections (
  household_id uuid primary key references public.households(id) on delete cascade,
  auth_ciphertext text not null check (char_length(auth_ciphertext) between 8 and 16384),
  auth_iv text not null check (char_length(auth_iv) between 16 and 64),
  auth_tag text not null check (char_length(auth_tag) between 16 and 64),
  addons_ciphertext text not null check (char_length(addons_ciphertext) between 8 and 2097152),
  addons_iv text not null check (char_length(addons_iv) between 16 and 64),
  addons_tag text not null check (char_length(addons_tag) between 16 and 64),
  addon_count integer not null check (addon_count between 0 and 100),
  synced_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.stremio_connections enable row level security;

comment on table public.stremio_connections is
  'Credencial e coleção Stremio cifradas; acesso exclusivo da API Cebola.';

create or replace function public.cebola_upsert_stremio_connection(
  p_household_id uuid,
  p_auth_ciphertext text,
  p_auth_iv text,
  p_auth_tag text,
  p_addons_ciphertext text,
  p_addons_iv text,
  p_addons_tag text,
  p_addon_count integer,
  p_synced_at timestamptz
)
returns public.stremio_connections
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result public.stremio_connections;
begin
  if not exists (select 1 from public.households where id = p_household_id) then
    raise exception 'household_not_found' using errcode = 'P0002';
  end if;

  insert into public.stremio_connections (
    household_id,
    auth_ciphertext,
    auth_iv,
    auth_tag,
    addons_ciphertext,
    addons_iv,
    addons_tag,
    addon_count,
    synced_at
  ) values (
    p_household_id,
    p_auth_ciphertext,
    p_auth_iv,
    p_auth_tag,
    p_addons_ciphertext,
    p_addons_iv,
    p_addons_tag,
    p_addon_count,
    p_synced_at
  )
  on conflict (household_id) do update set
    auth_ciphertext = excluded.auth_ciphertext,
    auth_iv = excluded.auth_iv,
    auth_tag = excluded.auth_tag,
    addons_ciphertext = excluded.addons_ciphertext,
    addons_iv = excluded.addons_iv,
    addons_tag = excluded.addons_tag,
    addon_count = excluded.addon_count,
    synced_at = excluded.synced_at,
    updated_at = now()
  returning * into result;

  return result;
end;
$$;

create or replace function public.cebola_delete_stremio_connection(
  p_household_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  removed_count integer;
begin
  delete from public.stremio_connections where household_id = p_household_id;
  get diagnostics removed_count = row_count;
  return removed_count > 0;
end;
$$;

revoke all on table public.stremio_connections from public, anon, authenticated;
revoke all on function public.cebola_upsert_stremio_connection(
  uuid, text, text, text, text, text, text, integer, timestamptz
) from public, anon, authenticated;
revoke all on function public.cebola_delete_stremio_connection(uuid)
  from public, anon, authenticated;

grant execute on function public.cebola_upsert_stremio_connection(
  uuid, text, text, text, text, text, text, integer, timestamptz
) to service_role;
grant execute on function public.cebola_delete_stremio_connection(uuid)
  to service_role;
