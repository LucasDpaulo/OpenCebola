import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { InMemoryAuthProvider } from "../src/auth/index.js";
import { HouseholdService, InMemoryHouseholdRepository } from "../src/households/index.js";
import type { TmdbClient } from "../src/editorial/index.js";

const webOrigin = "http://localhost:3000";
const userId = "3c0a1f52-7d84-4a19-9b0c-2e5f8d61a7b3";
const environment = {
  NODE_ENV: "test" as const,
  CEBOLA_API_HOST: "127.0.0.1",
  CEBOLA_API_PORT: 3001,
  CEBOLA_WEB_ORIGIN: webOrigin,
  CEBOLA_SESSION_TTL_SECONDS: 3_600
};

const homeResponse = {
  generatedAt: "2026-08-31T12:00:00.000Z",
  rails: [{
    id: "home-trending",
    title: "Em alta",
    provider: null,
    items: [{
      tmdbId: 42,
      type: "movie" as const,
      title: "Um filme",
      year: 2026,
      overview: null,
      posterUrl: null,
      backdropUrl: null,
      voteAverage: null
    }]
  }],
  attribution: { tmdbNotice: "Dados fornecidos pelo TMDB." }
};

/** Só as portas que as rotas atravessam: o que está sob teste é o cabeçalho, não o TMDB. */
const tmdbDeMentira = {
  async home() { return homeResponse; },
  async dailyFeatured() {
    return {
      id: "movie-42",
      title: "Destaque",
      subtitle: "O destaque de hoje.",
      backdropUrl: "https://image.tmdb.org/t/p/w1280/a.jpg",
      backdropPreviewUrl: "https://image.tmdb.org/t/p/w780/a.jpg",
      posterUrl: null,
      trailerKey: null
    };
  }
} as unknown as TmdbClient;

async function fixture() {
  const authProvider = new InMemoryAuthProvider({
    users: [{ id: userId, email: "lucas@example.com", password: "correct-secret" }],
    tokenFactory: () => "sessao-de-cache"
  });
  const householdRepository = new InMemoryHouseholdRepository();
  const householdService = new HouseholdService({ repository: householdRepository });
  await householdService.createHousehold({ ownerId: userId, name: "Casa" });
  const { sessionToken } = await authProvider.signInWithPassword({
    email: "lucas@example.com",
    password: "correct-secret"
  });
  const app = await buildApp(environment, {
    authProvider,
    householdRepository,
    householdService,
    tmdb: tmdbDeMentira
  });
  return { app, sessionToken };
}

// O servidor já guardava a seleção 6 h em memória e mandava a resposta sem nenhuma instrução
// de cache: o aparelho perguntava de novo a cada abertura para receber byte por byte o mesmo
// corpo. `private` porque a rota é autenticada — nada disso pode parar num cache compartilhado.
test("a seleção editorial da home autoriza cache privado no aparelho", async () => {
  const { app, sessionToken } = await fixture();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/editorial/home?section=home",
      headers: { origin: webOrigin, authorization: `Bearer ${sessionToken}` }
    });

    assert.equal(response.statusCode, 200);
    const cacheControl = response.headers["cache-control"];
    assert.match(String(cacheControl), /private/);
    assert.match(String(cacheControl), /max-age=\d+/);
  } finally {
    await app.close();
  }
});

test("o destaque diário também autoriza cache privado", async () => {
  const { app, sessionToken } = await fixture();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/editorial/daily-featured",
      headers: { origin: webOrigin, authorization: `Bearer ${sessionToken}` }
    });

    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["cache-control"]), /private/);
  } finally {
    await app.close();
  }
});

// A garantia que impede o cabeçalho de virar um vazamento: resposta de erro nunca é guardada.
test("erro editorial não autoriza cache", async () => {
  const { app } = await fixture();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/editorial/home?section=secao-que-nao-existe",
      headers: { origin: webOrigin }
    });

    assert.equal(response.statusCode, 400);
    assert.doesNotMatch(String(response.headers["cache-control"] ?? ""), /max-age=[1-9]/);
  } finally {
    await app.close();
  }
});

test("resposta sem sessão não autoriza cache", async () => {
  const { app } = await fixture();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/editorial/home?section=home",
      headers: { origin: webOrigin }
    });

    assert.equal(response.statusCode, 401);
    assert.doesNotMatch(String(response.headers["cache-control"] ?? ""), /max-age=[1-9]/);
  } finally {
    await app.close();
  }
});

// O padrão continua sendo não guardar nada: só quem declara o próprio cache escapa dele.
test("rota que não declara cache continua com no-store", async () => {
  const { app } = await fixture();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { origin: webOrigin }
    });

    assert.equal(String(response.headers["cache-control"]), "no-store");
  } finally {
    await app.close();
  }
});

/**
 * A regressão que este teste tranca.
 *
 * A primeira versão desta mudança fez o hook global respeitar qualquer `Cache-Control` que a
 * rota tivesse escrito. Só que duas rotas de legenda em `stremio/routes.ts` já escreviam
 * `private, max-age=3600` desde sempre, e o hook vinha apagando isso. Elas passaram a valer de
 * uma vez: legenda de sessão autenticada descansando 1 h no aparelho, servida a um `<track>`
 * que não reautentica e sobrevivendo ao logout. Nada disso estava no escopo pretendido.
 *
 * Agora só escapa do `no-store` quem DECLARA a intenção na configuração da rota. Escrever o
 * cabeçalho à mão não basta.
 */
test("escrever Cache-Control à mão NÃO livra a rota do no-store", async () => {
  const { app } = await fixture();
  app.get("/rota-que-escreve-o-cabecalho", async (_request, reply) => {
    reply.header("cache-control", "private, max-age=3600");
    return reply.send({ ok: true });
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/rota-que-escreve-o-cabecalho",
      headers: { origin: webOrigin }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(String(response.headers["cache-control"]), "no-store");
  } finally {
    await app.close();
  }
});

test("rota que declara a intenção na configuração recebe o cache declarado", async () => {
  const { app } = await fixture();
  app.get("/rota-que-declara", {
    config: { cacheControl: "private, max-age=120" }
  }, async (_request, reply) => reply.send({ ok: true }));
  try {
    const response = await app.inject({
      method: "GET",
      url: "/rota-que-declara",
      headers: { origin: webOrigin }
    });

    assert.equal(String(response.headers["cache-control"]), "private, max-age=120");
  } finally {
    await app.close();
  }
});

test("rota que declara cache não guarda resposta de erro", async () => {
  const { app } = await fixture();
  app.get("/rota-que-declara-e-falha", {
    config: { cacheControl: "private, max-age=120" }
  }, async (_request, reply) => reply.code(503).send({ erro: true }));
  try {
    const response = await app.inject({
      method: "GET",
      url: "/rota-que-declara-e-falha",
      headers: { origin: webOrigin }
    });

    assert.equal(response.statusCode, 503);
    assert.equal(String(response.headers["cache-control"]), "no-store");
  } finally {
    await app.close();
  }
});

// O "+ Ver mais" pede a página seguinte por aqui. O teto protege a rota de virar raspador.
test("a rota da home aceita página e recusa além do teto", async () => {
  const { app, sessionToken } = await fixture();
  try {
    const ok = await app.inject({
      method: "GET",
      url: "/v1/editorial/home?section=home&page=4",
      headers: { origin: webOrigin, authorization: `Bearer ${sessionToken}` }
    });
    assert.equal(ok.statusCode, 200);

    const demais = await app.inject({
      method: "GET",
      url: "/v1/editorial/home?section=home&page=5",
      headers: { origin: webOrigin, authorization: `Bearer ${sessionToken}` }
    });
    assert.equal(demais.statusCode, 400);

    const zero = await app.inject({
      method: "GET",
      url: "/v1/editorial/home?section=home&page=0",
      headers: { origin: webOrigin, authorization: `Bearer ${sessionToken}` }
    });
    assert.equal(zero.statusCode, 400);
  } finally {
    await app.close();
  }
});
