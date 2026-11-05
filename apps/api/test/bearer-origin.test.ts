import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { InMemoryAuthProvider } from "../src/auth/index.js";
import { HouseholdService, InMemoryHouseholdRepository } from "../src/households/index.js";
import type { ProfilePinService } from "../src/profiles/index.js";
import {
  InMemoryWatchProgressRepository,
  WatchProgressService
} from "../src/progress/index.js";
import {
  StremioAddonGateway,
  StremioApiClient,
  StremioService,
  type SaveStremioConnection,
  type StremioConnectionRepository
} from "../src/stremio/index.js";

const webOrigin = "http://localhost:3000";
const environment = {
  NODE_ENV: "test" as const,
  CEBOLA_API_HOST: "127.0.0.1",
  CEBOLA_API_PORT: 3001,
  CEBOLA_WEB_ORIGIN: webOrigin,
  CEBOLA_SESSION_TTL_SECONDS: 3_600
};

function provider() {
  return new InMemoryAuthProvider({
    users: [{ id: "user-1", email: "lucas@example.com", password: "correct-secret" }],
    sessionTtlMs: 60_000,
    tokenFactory: () => "opaque-cebola-session"
  });
}

/**
 * As rotas Stremio só são registradas quando authProvider, householdService, stremioService e
 * stremioGateway existem — passar só o authProvider devolveria 404 e faria o teste afirmar nada.
 * O resolve não consulta add-ons, então um repositório que devolve null basta.
 */
async function autenticado() {
  const repositorioVazio: StremioConnectionRepository = {
    async save(_record: SaveStremioConnection) {},
    async find() { return null; }
  };
  const app = await buildApp(environment, {
    authProvider: provider(),
    householdService: new HouseholdService({ repository: new InMemoryHouseholdRepository() }),
    stremioService: new StremioService({
      api: new StremioApiClient(),
      repository: repositorioVazio
    }),
    stremioGateway: new StremioAddonGateway()
  });
  await app.inject({
    method: "POST",
    url: "/v1/auth/device/login",
    payload: { email: "lucas@example.com", password: "correct-secret" }
  });
  return app;
}

// CSRF é ataque de navegador: o navegador anexa cookie sozinho, mas nunca anexa Authorization.
// Exigir Origin de quem chegou por Bearer só recusaria o app sem proteger ninguém.
test("Bearer sem Origin passa pela porta que o cookie precisa de Origin para atravessar", async () => {
  const app = await autenticado();
  const resposta = await app.inject({
    method: "POST",
    url: "/v1/stremio/streams/resolve",
    headers: { authorization: "Bearer opaque-cebola-session" },
    payload: { infoHash: "a".repeat(40), fileIdx: null }
  });
  // Sem Real-Debrid configurado, o handler chega em NOT_CONFIGURED e responde 503. Afirmar o
  // 503 (e não só "diferente de 403") é o que garante que a requisição atravessou a porta.
  assert.equal(resposta.statusCode, 503);
  await app.close();
});

test("cookie sem Origin continua sendo recusado", async () => {
  const app = await autenticado();
  const resposta = await app.inject({
    method: "POST",
    url: "/v1/stremio/streams/resolve",
    headers: { cookie: "__Host-cebola_session=opaque-cebola-session" },
    payload: { infoHash: "a".repeat(40), fileIdx: null }
  });
  assert.equal(resposta.statusCode, 403);
  assert.match(resposta.body, /UNTRUSTED_ORIGIN/);
  await app.close();
});

/**
 * As três rotas abaixo ficaram de fora da regra por descuido de cópia (havia quatro cópias da
 * checagem de Origin), e o efeito medido era a fase 0a não cumprir o próprio objetivo: o app
 * autenticava, tocava vídeo, e não conseguia escolher perfil nem gravar onde parou.
 */
class FakePinService implements ProfilePinService {
  async hashPin(): Promise<string> {
    return "$argon2id$v=19$m=19456,t=2,p=1$c2FsdC1mb3ItdGVzdA$ZGlnZXN0LWZvci10ZXN0LXB1cnBvc2Vz";
  }

  async verifyPin(): Promise<boolean> {
    return false;
  }
}

async function casaCompleta() {
  let emitidos = 0;
  const householdRepository = new InMemoryHouseholdRepository();
  const householdService = new HouseholdService({ repository: householdRepository });
  const app = await buildApp(environment, {
    authProvider: new InMemoryAuthProvider({
      users: [{ id: "user-1", email: "lucas@example.com", password: "correct-secret" }],
      sessionTtlMs: 60_000,
      // Contador em vez de token fixo: cookie e Bearer precisam ser sessões distintas para o
      // teste provar transporte, e não coincidência de token.
      tokenFactory: () => `sessao-${(emitidos += 1)}`
    }),
    householdRepository,
    householdService,
    pinService: new FakePinService(),
    progressService: new WatchProgressService({
      repository: new InMemoryWatchProgressRepository(),
      households: householdRepository,
      now: () => new Date("2026-08-24T03:00:00.000Z")
    })
  });

  const porToken = await app.inject({
    method: "POST",
    url: "/v1/auth/device/login",
    payload: { email: "lucas@example.com", password: "correct-secret" }
  });
  const porCookie = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: { origin: webOrigin },
    payload: { email: "lucas@example.com", password: "correct-secret" }
  });
  return {
    app,
    bearer: `Bearer ${JSON.parse(porToken.body).token as string}`,
    cookie: String(porCookie.headers["set-cookie"]).split(";", 1)[0]!
  };
}

const episodio = {
  addonId: "community.cinemeta",
  mediaId: "tt1234567",
  videoId: "tt1234567:1:4",
  mediaType: "series",
  title: "Horizonte Azul",
  positionSeconds: 1_080,
  durationSeconds: 2_700
};

test("cliente nativo cria perfil, ativa e grava progresso sem nenhuma Origin", async () => {
  const { app, bearer } = await casaCompleta();

  const criado = await app.inject({
    method: "POST",
    url: "/v1/profiles",
    headers: { authorization: bearer },
    payload: { name: "Lucas" }
  });
  assert.equal(criado.statusCode, 201);

  const ativado = await app.inject({
    method: "POST",
    url: `/v1/profiles/${JSON.parse(criado.body).id as string}/activate`,
    headers: { authorization: bearer },
    payload: {}
  });
  assert.equal(ativado.statusCode, 204);

  // Sem a ativação acima, esta chamada seria 409 ACTIVE_PROFILE_REQUIRED sem saída nenhuma:
  // era esse o beco em que o app ficava preso.
  const gravado = await app.inject({
    method: "PUT",
    url: "/v1/progress",
    headers: { authorization: bearer },
    payload: episodio
  });
  assert.equal(gravado.statusCode, 200);

  await app.close();
});

test("as mesmas três rotas continuam recusando cookie sem Origin", async () => {
  const { app, cookie } = await casaCompleta();

  const criar = await app.inject({
    method: "POST",
    url: "/v1/profiles",
    headers: { cookie },
    payload: { name: "Lucas" }
  });
  assert.equal(criar.statusCode, 403);
  assert.match(criar.body, /UNTRUSTED_ORIGIN/);

  const ativar = await app.inject({
    method: "POST",
    url: "/v1/profiles/26bd6155-a16d-445c-84de-20db3b0cd65f/activate",
    headers: { cookie },
    payload: {}
  });
  assert.equal(ativar.statusCode, 403);
  assert.match(ativar.body, /UNTRUSTED_ORIGIN/);

  const gravar = await app.inject({
    method: "PUT",
    url: "/v1/progress",
    headers: { cookie },
    payload: episodio
  });
  assert.equal(gravar.statusCode, 403);
  assert.match(gravar.body, /UNTRUSTED_ORIGIN/);

  await app.close();
});
