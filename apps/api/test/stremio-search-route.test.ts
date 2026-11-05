import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { InMemoryAuthProvider } from "../src/auth/index.js";
import { HouseholdService, InMemoryHouseholdRepository } from "../src/households/index.js";
import {
  StremioAddonGateway,
  StremioApiClient,
  StremioService,
  type SaveStremioConnection,
  type StremioConnectionRepository
} from "../src/stremio/index.js";

const webOrigin = "http://localhost:3000";

/**
 * O `transportUrl` embute o `householdId` de propósito: o gateway mantém, por conta própria, um
 * cache curto por URL de add-on (ver `#cachedJson` em gateway.ts). Sem essa diferença as duas
 * casas do teste de isolamento bateriam na mesma URL e o teste não distinguiria "cache da rota
 * não compartilha entre casas" de "cache do gateway respondeu sem tocar a rede".
 */
function connectionRepository(): StremioConnectionRepository {
  return {
    async save(_record: SaveStremioConnection) {},
    async find(householdId) {
      return {
        householdId,
        authKey: "stremio-auth-key",
        syncedAt: new Date("2026-09-27T00:00:00.000Z"),
        addons: [{
          manifest: {
            id: "org.example.busca",
            version: "1.0.0",
            name: "Catálogo de busca",
            resources: ["catalog", "meta"],
            types: ["movie", "series"],
            catalogs: [
              { id: "populares", type: "movie", name: "Populares", extra: [{ name: "search", isRequired: true }] }
            ]
          },
          transportUrl: `https://busca.example/${householdId}/manifest.json`
        }]
      };
    },
    async status() { return { addonCount: 1, syncedAt: new Date("2026-09-27T00:00:00.000Z") }; },
    async delete() {}
  };
}

async function login(app: Awaited<ReturnType<typeof buildApp>>, email: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: { origin: webOrigin },
    payload: { email, password: "correct-secret" }
  });
  assert.equal(response.statusCode, 200);
  return String(response.headers["set-cookie"]).split(";", 1)[0]!;
}

test("GET /v1/stremio/search não reconsulta o add-on para a mesma casa e consulta equivalente", async (t) => {
  let gatewayCalls = 0;
  const authProvider = new InMemoryAuthProvider({
    users: [{ id: "user-a", email: "lucas@example.com", password: "correct-secret" }],
    tokenFactory: () => "search-cache-session"
  });
  const app = await buildApp({
    NODE_ENV: "test",
    CEBOLA_API_HOST: "127.0.0.1",
    CEBOLA_API_PORT: 3001,
    CEBOLA_WEB_ORIGIN: webOrigin,
    CEBOLA_SESSION_TTL_SECONDS: 3_600
  }, {
    authProvider,
    householdRepository: new InMemoryHouseholdRepository(),
    householdService: new HouseholdService({ repository: new InMemoryHouseholdRepository() }),
    stremioService: new StremioService({ api: new StremioApiClient(), repository: connectionRepository() }),
    stremioGateway: new StremioAddonGateway({
      fetchJson: async () => {
        gatewayCalls += 1;
        return { metas: [{ id: "tt-duna", type: "movie", name: "Duna" }] };
      }
    })
  });
  t.after(() => app.close());
  const cookie = await login(app, "lucas@example.com");

  const first = await app.inject({ method: "GET", url: "/v1/stremio/search?q=duna", headers: { cookie } });
  assert.equal(first.statusCode, 200);
  assert.equal(gatewayCalls, 1);

  // Mesma consulta, digitada com espaços e caixa diferentes: continua sendo a mesma pergunta.
  const second = await app.inject({ method: "GET", url: `/v1/stremio/search?q=${encodeURIComponent("  Duna  ")}`, headers: { cookie } });
  assert.equal(second.statusCode, 200);
  assert.equal(gatewayCalls, 1, "consulta equivalente não deveria reconsultar o add-on");
  assert.deepEqual(JSON.parse(second.body), JSON.parse(first.body));

  const different = await app.inject({ method: "GET", url: "/v1/stremio/search?q=arrival", headers: { cookie } });
  assert.equal(different.statusCode, 200);
  assert.equal(gatewayCalls, 2, "consulta diferente deve ir ao add-on");
});

test("GET /v1/stremio/search não compartilha cache entre casas diferentes", async (t) => {
  let gatewayCalls = 0;
  let nextToken = 0;
  const authProvider = new InMemoryAuthProvider({
    users: [
      { id: "user-a", email: "casa-a@example.com", password: "correct-secret" },
      { id: "user-b", email: "casa-b@example.com", password: "correct-secret" }
    ],
    tokenFactory: () => `session-${nextToken++}`
  });
  const app = await buildApp({
    NODE_ENV: "test",
    CEBOLA_API_HOST: "127.0.0.1",
    CEBOLA_API_PORT: 3001,
    CEBOLA_WEB_ORIGIN: webOrigin,
    CEBOLA_SESSION_TTL_SECONDS: 3_600
  }, {
    authProvider,
    householdRepository: new InMemoryHouseholdRepository(),
    householdService: new HouseholdService({ repository: new InMemoryHouseholdRepository() }),
    stremioService: new StremioService({ api: new StremioApiClient(), repository: connectionRepository() }),
    stremioGateway: new StremioAddonGateway({
      fetchJson: async () => {
        gatewayCalls += 1;
        return { metas: [{ id: "tt-duna", type: "movie", name: "Duna" }] };
      }
    })
  });
  t.after(() => app.close());
  const cookieA = await login(app, "casa-a@example.com");
  const cookieB = await login(app, "casa-b@example.com");

  const first = await app.inject({ method: "GET", url: "/v1/stremio/search?q=duna", headers: { cookie: cookieA } });
  assert.equal(first.statusCode, 200);
  assert.equal(gatewayCalls, 1);

  const second = await app.inject({ method: "GET", url: "/v1/stremio/search?q=duna", headers: { cookie: cookieB } });
  assert.equal(second.statusCode, 200);
  assert.equal(gatewayCalls, 2, "casa diferente não deve reaproveitar o cache da primeira");
});
