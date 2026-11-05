import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { InMemoryAuthProvider } from "../src/auth/index.js";
import { HouseholdService, InMemoryHouseholdRepository } from "../src/households/index.js";
import {
  RealDebridClient,
  RealDebridMediaRelay,
  StremioAddonGateway,
  StremioApiClient,
  StremioService,
  type SaveStremioConnection,
  type StremioConnectionRepository
} from "../src/stremio/index.js";

const webOrigin = "http://localhost:3000";
// Mesmo valor usado no payload de ambas as chamadas de resolve abaixo: o dublê de
// "/torrents?limit=100" só acha o torrent pronto se o hash bater com o que foi pedido.
const hash = "a".repeat(40);

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

// Montagem copiada de stremio-media-route.test.ts (linhas 26-105), com três mudanças: o token
// fixo do provider, o link legível devolvido pelo dublê do Real-Debrid, e um mediaRelay que não
// precisa responder nada — este teste só compara a URL que o resolve devolveu.
async function montarApp() {
  const authProvider = new InMemoryAuthProvider({
    users: [{ id: "user-a", email: "lucas@example.com", password: "correct-secret" }],
    tokenFactory: () => "sessao-de-teste"
  });
  const households = new HouseholdService({ repository: new InMemoryHouseholdRepository() });
  const emptyRepository: StremioConnectionRepository = {
    async save(_record: SaveStremioConnection) {},
    async find(householdId) {
      return {
        householdId,
        authKey: "stremio-auth-key",
        syncedAt: new Date("2026-08-19T00:00:00.000Z"),
        addons: [{
          manifest: {
            id: "com.stremio.torrentio.addon",
            version: "1.0.0",
            name: "Torrentio RD",
            resources: ["stream"],
            types: ["movie", "series"],
            catalogs: []
          },
          transportUrl: "https://torrentio.strem.fun/realdebrid=private-test-token/manifest.json"
        }]
      };
    },
    async status() { return { addonCount: 1, syncedAt: new Date("2026-08-19T00:00:00.000Z") }; },
    async delete() {}
  };
  const realDebrid = new RealDebridClient({
    token: "private-token-with-enough-characters",
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/torrents?limit=100")) return json([{ id: "torrent-1", hash }]);
      if (url.endsWith("/torrents/info/torrent-1")) {
        return json({
          id: "torrent-1",
          hash,
          status: "downloaded",
          progress: 100,
          links: ["https://1.1.1.1/restricted"]
        });
      }
      if (url.endsWith("/unrestrict/link")) {
        // IP literal, não hostname: resolveTorrent valida o host público via DNS de verdade
        // (validatePublicMediaUrl), e "rd.example" (RFC 2606) nunca resolve — quebraria o teste
        // por um motivo alheio ao que ele verifica. O restante da suíte usa o mesmo truque.
        return json({ download: "https://1.0.0.1/arquivo.mkv" });
      }
      throw new Error("unexpected Real-Debrid request");
    }
  });
  const mediaRelay = new RealDebridMediaRelay({
    fetch: async () => {
      throw new Error("mediaRelay não deveria ser buscado neste teste");
    }
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
    householdService: households,
    stremioService: new StremioService({ api: new StremioApiClient(), repository: emptyRepository }),
    stremioGateway: new StremioAddonGateway(),
    realDebrid,
    realDebridMediaRelay: mediaRelay
  });

  return app;
}

test("cliente nativo recebe o link do Real-Debrid; navegador recebe o ticket de repasse", async () => {
  const app = await montarApp(); // mesma montagem de stremio-media-route.test.ts

  const porSenha = await app.inject({
    method: "POST",
    url: "/v1/auth/device/login",
    payload: { email: "lucas@example.com", password: "correct-secret" }
  });
  const tokenDeAparelho = JSON.parse(porSenha.body).token as string;
  // O provider em memória devolve o mesmo token para as duas vias; o que muda é o transporte.
  const tokenDeCookie = tokenDeAparelho;

  const nativo = await app.inject({
    method: "POST",
    url: "/v1/stremio/streams/resolve",
    headers: { authorization: `Bearer ${tokenDeAparelho}` },
    payload: { infoHash: "a".repeat(40), fileIdx: null }
  });
  assert.equal(nativo.statusCode, 200);
  // A VM de 1 OCPU não repassa 4K para vários aparelhos, e o avanço rápido sofre no repasse.
  assert.equal(JSON.parse(nativo.body).url, "https://1.0.0.1/arquivo.mkv");

  const navegador = await app.inject({
    method: "POST",
    url: "/v1/stremio/streams/resolve",
    headers: { origin: webOrigin, cookie: `__Host-cebola_session=${tokenDeCookie}` },
    payload: { infoHash: "a".repeat(40), fileIdx: null }
  });
  assert.equal(navegador.statusCode, 200);
  // No navegador o link apareceria nas ferramentas de desenvolvedor.
  assert.match(JSON.parse(navegador.body).url, /\/v1\/stremio\/streams\/media\//);
  assert.doesNotMatch(navegador.body, /1\.0\.0\.1/);

  await app.close();
});
