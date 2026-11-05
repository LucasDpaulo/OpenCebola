-- Histórico e progresso pertencem sempre a um perfil ativo. A API usa as
-- funções abaixo com service_role; clientes continuam bloqueados por RLS.

create type public.cebola_media_type as enum ('movie', 'series');

alter table public.profiles
  add constraint profiles_id_household_unique unique (id, household_id);

create table public.watch_progress (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  profile_id uuid not null,
  media_id text not null check (char_length(trim(media_id)) between 1 and 255),
  video_id text not null check (char_length(trim(video_id)) between 1 and 255),
  media_type public.cebola_media_type not null,
  title text not null check (char_length(trim(title)) between 1 and 300),
  episode_title text check (
    episode_title is null or char_length(trim(episode_title)) between 1 and 300
  ),
  season integer check (season is null or season between 0 and 10000),
  episode integer check (episode is null or episode between 0 and 10000),
  poster_url text check (poster_url is null or char_length(poster_url) <= 2048),
  position_seconds integer not null check (position_seconds between 0 and 604800),
  duration_seconds integer not null check (duration_seconds between 1 and 604800),
  completed boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint watch_progress_position_within_duration
    check (position_seconds <= duration_seconds),
  constraint watch_progress_profile_household_fk
    foreign key (profile_id, household_id)
    references public.profiles(id, household_id)
    on delete cascade,
  constraint watch_progress_video_unique unique (profile_id, media_id, video_id)
);

create index watch_progress_recent_profile_idx
  on public.watch_progress (household_id, profile_id, updated_at desc);

alter table public.watch_progress enable row level security;

comment on table public.watch_progress is
  'Progresso isolado por perfil; acesso exclusivo da API Cebola e sem cache no cliente.';

create or replace function public.cebola_upsert_watch_progress(
  p_id uuid,
  p_household_id uuid,
  p_profile_id uuid,
  p_media_id text,
  p_video_id text,
  p_media_type public.cebola_media_type,
  p_title text,
  p_episode_title text,
  p_season integer,
  p_episode integer,
  p_poster_url text,
  p_position_seconds integer,
  p_duration_seconds integer,
  p_completed boolean,
  p_updated_at timestamptz
)
returns public.watch_progress
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result public.watch_progress;
begin
  if not exists (
    select 1
    from public.profiles
    where id = p_profile_id and household_id = p_household_id
  ) then
    raise exception 'profile_not_found' using errcode = 'P0002';
  end if;

  insert into public.watch_progress (
    id,
    household_id,
    profile_id,
    media_id,
    video_id,
    media_type,
    title,
    episode_title,
    season,
    episode,
    poster_url,
    position_seconds,
    duration_seconds,
    completed,
    updated_at
  ) values (
    p_id,
    p_household_id,
    p_profile_id,
    trim(p_media_id),
    trim(p_video_id),
    p_media_type,
    trim(p_title),
    case when p_episode_title is null then null else trim(p_episode_title) end,
    p_season,
    p_episode,
    p_poster_url,
    p_position_seconds,
    p_duration_seconds,
    p_completed,
    p_updated_at
  )
  on conflict (profile_id, media_id, video_id)
  do update set
    media_type = excluded.media_type,
    title = excluded.title,
    episode_title = excluded.episode_title,
    season = excluded.season,
    episode = excluded.episode,
    poster_url = excluded.poster_url,
    position_seconds = excluded.position_seconds,
    duration_seconds = excluded.duration_seconds,
    completed = excluded.completed,
    updated_at = excluded.updated_at
  where public.watch_progress.updated_at <= excluded.updated_at
  returning * into result;

  if result.id is null then
    select * into result
    from public.watch_progress
    where profile_id = p_profile_id
      and media_id = trim(p_media_id)
      and video_id = trim(p_video_id);
  end if;

  return result;
end;
$$;

create or replace function public.cebola_list_watch_progress(
  p_household_id uuid,
  p_profile_id uuid,
  p_limit integer default 30,
  p_include_completed boolean default false
)
returns setof public.watch_progress
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select progress.*
  from public.watch_progress as progress
  where progress.household_id = p_household_id
    and progress.profile_id = p_profile_id
    and (p_include_completed or not progress.completed)
    and p_limit between 1 and 100
    and exists (
      select 1
      from public.profiles
      where id = p_profile_id and household_id = p_household_id
    )
  order by progress.updated_at desc
  limit least(greatest(p_limit, 1), 100);
$$;

revoke all on table public.watch_progress from public, anon, authenticated;
revoke all on function public.cebola_upsert_watch_progress(
  uuid, uuid, uuid, text, text, public.cebola_media_type, text, text,
  integer, integer, text, integer, integer, boolean, timestamptz
) from public, anon, authenticated;
revoke all on function public.cebola_list_watch_progress(
  uuid, uuid, integer, boolean
) from public, anon, authenticated;

grant execute on function public.cebola_upsert_watch_progress(
  uuid, uuid, uuid, text, text, public.cebola_media_type, text, text,
  integer, integer, text, integer, integer, boolean, timestamptz
) to service_role;
grant execute on function public.cebola_list_watch_progress(
  uuid, uuid, integer, boolean
) to service_role;
