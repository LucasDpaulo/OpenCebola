import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { InMemoryAuthProvider } from "../src/auth/index.js";
import { HouseholdService, InMemoryHouseholdRepository } from "../src/households/index.js";
import {
  RealDebridMediaRelay,
  StremioAddonGateway,
  StremioApiClient,
  StremioService,
  type SaveStremioConnection,
  type StremioConnectionRepository
} from "../src/stremio/index.js";

const webOrigin = "http://localhost:3000";
// IP literal pelo mesmo motivo de resolve-direct-link.test.ts: validatePublicMediaUrl
// resolve o host por DNS de verdade, e um domínio de exemplo nunca resolveria.
const linkDireto = "https://1.0.0.1/ja-esta-no-cache.mkv";

// Montagem irmã da de resolve-direct-link.test.ts. A diferença é o gateway: aqui ele devolve
// uma fonte `direct` — a `[RD+]`, que o Torrentio já entrega pronta e é a reprodução
// instantânea — para comparar o que cada procedência recebe.
async function montarApp() {
  const authProvider = new InMemoryAuthProvider({
    users: [{ id: "user-a", email: "lucas@example.com", password: "correct-secret" }],
    tokenFactory: () => "sessao-de-teste"
  });
  const repository: StremioConnectionRepository = {
    async save(_record: SaveStremioConnection) {},
    async find(householdId) {
      return {
        householdId,
        authKey: "stremio-auth-key",
        syncedAt: new Date("2026-08-19T00:00:00.000Z"),
        addons: [{
          manifest: {
            id: "org.community.exemplo",
            version: "1.0.0",
            name: "Add-on direto de exemplo",
            resources: ["stream"],
            types: ["movie", "series"],
            catalogs: []
          },
          transportUrl: "https://addon.example/manifest.json"
        }]
      };
    },
    async status() { return { addonCount: 1, syncedAt: new Date("2026-08-19T00:00:00.000Z") }; },
    async delete() {}
  };

  return buildApp({
    NODE_ENV: "test",
    CEBOLA_API_HOST: "127.0.0.1",
    CEBOLA_API_PORT: 3001,
    CEBOLA_WEB_ORIGIN: webOrigin,
    CEBOLA_SESSION_TTL_SECONDS: 3_600
  }, {
    authProvider,
    householdRepository: new InMemoryHouseholdRepository(),
    householdService: new HouseholdService({ repository: new InMemoryHouseholdRepository() }),
    stremioService: new StremioService({ api: new StremioApiClient(), repository }),
    stremioGateway: new StremioAddonGateway({
      fetchJson: async () => ({
        streams: [{ name: "Exemplo\n1080p", title: "Filme.2026.1080p.x264\n👤 900", url: linkDireto }]
      })
    }),
    realDebridMediaRelay: new RealDebridMediaRelay({
      fetch: async () => { throw new Error("mediaRelay não deveria ser buscado neste teste"); }
    })
  });
}

// Add-on neutro de propósito. O Torrentio RD e o Orion são `isBrowserOnlyAddon`: o servidor
// NUNCA os consulta, e por isso as fontes `[RD+]` não chegam a passar por relayDirectStreams —
// elas entram por /browser-streams/import, que já não repassa. Quem passa por aqui é qualquer
// outro add-on que devolva uma fonte `direct`, e é esse caminho que este teste fixa.
test("cliente nativo recebe a fonte direta; navegador recebe o ticket de repasse", async () => {
  const app = await montarApp();

  const porSenha = await app.inject({
    method: "POST",
    url: "/v1/auth/device/login",
    payload: { email: "lucas@example.com", password: "correct-secret" }
  });
  const token = JSON.parse(porSenha.body).token as string;

  const nativo = await app.inject({
    method: "GET",
    url: "/v1/stremio/streams/movie/tt1234567",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(nativo.statusCode, 200);
  assert.equal(JSON.parse(nativo.body).streams[0].url, linkDireto);

  const navegador = await app.inject({
    method: "GET",
    url: "/v1/stremio/streams/movie/tt1234567",
    headers: { origin: webOrigin, cookie: `__Host-cebola_session=${token}` }
  });
  assert.equal(navegador.statusCode, 200);
  assert.match(JSON.parse(navegador.body).streams[0].url, /\/v1\/stremio\/streams\/media\//);
  assert.doesNotMatch(navegador.body, /1\.0\.0\.1/);

  await app.close();
});
