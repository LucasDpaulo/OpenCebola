import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { InMemoryAuthProvider } from "../src/auth/index.js";
import { HouseholdService, InMemoryHouseholdRepository } from "../src/households/index.js";
import { StremioAddonGateway, StremioApiClient, StremioService, type StremioConnectionRepository } from "../src/stremio/index.js";

test("Torrentio instalado não exclui outros addons de streams, alvos e importação; Orion continua manual", async (t) => {
  const ids = ["com.stremio.torrentio.addon", "org.example.torrents", "org.community.orion"];
  const addons = ids.map((id, index) => ({
    manifest: { id, name: id, version: "1.0.0", resources: ["stream"], types: ["movie"], catalogs: [] },
    transportUrl: `https://1.1.1.1/${index}/manifest.json`
  }));
  const repository: StremioConnectionRepository = {
    async save() {}, async delete() {},
    async status() { return { addonCount: addons.length, syncedAt: new Date() }; },
    async find(householdId) { return { householdId, authKey: "test", syncedAt: new Date(), addons }; }
  };
  const calls: string[] = [];
  const torrent = { infoHash: "a".repeat(40), fileIdx: 2, title: "Vídeo de teste" };
  const app = await buildApp({ NODE_ENV: "test", CEBOLA_API_HOST: "127.0.0.1", CEBOLA_API_PORT: 3001,
    CEBOLA_WEB_ORIGIN: "http://localhost:3000", CEBOLA_SESSION_TTL_SECONDS: 3600 }, {
    authProvider: new InMemoryAuthProvider({ users: [{ id: "test", email: "test@example.com", password: "correct-secret" }], tokenFactory: () => "test-playback-session" }),
    householdRepository: new InMemoryHouseholdRepository(),
    householdService: new HouseholdService({ repository: new InMemoryHouseholdRepository() }),
    stremioService: new StremioService({ api: new StremioApiClient(), repository }),
    stremioGateway: new StremioAddonGateway({ fetchJson: async (url) => {
      calls.push(String(url));
      return { streams: String(url).includes("/1/") ? [torrent] : [] };
    } })
  });
  t.after(() => app.close());
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin: "http://localhost:3000" }, payload: { email: "test@example.com", password: "correct-secret" } });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const response = await app.inject({ method: "GET", url: "/v1/stremio/streams/movie/tt123", headers: { cookie } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().streams[0]?.addonId, ids[1]);
  assert.equal(response.json().streams[0]?.infoHash, torrent.infoHash);
  assert.equal(calls.length, 2, "Orion não deve consumir cota na busca automática");
  const targets = await app.inject({ method: "GET", url: "/v1/stremio/browser-stream-targets/movie/tt123", headers: { cookie } });
  assert.equal(targets.statusCode, 200);
  assert.deepEqual(targets.json().targets.map((target: { addonId: string }) => target.addonId), ids);
  const imported = await app.inject({ method: "POST", url: "/v1/stremio/browser-streams/import", headers: { cookie, origin: "http://localhost:3000" }, payload: { addonId: ids[1], payload: { streams: [torrent] } } });
  assert.equal(imported.statusCode, 200);
  assert.equal(imported.json().streams[0]?.kind, "torrent");
});
