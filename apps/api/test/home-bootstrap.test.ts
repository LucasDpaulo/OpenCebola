import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { InMemoryAuthProvider } from "../src/auth/index.js";
import { HouseholdService, InMemoryHouseholdRepository } from "../src/households/index.js";
import { InMemoryLibraryRepository, LibraryService } from "../src/library/index.js";
import { InMemoryWatchProgressRepository, WatchProgressService } from "../src/progress/index.js";
import { StremioApiClient, StremioService, type StremioConnectionRepository } from "../src/stremio/index.js";

const webOrigin = "http://localhost:3000";
const environment = {
  NODE_ENV: "test" as const,
  CEBOLA_API_HOST: "127.0.0.1",
  CEBOLA_API_PORT: 3001,
  CEBOLA_WEB_ORIGIN: webOrigin,
  CEBOLA_SESSION_TTL_SECONDS: 3_600
};
const userId = "26bd6155-a16d-445c-84de-20db3b0cd65f";

const emptyStremioRepository: StremioConnectionRepository = {
  async save() {},
  async find() { return null; },
  async status() { return null; },
  async delete() {}
};

async function fixture() {
  const authProvider = new InMemoryAuthProvider({
    users: [{ id: userId, email: "lucas@example.com", password: "correct-secret" }],
    tokenFactory: () => "home-bootstrap-session"
  });
  const householdRepository = new InMemoryHouseholdRepository();
  const householdService = new HouseholdService({ repository: householdRepository });
  const household = await householdService.createHousehold({ ownerId: userId, name: "Casa" });
  const profile = await householdService.createProfile({ householdId: household.id, name: "Lucas" });
  const progressService = new WatchProgressService({
    repository: new InMemoryWatchProgressRepository(),
    households: householdRepository,
    now: () => new Date("2026-08-31T12:00:00.000Z")
  });
  const libraryService = new LibraryService({
    repository: new InMemoryLibraryRepository(),
    households: householdRepository,
    now: () => new Date("2026-08-31T12:00:00.000Z")
  });
  const stremioService = new StremioService({
    api: new StremioApiClient(),
    repository: emptyStremioRepository
  });
  const app = await buildApp(environment, {
    authProvider,
    householdService,
    progressService,
    libraryService,
    stremioService
  });
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: { origin: webOrigin },
    payload: { email: "lucas@example.com", password: "correct-secret" }
  });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const token = cookie.split("=", 2)[1]!;
  return { app, authProvider, householdService, progressService, libraryService, household, profile, cookie, token };
}

test("bootstrap sem perfil ativo orienta seleção sem expor identidade interna", async () => {
  const context = await fixture();
  const response = await context.app.inject({
    method: "GET",
    url: "/v1/home/bootstrap",
    headers: { cookie: context.cookie }
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    activeProfile: null,
    progress: { items: [] },
    library: { items: [] },
    stremio: { linked: false, addonCount: 0, syncedAt: null, rejected: [] }
  });
  assert.doesNotMatch(response.body, /householdId|profileId|session|token/i);
  await context.app.close();
});

test("bootstrap valida a sessão uma vez e entrega somente o perfil ativo com seu progresso", async () => {
  const context = await fixture();
  await context.authProvider.setActiveProfile(context.token, context.profile.id);
  await context.progressService.update({
    householdId: context.household.id,
    profileId: context.profile.id,
    addonId: "community.cinemeta",
    mediaId: "tt1234567",
    videoId: "tt1234567:1:1",
    mediaType: "series",
    title: "Série de teste",
    episodeTitle: "Piloto",
    season: 1,
    episode: 1,
    positionSeconds: 600,
    durationSeconds: 2_400
  });
  await context.progressService.update({
    householdId: context.household.id,
    profileId: context.profile.id,
    addonId: "community.cinemeta",
    mediaId: "tt7654321",
    videoId: "tt7654321",
    mediaType: "movie",
    title: "Filme já concluído",
    positionSeconds: 7_200,
    durationSeconds: 7_200,
    completed: true
  });
  await context.libraryService.upsert(
    { householdId: context.household.id, profileId: context.profile.id },
    {
      addonId: "community.cinemeta",
      mediaId: "tt1234567",
      mediaType: "movie",
      name: "Horizonte Azul",
      posterUrl: "https://images.example/poster.jpg",
      backgroundUrl: null,
      description: null,
      releaseInfo: "2026"
    }
  );

  let verifications = 0;
  const verifySession = context.authProvider.verifySession.bind(context.authProvider);
  context.authProvider.verifySession = async (token) => {
    verifications += 1;
    return verifySession(token);
  };
  const response = await context.app.inject({
    method: "GET",
    url: "/v1/home/bootstrap",
    headers: { cookie: context.cookie }
  });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(verifications, 1);
  assert.equal(body.activeProfile.id, context.profile.id);
  assert.equal(body.progress.items.length, 2);
  assert.ok(body.progress.items.some((item: { title: string; completed: boolean }) => item.title === "Filme já concluído" && item.completed));
  assert.ok(body.progress.items.some((item: { positionSeconds: number }) => item.positionSeconds === 600));
  assert.equal(body.library.items.length, 1);
  assert.equal(body.library.items[0].name, "Horizonte Azul");
  assert.equal(body.library.items[0].mediaId, "tt1234567");
  assert.doesNotMatch(response.body, /householdId|profileId|session|token/i);
  await context.app.close();
});

test("perfil de outra casa gravado na sessão nunca atravessa o bootstrap", async () => {
  const context = await fixture();
  const otherHouse = await context.householdService.createHousehold({
    ownerId: "036e3cea-f3ab-4431-a265-650faf2782b8",
    name: "Outra casa"
  });
  const otherProfile = await context.householdService.createProfile({
    householdId: otherHouse.id,
    name: "Outro"
  });
  await context.authProvider.setActiveProfile(context.token, otherProfile.id);

  const response = await context.app.inject({
    method: "GET",
    url: "/v1/home/bootstrap",
    headers: { cookie: context.cookie }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).activeProfile, null);
  assert.doesNotMatch(response.body, /Outro|036e3cea|householdId|profileId/);
  await context.app.close();
});
