-- Executar em banco de teste após as migrations 0001–0010. Tudo é revertido no final.
begin;
do $$
declare
  owner_id uuid := gen_random_uuid();
  house_id uuid := gen_random_uuid();
  profile uuid := gen_random_uuid();
  other_profile uuid := gen_random_uuid();
  result public.watch_progress;
  count_items integer;
begin
  insert into auth.users(id) values (owner_id);
  insert into public.households(id, owner_user_id, name) values (house_id, owner_id, 'Teste');
  insert into public.profiles(id, household_id, name) values (profile, house_id, 'Teste'), (other_profile, house_id, 'Outro');
  for episode in 1..125 loop
    result := public.cebola_upsert_watch_progress(
      gen_random_uuid(), house_id, profile, 'catalog', null,
      case when episode = 1 then 'tmdb:42' else 'tt1234567' end,
      'tt1234567:1:' || episode, 'series', 'Série', null, 1, episode, null,
      120, 1000, false, '2026-10-14 10:00:00+00', null
    );
  end loop;
  select count(*) into count_items from public.cebola_title_watch_progress(house_id, profile, 'tt1234567', 'series', '["tt1234567:1:1"]', 0);
  assert count_items = 100, 'primeira página';
  select count(*) into count_items from public.cebola_title_watch_progress(house_id, profile, 'tt1234567', 'series', '["tt1234567:1:1"]', 100);
  assert count_items = 25, 'segunda página incluindo alias';
  select count(*) into count_items from public.cebola_title_watch_progress(house_id, other_profile, 'tt1234567', 'series', '[]', 0);
  assert count_items = 0, 'isolamento entre perfis';

  -- Uma conclusão atrasada altera somente o histórico permanente.
  result := public.cebola_upsert_watch_progress(gen_random_uuid(), house_id, profile, 'catalog', null,
    'tt1234567', 'tt1234567:1:2', 'series', 'Série', null, 1, 2, null,
    1000, 1000, true, '2026-10-13 10:00:00+00', null);
  assert result.watched and not result.completed and result.position_seconds = 120, 'conclusão offline após revisão';

  perform public.cebola_hide_watch_progress(house_id, profile, 'tt1234567', 'series', 'tt1234567:1:2', '2026-10-15 10:00:00+00');
  select count(*) into count_items from public.cebola_list_watch_progress(house_id, profile, 100, true);
  assert count_items = 0, 'ocultar série inteira, inclusive alias antigo';
  select count(*) into count_items from public.watch_progress where profile_id = profile and hidden_from_continue and not completed and position_seconds = 120;
  assert count_items = 125, 'ocultar não conclui nem muda posição';

  result := public.cebola_upsert_watch_progress(gen_random_uuid(), house_id, profile, 'catalog', null,
    'tt1234567', 'tt1234567:1:2', 'series', 'Série', null, 1, 2, null,
    180, 1000, false, '2026-10-14 11:00:00+00', null);
  assert result.hidden_from_continue and result.watched, 'pendência anterior à remoção não reaparece';
  result := public.cebola_upsert_watch_progress(gen_random_uuid(), house_id, profile, 'catalog', null,
    'tt1234567', 'tt1234567:1:2', 'series', 'Série', null, 1, 2, null,
    240, 1000, false, '2026-10-15 11:00:00+00', null);
  assert not result.hidden_from_continue and result.watched and not result.completed, 'nova reprodução reaparece e mantém assistido';
  assert not has_function_privilege('anon', 'public.cebola_title_watch_progress(uuid,uuid,text,public.cebola_media_type,text,integer)', 'execute'), 'RPC protegida';
end;
$$;
rollback;
