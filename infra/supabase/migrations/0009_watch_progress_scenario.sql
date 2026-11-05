-- Fonte, trilhas de áudio/legenda e ajustes exatos da última reprodução válida. Guardado junto do
-- registro de progresso para retomar fielmente sem depender de heurística no cliente. Progresso
-- legado (gravado antes desta coluna existir) fica com `null`, nunca um objeto inventado.
alter table public.watch_progress
  add column playback_scenario jsonb check (
    playback_scenario is null or jsonb_typeof(playback_scenario) = 'object'
  );

drop function if exists public.cebola_upsert_watch_progress(
  uuid, uuid, uuid, text, text, text, text, public.cebola_media_type, text, text,
  integer, integer, text, integer, integer, boolean, timestamptz
);

create or replace function public.cebola_upsert_watch_progress(
  p_id uuid, p_household_id uuid, p_profile_id uuid, p_addon_id text,
  p_playback_addon_id text, p_media_id text, p_video_id text,
  p_media_type public.cebola_media_type, p_title text, p_episode_title text,
  p_season integer, p_episode integer, p_poster_url text, p_position_seconds integer,
  p_duration_seconds integer, p_completed boolean, p_updated_at timestamptz,
  p_playback_scenario jsonb default null
)
returns public.watch_progress
language plpgsql security definer set search_path = public, pg_temp
as $$
declare result public.watch_progress;
begin
  if p_playback_scenario is not null and jsonb_typeof(p_playback_scenario) <> 'object' then
    raise exception 'invalid_playback_scenario' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = p_profile_id and household_id = p_household_id) then
    raise exception 'profile_not_found' using errcode = 'P0002';
  end if;
  insert into public.watch_progress (
    id, household_id, profile_id, addon_id, playback_addon_id, media_id, video_id,
    media_type, title, episode_title, season, episode, poster_url, position_seconds,
    duration_seconds, completed, updated_at, playback_scenario
  ) values (
    p_id, p_household_id, p_profile_id, trim(p_addon_id),
    case when p_playback_addon_id is null then null else trim(p_playback_addon_id) end,
    trim(p_media_id), trim(p_video_id), p_media_type, trim(p_title),
    case when p_episode_title is null then null else trim(p_episode_title) end,
    p_season, p_episode, p_poster_url, p_position_seconds, p_duration_seconds,
    p_completed, p_updated_at, p_playback_scenario
  )
  on conflict (profile_id, media_id, video_id) do update set
    addon_id = excluded.addon_id, playback_addon_id = excluded.playback_addon_id,
    media_type = excluded.media_type, title = excluded.title, episode_title = excluded.episode_title,
    season = excluded.season, episode = excluded.episode, poster_url = excluded.poster_url,
    position_seconds = excluded.position_seconds, duration_seconds = excluded.duration_seconds,
    completed = excluded.completed, updated_at = excluded.updated_at,
    playback_scenario = excluded.playback_scenario
  where public.watch_progress.updated_at <= excluded.updated_at
  returning * into result;
  if result.id is null then
    select * into result from public.watch_progress
    where profile_id = p_profile_id and media_id = trim(p_media_id) and video_id = trim(p_video_id);
  end if;
  return result;
end;
$$;

revoke all on function public.cebola_upsert_watch_progress(
  uuid, uuid, uuid, text, text, text, text, public.cebola_media_type, text, text,
  integer, integer, text, integer, integer, boolean, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.cebola_upsert_watch_progress(
  uuid, uuid, uuid, text, text, text, text, public.cebola_media_type, text, text,
  integer, integer, text, integer, integer, boolean, timestamptz, jsonb
) to service_role;
