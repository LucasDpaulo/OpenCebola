import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { InMemoryAuthProvider } from "../src/auth/index.js";
import {
  HouseholdService,
  InMemoryHouseholdRepository
} from "../src/households/index.js";
import {
  InMemoryWatchProgressRepository,
  WatchProgressService
} from "../src/progress/index.js";

const webOrigin = "http://localhost:3000";
const environment = {
  NODE_ENV: "test" as const,
  CEBOLA_API_HOST: "127.0.0.1",
  CEBOLA_API_PORT: 3001,
  CEBOLA_WEB_ORIGIN: webOrigin,
  CEBOLA_SESSION_TTL_SECONDS: 3_600
};
const userId = "26bd6155-a16d-445c-84de-20db3b0cd65f";

async function fixture() {
  const authProvider = new InMemoryAuthProvider({
    users: [{ id: userId, email: "lucas@example.com", password: "correct-secret" }],
    tokenFactory: () => "progress-route-session"
  });
  const householdRepository = new InMemoryHouseholdRepository();
  const householdService = new HouseholdService({ repository: householdRepository });
  const household = await householdService.createHousehold({ ownerId: userId, name: "Casa" });
  const profile = await householdService.createProfile({
    householdId: household.id,
    name: "Lucas"
  });
  const progressService = new WatchProgressService({
    repository: new InMemoryWatchProgressRepository(),
    households: householdRepository,
    now: () => new Date("2026-08-19T03:00:00.000Z")
  });
  const app = await buildApp(environment, {
    authProvider,
    householdService,
    progressService
  });
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: { origin: webOrigin },
    payload: { email: "lucas@example.com", password: "correct-secret" }
  });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const token = cookie.split("=", 2)[1]!;
  return { app, authProvider, household, householdService, profile, cookie, token };
}

const episodePayload = {
  addonId: "community.cinemeta",
  playbackAddonId: "com.stremio.torrentio.addon",
  mediaId: "tt1234567",
  videoId: "tt1234567:1:4",
  mediaType: "series",
  title: "Horizonte Azul",
  episodeTitle: "A quarta rota",
  season: 1,
  episode: 4,
  positionSeconds: 1_080,
  durationSeconds: 2_700
};

const scenario = {
  source: {
    addonId: "com.stremio.torrentio.addon",
    streamId: "abc123",
    infoHash: "d34db33fd34db33fd34db33fd34db33fd34db33f",
    fileIdx: 0,
    releaseTitle: "Horizonte.Azul.S01E04.1080p"
  },
  audio: { id: "aud-1", language: "pt-BR", name: "Português" },
  subtitle: { id: "sub-1", language: "en", name: "English" },
  subtitleSettings: {
    offset: 0.5,
    extraDuration: 1,
    color: "#ffffff",
    size: 100,
    bg: "translucent",
    font: "sans"
  }
};

const otherScenario = {
  source: {
    addonId: "com.stremio.torrentio.addon",
    streamId: "def456",
    infoHash: null,
    fileIdx: null,
    releaseTitle: "Horizonte.Azul.S01E04.720p"
  },
  audio: { id: "aud-2", language: "en", name: "English" },
  subtitle: null,
  subtitleSettings: null
};

test("salva e lista o cenario de reproducao completo", async () => {
  const context = await fixture();
  await context.authProvider.setActiveProfile(context.token, context.profile.id);

  const created = await context.app.inject({
    method: "PUT",
    url: "/v1/progress",
    headers: { cookie: context.cookie, origin: webOrigin },
    payload: { ...episodePayload, playbackScenario: scenario }
  });
  assert.equal(created.statusCode, 200);
  assert.deepEqual(JSON.parse(created.body).playbackScenario, scenario);

  const listed = await context.app.inject({
    method: "GET",
    url: "/v1/progress",
    headers: { cookie: context.cookie }
  });
  const items = JSON.parse(listed.body).items;
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].playbackScenario, scenario);

  await context.app.close();
});

test("sobrescreve o cenario salvo apos uma nova escolha", async () => {
  const context = await fixture();
  await context.authProvider.setActiveProfile(context.token, context.profile.id);

  await context.app.inject({
    method: "PUT",
    url: "/v1/progress",
    headers: { cookie: context.cookie, origin: webOrigin },
    payload: { ...episodePayload, playbackScenario: scenario }
  });

  const updated = await context.app.inject({
    method: "PUT",
    url: "/v1/progress",
    headers: { cookie: context.cookie, origin: webOrigin },
    payload: { ...episodePayload, positionSeconds: 1_200, playbackScenario: otherScenario }
  });
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(JSON.parse(updated.body).playbackScenario, otherScenario);

  const listed = await context.app.inject({
    method: "GET",
    url: "/v1/progress",
    headers: { cookie: context.cookie }
  });
  assert.deepEqual(JSON.parse(listed.body).items[0].playbackScenario, otherScenario);

  await context.app.close();
});

test("payload legado sem cenario continua funcionando e devolve playbackScenario nulo", async () => {
  const context = await fixture();
  await context.authProvider.setActiveProfile(context.token, context.profile.id);

  const created = await context.app.inject({
    method: "PUT",
    url: "/v1/progress",
    headers: { cookie: context.cookie, origin: webOrigin },
    payload: episodePayload
  });
  assert.equal(created.statusCode, 200);
  assert.equal(JSON.parse(created.body).playbackScenario, null);

  const listed = await context.app.inject({
    method: "GET",
    url: "/v1/progress",
    headers: { cookie: context.cookie }
  });
  assert.equal(JSON.parse(listed.body).items[0].playbackScenario, null);

  await context.app.close();
});

test("recusa cenario com URL ou campo forjado", async () => {
  const context = await fixture();
  await context.authProvider.setActiveProfile(context.token, context.profile.id);

  const withUrl = await context.app.inject({
    method: "PUT",
    url: "/v1/progress",
    headers: { cookie: context.cookie, origin: webOrigin },
    payload: {
      ...episodePayload,
      playbackScenario: {
        ...scenario,
        source: { ...scenario.source, url: "https://example.com/stream.mp4" }
      }
    }
  });
  assert.equal(withUrl.statusCode, 400);
  assert.equal(JSON.parse(withUrl.body).error.code, "INVALID_REQUEST");

  const withForgedField = await context.app.inject({
    method: "PUT",
    url: "/v1/progress",
    headers: { cookie: context.cookie, origin: webOrigin },
    payload: {
      ...episodePayload,
      playbackScenario: { ...scenario, forgedField: true }
    }
  });
  assert.equal(withForgedField.statusCode, 400);
  assert.equal(JSON.parse(withForgedField.body).error.code, "INVALID_REQUEST");

  await context.app.close();
});

test("progresso exige perfil ativo e nunca aceita profileId escolhido pelo cliente", async () => {
  const context = await fixture();

  const withoutProfile = await context.app.inject({
    method: "PUT",
    url: "/v1/progress",
    headers: { cookie: context.cookie, origin: webOrigin },
    payload: episodePayload
  });
  assert.equal(withoutProfile.statusCode, 409);

  await context.authProvider.setActiveProfile(context.token, context.profile.id);
  const forged = await context.app.inject({
    method: "PUT",
    url: "/v1/progress",
    headers: { cookie: context.cookie, origin: webOrigin },
    payload: { ...episodePayload, profileId: "f014755e-04f8-4eb6-a13f-a3fca0f68619" }
  });
  assert.equal(forged.statusCode, 400);

  await context.app.close();
});

test("salva e sobrescreve o ponto do vídeo somente no perfil da sessão", async () => {
  const context = await fixture();
  await context.authProvider.setActiveProfile(context.token, context.profile.id);

  const created = await context.app.inject({
    method: "PUT",
    url: "/v1/progress",
    headers: { cookie: context.cookie, origin: webOrigin },
    payload: episodePayload
  });
  assert.equal(created.statusCode, 200);
  assert.equal(JSON.parse(created.body).positionSeconds, 1_080);
  assert.equal(JSON.parse(created.body).addonId, "community.cinemeta");
  assert.equal(JSON.parse(created.body).playbackAddonId, "com.stremio.torrentio.addon");
  assert.doesNotMatch(created.body, /householdId|profileId/);

  const updated = await context.app.inject({
    method: "PUT",
    url: "/v1/progress",
    headers: { cookie: context.cookie, origin: webOrigin },
    payload: { ...episodePayload, positionSeconds: 1_800 }
  });
  assert.equal(updated.statusCode, 200);

  const listed = await context.app.inject({
    method: "GET",
    url: "/v1/progress",
    headers: { cookie: context.cookie }
  });
  const items = JSON.parse(listed.body).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].positionSeconds, 1_800);
  assert.equal(items[0].addonId, "community.cinemeta");
  assert.equal(items[0].playbackAddonId, "com.stremio.torrentio.addon");
  assert.doesNotMatch(listed.body, /householdId|profileId/);

  await context.app.close();
});

for (const mediaType of ["series", "movie"] as const) {
  test(`${mediaType}: 90% conclui mesmo com completed false, preserva posição e permite rever`, async () => {
    const context = await fixture();
    await context.authProvider.setActiveProfile(context.token, context.profile.id);
    try {
      for (const [positionSeconds, expected] of [[899, false], [900, true], [950, true], [100, false]] as const) {
        const saved = await context.app.inject({
          method: "PUT", url: "/v1/progress",
          headers: { cookie: context.cookie, origin: webOrigin },
          payload: { ...episodePayload, mediaType, durationSeconds: 1000, positionSeconds, completed: false }
        });
        assert.equal(saved.statusCode, 200);
        assert.equal(JSON.parse(saved.body).completed, expected);
        assert.equal(JSON.parse(saved.body).positionSeconds, positionSeconds);
        const recent = await context.app.inject({
          method: "GET", url: "/v1/progress", headers: { cookie: context.cookie }
        });
        assert.equal(JSON.parse(recent.body).items.length, expected ? 0 : 1);
        const history = await context.app.inject({
          method: "GET", url: "/v1/progress?includeCompleted=true", headers: { cookie: context.cookie }
        });
        assert.equal(JSON.parse(history.body).items[0].completed, expected);
      }
      const ended = await context.app.inject({
        method: "PUT", url: "/v1/progress",
        headers: { cookie: context.cookie, origin: webOrigin },
        payload: { ...episodePayload, mediaType, positionSeconds: 100, completed: true }
      });
      assert.equal(ended.statusCode, 200);
      assert.equal(JSON.parse(ended.body).completed, true);
    } finally {
      await context.app.close();
    }
  });
}

test("concluídos saem de Continuar assistindo e outro perfil não pode ser forjado", async () => {
  const context = await fixture();
  await context.authProvider.setActiveProfile(context.token, context.profile.id);
  const completed = await context.app.inject({
    method: "PUT",
    url: "/v1/progress",
    headers: { cookie: context.cookie, origin: webOrigin },
    payload: { ...episodePayload, positionSeconds: 2_600 }
  });
  assert.equal(JSON.parse(completed.body).completed, true);

  const current = await context.app.inject({
    method: "GET",
    url: "/v1/progress",
    headers: { cookie: context.cookie }
  });
  assert.deepEqual(JSON.parse(current.body), { items: [] });

  const history = await context.app.inject({
    method: "GET",
    url: "/v1/progress?includeCompleted=true&limit=10",
    headers: { cookie: context.cookie }
  });
  assert.equal(JSON.parse(history.body).items.length, 1);

  const otherHouse = await context.householdService.createHousehold({
    ownerId: "036e3cea-f3ab-4431-a265-650faf2782b8",
    name: "Outra casa"
  });
  const otherProfile = await context.householdService.createProfile({
    householdId: otherHouse.id,
    name: "Outro"
  });
  await context.authProvider.setActiveProfile(context.token, otherProfile.id);
  const crossHouse = await context.app.inject({
    method: "GET",
    url: "/v1/progress",
    headers: { cookie: context.cookie }
  });
  assert.equal(crossHouse.statusCode, 404);

  await context.app.close();
});


test("posterUrl aceita apenas https, seguindo a política do gateway", async () => {
  const context = await fixture();
  await context.authProvider.setActiveProfile(context.token, context.profile.id);

  const inseguro = await context.app.inject({
    method: "PUT",
    url: "/v1/progress",
    headers: { cookie: context.cookie, origin: webOrigin },
    payload: { ...episodePayload, posterUrl: "http://images.example/poster.jpg" }
  });
  assert.equal(inseguro.statusCode, 400);
  assert.equal(JSON.parse(inseguro.body).error.code, "INVALID_REQUEST");

  const seguro = await context.app.inject({
    method: "PUT",
    url: "/v1/progress",
    headers: { cookie: context.cookie, origin: webOrigin },
    payload: { ...episodePayload, posterUrl: "https://images.example/poster.jpg" }
  });
  assert.equal(seguro.statusCode, 200);
  assert.equal(JSON.parse(seguro.body).posterUrl, "https://images.example/poster.jpg");

  await context.app.close();
});

test("a casa nasce na primeira rota autenticada, sem nunca visitar /v1/profiles", async () => {
  // Fixture própria: usuária nova, sem casa, e as rotas de /v1/profiles nem
  // sequer registradas — o provisionamento não pode depender delas.
  const newUserId = "5f2b7c39-9c1d-4d61-9b71-6a4f2f4f2ad4";
  const authProvider = new InMemoryAuthProvider({
    users: [{ id: newUserId, email: "novata@example.com", password: "correct-secret" }],
    tokenFactory: () => "progress-first-contact-session"
  });
  const householdRepository = new InMemoryHouseholdRepository();
  const householdService = new HouseholdService({ repository: householdRepository });
  const progressService = new WatchProgressService({
    repository: new InMemoryWatchProgressRepository(),
    households: householdRepository,
    now: () => new Date("2026-08-19T03:00:00.000Z")
  });
  const app = await buildApp(environment, {
    authProvider,
    householdService,
    progressService
  });
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: { origin: webOrigin },
    payload: { email: "novata@example.com", password: "correct-secret" }
  });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const token = cookie.split("=", 2)[1]!;
  assert.equal(await householdService.findHouseholdByOwnerId(newUserId), null);

  // Primeira chamada autenticada é PUT /v1/progress: o contrato existente se
  // mantém (409 enquanto não há perfil ativo), mas a casa nasce aqui mesmo.
  const firstContact = await app.inject({
    method: "PUT",
    url: "/v1/progress",
    headers: { cookie, origin: webOrigin },
    payload: episodePayload
  });
  assert.equal(firstContact.statusCode, 409);
  assert.equal(JSON.parse(firstContact.body).error.code, "ACTIVE_PROFILE_REQUIRED");

  const bornHere = await householdService.findHouseholdByOwnerId(newUserId);
  assert.ok(bornHere);
  assert.equal(bornHere.name, "Minha casa");

  // Com um perfil criado na casa recém-nascida, o mesmo PUT completa o fluxo.
  const profile = await householdService.createProfile({
    householdId: bornHere.id,
    name: "Novata"
  });
  await authProvider.setActiveProfile(token, profile.id);
  const saved = await app.inject({
    method: "PUT",
    url: "/v1/progress",
    headers: { cookie, origin: webOrigin },
    payload: episodePayload
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(JSON.parse(saved.body).positionSeconds, 1_080);

  await app.close();
});

for (const mediaType of ["movie", "series"] as const) {
  test(`${mediaType}: rever mantém histórico assistido; ocultar não altera posição nem conclusão`, async () => {
    const context = await fixture();
    try {
      await context.authProvider.setActiveProfile(context.token, context.profile.id);
      const headers = { cookie: context.cookie, origin: webOrigin };
      const payload = { ...episodePayload, mediaType };
      const save = (extra: object) => context.app.inject({ method: "PUT", url: "/v1/progress", headers, payload: { ...payload, ...extra } });
      assert.equal((await save({ positionSeconds: 2500 })).json().watched, true);
      const replay = await save({ positionSeconds: 120, completed: false });
      assert.equal(replay.json().completed, false);
      assert.equal(replay.json().watched, true);
      const hidden = await context.app.inject({ method: "PUT", url: "/v1/progress/hidden", headers,
        payload: { mediaId: payload.mediaId, videoId: payload.videoId, mediaType } });
      assert.equal(hidden.statusCode, 204);
      const recent = await context.app.inject({ method: "GET", url: "/v1/progress?includeCompleted=true", headers });
      assert.deepEqual(recent.json().items, []);
      const history = await context.app.inject({ method: "POST", url: "/v1/progress/title", headers,
        payload: { mediaId: payload.mediaId, mediaType } });
      assert.equal(history.statusCode, 200);
      assert.equal(history.json().items[0].positionSeconds, 120);
      assert.equal(history.json().items[0].completed, false);
      assert.equal(history.json().items[0].watched, true);
      assert.equal(history.json().items[0].hiddenFromContinue, true);
      assert.equal((await save({ positionSeconds: 180 })).json().hiddenFromContinue, false);
    } finally { await context.app.close(); }
  });
}

test("ocultar um episódio abandonado não o transforma em assistido e protege o perfil", async () => {
  const context = await fixture();
  try {
    await context.authProvider.setActiveProfile(context.token, context.profile.id);
    const headers = { cookie: context.cookie, origin: webOrigin };
    await context.app.inject({ method: "PUT", url: "/v1/progress", headers, payload: episodePayload });
    const target = { mediaId: episodePayload.mediaId, mediaType: "series", videoId: episodePayload.videoId };
    assert.equal((await context.app.inject({ method: "PUT", url: "/v1/progress/hidden", headers: { cookie: context.cookie }, payload: target })).statusCode, 403);
    assert.equal((await context.app.inject({ method: "PUT", url: "/v1/progress/hidden", headers, payload: { ...target, profileId: context.profile.id } })).statusCode, 400);
    const other = await context.householdService.createProfile({ householdId: context.household.id, name: "Outro" });
    await context.authProvider.setActiveProfile(context.token, other.id);
    await context.app.inject({ method: "PUT", url: "/v1/progress/hidden", headers, payload: target });
    const lookup = { method: "POST" as const, url: "/v1/progress/title", headers,
      payload: { mediaId: target.mediaId, mediaType: "series" } };
    assert.deepEqual((await context.app.inject(lookup)).json().items, []);
    await context.authProvider.setActiveProfile(context.token, context.profile.id);
    assert.equal((await context.app.inject(lookup)).json().items[0].hiddenFromContinue, false);
    await context.app.inject({ method: "PUT", url: "/v1/progress/hidden", headers, payload: target });
    const item = (await context.app.inject(lookup)).json().items[0];
    assert.equal(item.completed, false);
    assert.equal(item.watched, false);
    assert.equal(item.positionSeconds, episodePayload.positionSeconds);
  } finally { await context.app.close(); }
});

test("histórico da obra pagina mais de 100 episódios, inclui aliases e oculta a série inteira", async () => {
  // Sem HTTP por gravação: não atingir o rate limit do player ao preparar o histórico.
  const repository = new InMemoryWatchProgressRepository();
  const households = new InMemoryHouseholdRepository();
  const service = new HouseholdService({ repository: households });
  const household = await service.createHousehold({ ownerId: userId, name: "Casa" });
  const profile = await service.createProfile({ householdId: household.id, name: "Lucas" });
  let clock = 0;
  const progress = new WatchProgressService({ repository, households, now: () => new Date(++clock * 1000) });
  for (let episode = 1; episode <= 125; episode++) {
    await progress.update({ ...episodePayload, mediaType: "series", householdId: household.id, profileId: profile.id,
      episode, videoId: `tt1234567:1:${episode}`, mediaId: episode === 1 ? "tmdb:42" : episodePayload.mediaId });
  }
  // Uma obra diferente ocupa o topo do histórico recente.
  await progress.update({ ...episodePayload, mediaType: "movie", householdId: household.id, profileId: profile.id,
    mediaId: "tt9999999", videoId: "tt9999999" });
  const target = { mediaId: episodePayload.mediaId, mediaType: "series" as const, videoIds: ["tt1234567:1:1"] };
  const first = await progress.listForTitle(household.id, profile.id, target, 0);
  const second = await progress.listForTitle(household.id, profile.id, target, 100);
  assert.equal(first.length, 100);
  assert.equal(second.length, 25);
  assert.equal(second[24]?.mediaId, "tmdb:42");
  await progress.hideTitle(household.id, profile.id, { ...target, videoIds: ["tt1234567:1:125"] });
  assert.equal((await progress.listRecent(household.id, profile.id, 100, true)).length, 1);
  const hidden = await progress.listForTitle(household.id, profile.id, target, 100);
  assert.ok(hidden.every((item) => item.hiddenFromContinue && !item.watched && !item.completed));
});

test("pendência offline não muda de perfil nem apaga progresso mais recente", async () => {
  const context = await fixture();
  try {
    await context.authProvider.setActiveProfile(context.token, context.profile.id);
    const headers = { cookie: context.cookie, origin: webOrigin };
    const save = (extra: object) => context.app.inject({ method: "PUT", url: "/v1/progress", headers,
      payload: { ...episodePayload, expectedProfileId: context.profile.id, ...extra } });
    const other = await context.householdService.createProfile({ householdId: context.household.id, name: "Outro" });
    await context.authProvider.setActiveProfile(context.token, other.id);
    assert.equal((await save({})).statusCode, 409);
    await context.authProvider.setActiveProfile(context.token, context.profile.id);
    const replay = await save({ positionSeconds: 180, observedAt: "2026-08-19T02:00:00.000Z" });
    assert.equal(replay.json().watched, false);
    // Conclusão antiga chega depois da nova reprodução: preserva o histórico e a posição nova.
    const late = await save({ positionSeconds: 2700, completed: true, observedAt: "2026-08-18T02:00:00.000Z" });
    assert.equal(late.json().watched, true);
    assert.equal(late.json().completed, false);
    assert.equal(late.json().positionSeconds, 180);
    const target = { mediaId: episodePayload.mediaId, videoId: episodePayload.videoId, mediaType: "series" };
    await context.app.inject({ method: "PUT", url: "/v1/progress/hidden", headers, payload: target });
    const pending = await save({ positionSeconds: 240, observedAt: "2026-08-19T02:30:00.000Z" });
    assert.equal(pending.json().hiddenFromContinue, true);
    // Datas futuras não bloqueiam futuras gravações no banco.
    const future = await save({ positionSeconds: 300, observedAt: "2099-01-01T00:00:00.000Z" });
    assert.equal(future.json().updatedAt, "2026-08-19T03:00:00.000Z");
    assert.equal(future.json().hiddenFromContinue, false);
  } finally { await context.app.close(); }
});

test("salvar apenas a fonte não inventa uma escolha de desligar legendas", async () => {
  const context = await fixture();
  try {
    await context.authProvider.setActiveProfile(context.token, context.profile.id);
    const headers = { cookie: context.cookie, origin: webOrigin };
    const response = await context.app.inject({ method: "PUT", url: "/v1/progress", headers,
      payload: { ...episodePayload, playbackScenario: { source: scenario.source } } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().playbackScenario, { source: scenario.source });
    const explicitOff = await context.app.inject({ method: "PUT", url: "/v1/progress", headers,
      payload: { ...episodePayload, playbackScenario: { source: scenario.source, subtitle: null } } });
    assert.equal(explicitOff.json().playbackScenario.subtitle, null);
  } finally { await context.app.close(); }
});
