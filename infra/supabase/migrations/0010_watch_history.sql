-- Separar histórico de conclusão, reprodução atual e visibilidade na home.
-- A marca legada completed é a única evidência disponível: não é possível distinguir
-- retrospectivamente uma conclusão real de uma remoção feita pela interface antiga.
alter table public.watch_progress
  add column watched boolean not null default false,
  add column hidden_from_continue boolean not null default false,
  add column hidden_at timestamptz;
update public.watch_progress set watched = completed;

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
    duration_seconds, completed, updated_at, playback_scenario, watched, hidden_from_continue
  ) values (
    p_id, p_household_id, p_profile_id, trim(p_addon_id),
    case when p_playback_addon_id is null then null else trim(p_playback_addon_id) end,
    trim(p_media_id), trim(p_video_id), p_media_type, trim(p_title),
    case when p_episode_title is null then null else trim(p_episode_title) end,
    p_season, p_episode, p_poster_url, p_position_seconds, p_duration_seconds,
    p_completed, p_updated_at, p_playback_scenario, p_completed, false
  )
  on conflict (profile_id, media_id, video_id) do update set
    addon_id = excluded.addon_id, playback_addon_id = excluded.playback_addon_id,
    media_type = excluded.media_type, title = excluded.title, episode_title = excluded.episode_title,
    season = excluded.season, episode = excluded.episode, poster_url = excluded.poster_url,
    position_seconds = excluded.position_seconds, duration_seconds = excluded.duration_seconds,
    completed = excluded.completed, updated_at = excluded.updated_at,
    watched = public.watch_progress.watched or excluded.completed,
    hidden_from_continue = public.watch_progress.hidden_from_continue and excluded.updated_at < public.watch_progress.hidden_at,
    playback_scenario = excluded.playback_scenario
  where public.watch_progress.updated_at <= excluded.updated_at
  returning * into result;
  if result.id is null then
    -- Uma conclusão entregue offline ainda é evidência de que a obra foi assistida,
    -- mas não pode substituir posição/cenário de uma reprodução mais nova.
    update public.watch_progress set watched = watched or p_completed
    where profile_id = p_profile_id and media_id = trim(p_media_id) and video_id = trim(p_video_id)
    returning * into result;
  end if;
  return result;
end;
$$;


create or replace function public.cebola_list_watch_progress(
  p_household_id uuid, p_profile_id uuid, p_limit integer default 30,
  p_include_completed boolean default false
)
returns setof public.watch_progress
language sql stable security definer set search_path = public, pg_temp
as $$
  select w.* from public.watch_progress w
  where w.household_id = p_household_id and w.profile_id = p_profile_id
    and not w.hidden_from_continue
    and (p_include_completed or not w.completed)
    and p_limit between 1 and 100
    and exists (select 1 from public.profiles where id = p_profile_id and household_id = p_household_id)
  order by w.updated_at desc, w.id
  limit least(greatest(p_limit, 1), 100);
$$;

-- IDs de vídeo também localizam registros salvos pela rota editorial ou por outro catálogo.
-- A paginação é por obra: episódios antigos não dependem do recorte recente de todo o perfil.
create function public.cebola_title_watch_progress(
  p_household_id uuid, p_profile_id uuid, p_media_id text,
  p_media_type public.cebola_media_type, p_video_ids text, p_offset integer default 0
)
returns setof public.watch_progress
language sql stable security definer set search_path = public, pg_temp
as $$
  select w.* from public.watch_progress w
  where w.household_id = p_household_id and w.profile_id = p_profile_id
    and w.media_type = p_media_type
    and (w.media_id = p_media_id or w.video_id in (select jsonb_array_elements_text(p_video_ids::jsonb))
      or (p_media_type = 'movie' and w.media_id in (select jsonb_array_elements_text(p_video_ids::jsonb))))
    and exists (select 1 from public.profiles where id = p_profile_id and household_id = p_household_id)
  order by w.updated_at desc, w.id
  limit 100 offset greatest(p_offset, 0);
$$;

-- Oculta todos os episódios da obra, inclusive os que estão fora das 30 entradas da home.
-- Não modifica posição, conclusão, cenário nem data da última reprodução.
create function public.cebola_hide_watch_progress(
  p_household_id uuid, p_profile_id uuid, p_media_id text,
  p_media_type public.cebola_media_type, p_video_id text, p_hidden_at timestamptz
)
returns setof uuid
language sql security definer set search_path = public, pg_temp
as $$
  update public.watch_progress w set hidden_from_continue = true, hidden_at = p_hidden_at
  where w.household_id = p_household_id and w.profile_id = p_profile_id
    and w.media_type = p_media_type
    and (w.media_id = p_media_id or w.video_id = p_video_id or
      (p_media_type = 'series' and substring(p_video_id from '^(tt[0-9]{7,10}):') is not null
        and split_part(w.video_id, ':', 1) = substring(p_video_id from '^(tt[0-9]{7,10}):')))
    and exists (select 1 from public.profiles where id = p_profile_id and household_id = p_household_id)
  returning w.id;
$$;

revoke all on function public.cebola_title_watch_progress(uuid, uuid, text, public.cebola_media_type, text, integer) from public, anon, authenticated;
revoke all on function public.cebola_hide_watch_progress(uuid, uuid, text, public.cebola_media_type, text, timestamptz) from public, anon, authenticated;
grant execute on function public.cebola_title_watch_progress(uuid, uuid, text, public.cebola_media_type, text, integer) to service_role;
grant execute on function public.cebola_hide_watch_progress(uuid, uuid, text, public.cebola_media_type, text, timestamptz) to service_role;
