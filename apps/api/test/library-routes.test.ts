import assert from "node:assert/strict";
import test from "node:test";
import { libraryResponseSchema } from "@cebola/contracts";
import { buildApp } from "../src/app.js";
import { InMemoryAuthProvider } from "../src/auth/index.js";
import { HouseholdService, InMemoryHouseholdRepository } from "../src/households/index.js";
import { InMemoryLibraryRepository, LibraryService } from "../src/library/index.js";

const webOrigin = "http://localhost:3000";
const environment = {
  NODE_ENV: "test" as const,
  CEBOLA_API_HOST: "127.0.0.1",
  CEBOLA_API_PORT: 3001,
  CEBOLA_WEB_ORIGIN: webOrigin,
  CEBOLA_SESSION_TTL_SECONDS: 3_600
};
const userId = "26bd6155-a16d-445c-84de-20db3b0cd65f";
const movie = {
  addonId: "community.cinemeta",
  mediaId: "tt1234567",
  mediaType: "movie" as const,
  name: "Horizonte Azul",
  posterUrl: "https://images.example/poster.jpg",
  backgroundUrl: null,
  description: null,
  releaseInfo: "2026"
};
const requests = [
  { method: "GET" as const, url: "/v1/library" },
  { method: "PUT" as const, url: "/v1/library", payload: movie },
  { method: "POST" as const, url: "/v1/library/import", payload: { items: [movie] } },
  { method: "DELETE" as const, url: "/v1/library/movie/tt1234567" }
];

async function fixture(t: test.TestContext) {
  const authProvider = new InMemoryAuthProvider({
    users: [{ id: userId, email: "lucas@example.com", password: "correct-secret" }],
    tokenFactory: () => "library-route-session"
  });
  const householdRepository = new InMemoryHouseholdRepository();
  const householdService = new HouseholdService({ repository: householdRepository });
  const libraryService = new LibraryService({
    repository: new InMemoryLibraryRepository(),
    households: householdRepository,
    now: () => new Date("2026-09-18T03:00:00.000Z")
  });
  const app = await buildApp(environment, { authProvider, householdService, libraryService });
  t.after(() => app.close());
  const login = await app.inject({
    method: "POST", url: "/v1/auth/login", headers: { origin: webOrigin },
    payload: { email: "lucas@example.com", password: "correct-secret" }
  });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const token = cookie.split("=", 2)[1]!;
  const headers = { cookie, origin: webOrigin };
  async function activate() {
    const household = await householdService.ensureHouseholdForOwner(userId);
    const profile = await householdService.createProfile({ householdId: household.id, name: "Lucas" });
    await authProvider.setActiveProfile(token, profile.id);
    return { household, profile };
  }
  return { app, authProvider, householdService, libraryService, headers, cookie, token, activate };
}

for (const request of requests) {
  test(`${request.method} ${request.url} exige sessão verificada`, async (t) => {
    const context = await fixture(t);
    for (const headers of [{ origin: webOrigin }, { authorization: "Bearer invalid-session" }]) {
      const response = await context.app.inject({ ...request, headers });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error.code, "AUTHENTICATION_FAILED");
    }
  });

  test(`${request.method} ${request.url} garante casa e exige perfil ativo`, async (t) => {
    const context = await fixture(t);
    assert.equal(await context.householdService.findHouseholdByOwnerId(userId), null);
    const response = await context.app.inject({ ...request, headers: context.headers });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "ACTIVE_PROFILE_REQUIRED");
    assert.ok(await context.householdService.findHouseholdByOwnerId(userId));
  });
}

test("salva, atualiza e lista somente os campos públicos do item", async (t) => {
  const context = await fixture(t);
  await context.activate();
  const saved = await context.app.inject({ ...requests[1]!, headers: context.headers });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().name, "Horizonte Azul");
  assert.equal(saved.json().createdAt, "2026-09-18T03:00:00.000Z");
  const updated = await context.app.inject({
    ...requests[1]!, headers: context.headers,
    payload: { ...movie, addonId: "other.addon", name: "Novo título" }
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().id, saved.json().id);
  const listed = await context.app.inject({ ...requests[0]!, headers: context.headers });
  assert.equal(listed.statusCode, 200);
  const { items } = libraryResponseSchema.parse(listed.json());
  assert.equal(items.length, 1);
  assert.equal(items[0]!.name, "Novo título");
  assert.equal(items[0]!.addonId, "other.addon");
  assert.doesNotMatch(saved.body + listed.body, /householdId|profileId/);
  assert.equal(listed.headers["cache-control"], "no-store");
});

test("rejeita identificadores de escopo em payloads e consultas", async (t) => {
  const context = await fixture(t);
  await context.activate();
  for (const field of ["profileId", "householdId"]) {
    const forged = { [field]: "f014755e-04f8-4eb6-a13f-a3fca0f68619" };
    const invalidRequests = [
      { ...requests[1]!, payload: { ...movie, ...forged } },
      { ...requests[2]!, payload: { items: [movie], ...forged } },
      { ...requests[2]!, payload: { items: [{ ...movie, ...forged }] } },
      { ...requests[0]!, url: `/v1/library?${field}=${forged[field]}` }
    ];
    for (const request of invalidRequests) {
      const response = await context.app.inject({ ...request, headers: context.headers });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, "INVALID_REQUEST");
    }
  }
  const listed = await context.app.inject({ ...requests[0]!, headers: context.headers });
  assert.deepEqual(listed.json(), { items: [] });
});

test("importação repetida devolve a lista canônica incluindo itens já salvos", async (t) => {
  const context = await fixture(t);
  await context.activate();
  await context.app.inject({ ...requests[1]!, headers: context.headers });
  const imported = { ...movie, mediaId: "tt7654321", name: "Segundo filme" };
  let firstId: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await context.app.inject({
      ...requests[2]!, headers: context.headers, payload: { items: [imported, imported] }
    });
    assert.equal(response.statusCode, 200);
    const { items } = libraryResponseSchema.parse(response.json());
    assert.deepEqual(items.map((item) => item.mediaId).sort(), ["tt1234567", "tt7654321"]);
    const item = items.find((item) => item.mediaId === "tt7654321")!;
    if (firstId) assert.equal(item.id, firstId);
    firstId = item.id;
  }
});

test("importação aceita 200 e rejeita 201 itens sem gravação parcial", async (t) => {
  const context = await fixture(t);
  await context.activate();
  const items = Array.from({ length: 201 }, (_, index) => ({ ...movie, mediaId: `tt${index}` }));
  const rejected = await context.app.inject({
    ...requests[2]!, headers: context.headers, payload: { items }
  });
  assert.equal(rejected.statusCode, 400);
  const empty = await context.app.inject({ ...requests[0]!, headers: context.headers });
  assert.deepEqual(empty.json(), { items: [] });
  const accepted = await context.app.inject({
    ...requests[2]!, headers: context.headers, payload: { items: items.slice(0, 200) }
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(libraryResponseSchema.parse(accepted.json()).items.length, 200);
});

test("remoção usa tipo e ID, devolve 204 e informa item ausente", async (t) => {
  const context = await fixture(t);
  await context.activate();
  await context.app.inject({ ...requests[1]!, headers: context.headers });
  await context.app.inject({ ...requests[1]!, headers: context.headers, payload: { ...movie, mediaType: "series" } });
  const removed = await context.app.inject({ ...requests[3]!, headers: context.headers });
  assert.equal(removed.statusCode, 204);
  assert.equal(removed.body, "");
  const listed = await context.app.inject({ ...requests[0]!, headers: context.headers });
  assert.deepEqual(listed.json().items.map((item: { mediaType: string }) => item.mediaType), ["series"]);
  const missing = await context.app.inject({ ...requests[3]!, headers: context.headers });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, "LIBRARY_ITEM_NOT_FOUND");
});

test("perfis da mesma casa têm bibliotecas independentes", async (t) => {
  const context = await fixture(t);
  const { household, profile } = await context.activate();
  await context.app.inject({ ...requests[1]!, headers: context.headers });
  const other = await context.householdService.createProfile({ householdId: household.id, name: "Outro" });
  await context.authProvider.setActiveProfile(context.token, other.id);
  const listed = await context.app.inject({ ...requests[0]!, headers: context.headers });
  assert.deepEqual(listed.json(), { items: [] });
  const removed = await context.app.inject({ ...requests[3]!, headers: context.headers });
  assert.equal(removed.statusCode, 404);
  await context.app.inject({ ...requests[2]!, headers: context.headers, payload: { items: [{ ...movie, name: "Outro perfil" }] } });
  await context.authProvider.setActiveProfile(context.token, profile.id);
  const original = await context.app.inject({ ...requests[0]!, headers: context.headers });
  assert.equal(original.json().items[0].name, "Horizonte Azul");
});

test("perfil de outra casa na sessão não permite nenhuma operação", async (t) => {
  const context = await fixture(t);
  await context.activate();
  const otherHousehold = await context.householdService.createHousehold({
    ownerId: "036e3cea-f3ab-4431-a265-650faf2782b8", name: "Outra casa"
  });
  const profile = await context.householdService.createProfile({ householdId: otherHousehold.id, name: "Outro" });
  await context.authProvider.setActiveProfile(context.token, profile.id);
  for (const request of requests) {
    const response = await context.app.inject({ ...request, headers: context.headers });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "PROFILE_NOT_FOUND");
  }
});

test("mutações por cookie exigem Origin confiável e Bearer funciona no app nativo", async (t) => {
  const context = await fixture(t);
  await context.activate();
  for (const request of requests.slice(1)) {
    for (const origin of [undefined, "https://hostile.example", "https://localhost"]) {
      const response = await context.app.inject({
        ...request, headers: { cookie: context.cookie, ...(origin ? { origin } : {}) }
      });
      assert.equal(response.statusCode, 403);
    }
  }
  for (const request of requests.slice(1)) {
    const response = await context.app.inject({
      ...request, headers: { authorization: `Bearer ${context.token}`, origin: "https://localhost" }
    });
    assert.equal(response.statusCode, request.method === "DELETE" ? 204 : 200);
    assert.equal(response.headers["access-control-allow-origin"], "https://localhost");
    assert.equal(response.headers["access-control-allow-credentials"], undefined);
  }
  const noOrigin = await context.app.inject({
    ...requests[1]!, headers: { authorization: `Bearer ${context.token}` }
  });
  assert.equal(noOrigin.statusCode, 200);
});

test("valida URLs e parâmetros de remoção antes de alterar a biblioteca", async (t) => {
  const context = await fixture(t);
  await context.activate();
  for (const request of [
    { ...requests[1]!, payload: { ...movie, posterUrl: "http://images.example/poster.jpg" } },
    { ...requests[3]!, url: "/v1/library/documentary/tt1234567" },
    { ...requests[3]!, url: "/v1/library/movie/%00" }
  ]) {
    const response = await context.app.inject({ ...request, headers: context.headers });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "INVALID_REQUEST");
  }
});

test("um ID de 255 caracteres aceito na biblioteca também pode ser removido", async (t) => {
  const context = await fixture(t);
  await context.activate();
  const mediaId = "a".repeat(255);
  const saved = await context.app.inject({
    ...requests[1]!, headers: context.headers, payload: { ...movie, mediaId }
  });
  assert.equal(saved.statusCode, 200);
  const removed = await context.app.inject({
    ...requests[3]!, headers: context.headers, url: `/v1/library/movie/${mediaId}`
  });
  assert.equal(removed.statusCode, 204);
});

test("teto de 500 mantém respostas canônicas e recusa excedentes antes de gravar", async (t) => {
  const context = await fixture(t);
  await context.activate();
  const items = Array.from({ length: 499 }, (_, index) => ({ ...movie, mediaId: `item-${index}` }));
  for (let offset = 0; offset < items.length; offset += 200) {
    const response = await context.app.inject({
      ...requests[2]!, headers: context.headers, payload: { items: items.slice(offset, offset + 200) }
    });
    assert.equal(response.statusCode, 200);
  }
  const before = await context.app.inject({ ...requests[0]!, headers: context.headers });
  const rejectedImport = await context.app.inject({
    ...requests[2]!, headers: context.headers,
    payload: { items: [
      { ...movie, mediaId: "item-0", name: "Não deve atualizar" },
      { ...movie, mediaId: "item-499" },
      { ...movie, mediaId: "item-500" }
    ] }
  });
  assert.equal(rejectedImport.statusCode, 400);
  assert.equal(rejectedImport.json().error.code, "INVALID_REQUEST");
  const unchanged = await context.app.inject({ ...requests[0]!, headers: context.headers });
  assert.equal(unchanged.statusCode, 200);
  assert.deepEqual(unchanged.json(), before.json());
  const accepted = await context.app.inject({
    ...requests[2]!, headers: context.headers,
    payload: { items: [{ ...movie, mediaId: "item-499" }] }
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(libraryResponseSchema.parse(accepted.json()).items.length, 500);
  const rejectedUpsert = await context.app.inject({
    ...requests[1]!, headers: context.headers, payload: { ...movie, mediaId: "item-500" }
  });
  assert.equal(rejectedUpsert.statusCode, 400);
  const updated = await context.app.inject({
    ...requests[1]!, headers: context.headers,
    payload: { ...movie, mediaId: "item-0", name: "Atualizado no teto" }
  });
  assert.equal(updated.statusCode, 200);
  const listed = await context.app.inject({ ...requests[0]!, headers: context.headers });
  assert.equal(listed.statusCode, 200);
  const canonical = libraryResponseSchema.parse(listed.json());
  assert.equal(canonical.items.length, 500);
  assert.equal(canonical.items.find((item) => item.mediaId === "item-0")!.name, "Atualizado no teto");
  assert.equal(canonical.items.some((item) => item.mediaId === "item-500"), false);
});
