import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { InMemoryAuthProvider } from "../src/auth/index.js";
import { HouseholdService, InMemoryHouseholdRepository } from "../src/households/index.js";
import {
  StremioAddonGateway, StremioApiClient, StremioService, SkipTimesClient,
  type SaveStremioConnection, type StremioConnectionRepository
} from "../src/stremio/index.js";

async function appWithSkipTimes(skipTimes?: SkipTimesClient) {
  const repository: StremioConnectionRepository = {
    async save(_record: SaveStremioConnection) {},
    async find(householdId) { return { householdId, authKey: "stremio-token", syncedAt: new Date(), addons: [] }; },
    async status() { return { addonCount: 0, syncedAt: new Date() }; },
    async delete() {}
  };
  const app = await buildApp({
    NODE_ENV: "test", CEBOLA_API_HOST: "127.0.0.1", CEBOLA_API_PORT: 3001,
    CEBOLA_WEB_ORIGIN: "http://localhost:3000", CEBOLA_SESSION_TTL_SECONDS: 3600
  }, {
    authProvider: new InMemoryAuthProvider({
      users: [{ id: "user-a", email: "lucas@example.com", password: "correct-secret" }],
      tokenFactory: () => "skip-times-route-session"
    }),
    householdRepository: new InMemoryHouseholdRepository(),
    householdService: new HouseholdService({ repository: new InMemoryHouseholdRepository() }),
    stremioService: new StremioService({ api: new StremioApiClient(), repository }),
    stremioGateway: new StremioAddonGateway(),
    ...(skipTimes ? { skipTimes } : {})
  });
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin: "http://localhost:3000" },
    payload: { email: "lucas@example.com", password: "correct-secret" } });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  return { app, cookie };
}

test("rota de skip-times devolve os segmentos resolvidos por temporada", async () => {
  const skipTimes = new SkipTimesClient({
    fetchJson: async (url) => {
      if (url.includes("arm.haglund.dev")) {
        return [{ myanimelist: 222, "thetvdb-season": 2, "themoviedb-season": 2 }];
      }
      return { found: true, results: [
        { skipType: "op", interval: { startTime: 3, endTime: 93 }, episodeLength: 1430 }
      ] };
    }
  });
  const { app, cookie } = await appWithSkipTimes(skipTimes);
  try {
    const response = await app.inject({
      method: "GET", url: "/v1/stremio/skip-times/series/tt5626028%3A2%3A5", headers: { cookie }
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), {
      segments: [{ kind: "intro", start: 3, end: 93, episodeLength: 1430 }]
    });
  } finally {
    await app.close();
  }
});

test("rota de skip-times aceita ?absolute= para numeração absoluta", async () => {
  const requested: string[] = [];
  const skipTimes = new SkipTimesClient({
    fetchJson: async (url) => {
      requested.push(url);
      if (url.includes("arm.haglund.dev")) {
        return [{ myanimelist: 21, "thetvdb-season": null, "themoviedb-season": null }];
      }
      return { found: true, results: [
        { skipType: "recap", interval: { startTime: 0, endTime: 60 }, episodeLength: 1400 }
      ] };
    }
  });
  const { app, cookie } = await appWithSkipTimes(skipTimes);
  try {
    const response = await app.inject({
      method: "GET", url: "/v1/stremio/skip-times/series/tt0388629%3A21%3A1043?absolute=1043", headers: { cookie }
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), {
      segments: [{ kind: "recap", start: 0, end: 60, episodeLength: 1400 }]
    });
    assert.ok(requested.some((url) => url.includes("/skip-times/21/1043")));
  } finally {
    await app.close();
  }
});

test("filme sempre devolve segments vazio, mesmo com skipTimes configurado", async () => {
  let called = false;
  const skipTimes = new SkipTimesClient({ fetchJson: async () => { called = true; return []; } });
  const { app, cookie } = await appWithSkipTimes(skipTimes);
  try {
    const response = await app.inject({
      method: "GET", url: "/v1/stremio/skip-times/movie/tt1375666", headers: { cookie }
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), { segments: [] });
    assert.equal(called, false);
  } finally {
    await app.close();
  }
});

test("falha externa nunca vira 5xx: a rota devolve segments vazio com 200", async () => {
  const skipTimes = new SkipTimesClient({
    fetchJson: async () => { throw new Error("upstream indisponível"); }
  });
  const { app, cookie } = await appWithSkipTimes(skipTimes);
  try {
    const response = await app.inject({
      method: "GET", url: "/v1/stremio/skip-times/series/tt0388629%3A21%3A1043?absolute=1043", headers: { cookie }
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), { segments: [] });
  } finally {
    await app.close();
  }
});

test("sem SkipTimesClient configurado, a rota continua respondendo segments vazio", async () => {
  const { app, cookie } = await appWithSkipTimes(undefined);
  try {
    const response = await app.inject({
      method: "GET", url: "/v1/stremio/skip-times/series/tt5626028%3A2%3A5", headers: { cookie }
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), { segments: [] });
  } finally {
    await app.close();
  }
});

test("valida os parâmetros: absolute fora da faixa é 400", async () => {
  const { app, cookie } = await appWithSkipTimes(new SkipTimesClient({ fetchJson: async () => [] }));
  try {
    const response = await app.inject({
      method: "GET", url: "/v1/stremio/skip-times/series/tt5626028%3A2%3A5?absolute=0", headers: { cookie }
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
  }
});
