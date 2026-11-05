-- Atomic write entry points used by the API repository. The household row lock
-- serializes concurrent writes for one household; existing limit triggers are
-- retained as defense in depth for writes outside these functions.

create function public.cebola_create_profile_within_limit(
  p_id uuid,
  p_household_id uuid,
  p_name text,
  p_avatar_url text,
  p_pin_hash text,
  p_created_at timestamptz
)
returns public.profiles
language plpgsql
set search_path = ''
as $$
declare
  created_profile public.profiles;
begin
  perform 1
  from public.households
  where id = p_household_id
  for update;

  if not found then
    raise exception 'household_not_found' using errcode = 'foreign_key_violation';
  end if;

  if (select count(*) from public.profiles where household_id = p_household_id) >= 8 then
    raise exception 'profile_limit_reached' using errcode = 'check_violation';
  end if;

  insert into public.profiles (
    id, household_id, name, avatar_url, pin_hash, created_at, updated_at
  ) values (
    p_id, p_household_id, p_name, p_avatar_url, p_pin_hash, p_created_at, p_created_at
  )
  returning * into created_profile;

  return created_profile;
end;
$$;

create function public.cebola_register_device_within_limit(
  p_id uuid,
  p_household_id uuid,
  p_display_name text,
  p_type public.cebola_device_type,
  p_created_at timestamptz
)
returns public.devices
language plpgsql
set search_path = ''
as $$
declare
  created_device public.devices;
begin
  perform 1
  from public.households
  where id = p_household_id
  for update;

  if not found then
    raise exception 'household_not_found' using errcode = 'foreign_key_violation';
  end if;

  if (
    select count(*)
    from public.devices
    where household_id = p_household_id and status = 'active'
  ) >= 20 then
    raise exception 'device_limit_reached' using errcode = 'check_violation';
  end if;

  insert into public.devices (
    id,
    household_id,
    display_name,
    type,
    status,
    device_secret_hash,
    created_at
  ) values (
    p_id,
    p_household_id,
    p_display_name,
    p_type,
    'active',
    pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '') ||
      pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''),
    p_created_at
  )
  returning * into created_device;

  return created_device;
end;
$$;

revoke all on function public.cebola_create_profile_within_limit(
  uuid, uuid, text, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.cebola_register_device_within_limit(
  uuid, uuid, text, public.cebola_device_type, timestamptz
) from public, anon, authenticated;

grant execute on function public.cebola_create_profile_within_limit(
  uuid, uuid, text, text, text, timestamptz
) to service_role;
grant execute on function public.cebola_register_device_within_limit(
  uuid, uuid, text, public.cebola_device_type, timestamptz
) to service_role;
