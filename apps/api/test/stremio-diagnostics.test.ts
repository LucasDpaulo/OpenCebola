import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { InMemoryAuthProvider } from "../src/auth/index.js";
import { HouseholdService, InMemoryHouseholdRepository } from "../src/households/index.js";
import { DiagnosticsLog } from "../src/stremio/diagnostics-log.js";
import {
  RealDebridClient,
  RealDebridMediaRelay,
  StremioAddonGateway,
  clearTorrentIdCache,
  StremioApiClient,
  StremioService,
  type SaveStremioConnection,
  type StremioConnectionRepository
} from "../src/stremio/index.js";

const webOrigin = "http://localhost:3000";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function emptyStremioRepository(): StremioConnectionRepository {
  return {
    async save(_record: SaveStremioConnection) {},
    async find() { return null; },
    async status() { return null; },
    async delete() {}
  };
}

// ---------------------------------------------------------------------------
// Unidade: sanitização e forma do anel em memória (sem HTTP).
// ---------------------------------------------------------------------------

test("DiagnosticsLog troca URL http(s) por só o host, mesmo dentro de detail/message", () => {
  const log = new DiagnosticsLog({ now: () => new Date("2026-09-26T12:00:00.000Z") });
  log.record("casa-a", {
    origin: "servidor",
    code: "REAL_DEBRID_FILE_BLOCKED",
    message: "falhou ao abrir https://real-debrid.com/d/ABC?x=1 agora",
    detail: "GET https://real-debrid.com/d/ABC?x=1 -> 451"
  });
  const [entry] = log.list("casa-a");
  assert.equal(entry?.message, "falhou ao abrir real-debrid.com agora");
  assert.equal(entry?.detail, "GET real-debrid.com -> 451");
  assert.doesNotMatch(entry?.message ?? "", /ABC|x=1/);
});

test("DiagnosticsLog trunca cada campo no limite documentado", () => {
  const log = new DiagnosticsLog();
  log.record("casa-a", {
    origin: "aparelho",
    code: "X".repeat(100),
    message: "M".repeat(400),
    detail: "D".repeat(400),
    route: "/r".repeat(150),
    device: "tizen ".repeat(30),
    context: { ["k".repeat(80)]: "v".repeat(400) }
  });
  const [entry] = log.list("casa-a");
  assert.equal(entry?.code.length, 64);
  assert.equal(entry?.message.length, 300);
  assert.equal(entry?.detail?.length, 300);
  assert.equal(entry?.route?.length, 200);
  assert.ok((entry?.device?.length ?? 0) <= 120);
  const [[key, value] = []] = Object.entries(entry?.context ?? {});
  assert.ok((key?.length ?? 0) <= 40);
  assert.ok((value?.length ?? 0) <= 200);
});

test("DiagnosticsLog mantém no máximo as últimas 150 entradas por casa, mais recente primeiro", () => {
  const log = new DiagnosticsLog();
  for (let i = 0; i < 151; i += 1) {
    log.record("casa-a", { origin: "servidor", code: `CODE_${i}`, message: "" });
  }
  const entries = log.list("casa-a");
  assert.equal(entries.length, 150);
  assert.equal(entries[0]?.code, "CODE_150");
  assert.equal(entries.at(-1)?.code, "CODE_1");
});

test("DiagnosticsLog isola entradas por householdId", () => {
  const log = new DiagnosticsLog();
  log.record("casa-a", { origin: "servidor", code: "A_ONLY", message: "" });
  log.record("casa-b", { origin: "servidor", code: "B_ONLY", message: "" });
  assert.deepEqual(log.list("casa-a").map((e) => e.code), ["A_ONLY"]);
  assert.deepEqual(log.list("casa-b").map((e) => e.code), ["B_ONLY"]);
  log.clear("casa-a");
  assert.deepEqual(log.list("casa-a"), []);
  assert.deepEqual(log.list("casa-b").map((e) => e.code), ["B_ONLY"]);
});

test("DiagnosticsLog descarta a casa que ficou mais tempo sem escrever ao estourar 50 casas", () => {
  const log = new DiagnosticsLog();
  for (let i = 0; i < 50; i += 1) {
    log.record(`casa-${i}`, { origin: "servidor", code: "X", message: "" });
  }
  // Casa 0 escreve de novo e vira a mais recente; a próxima casa nova deve expulsar a casa 1,
  // não a casa 0.
  log.record("casa-0", { origin: "servidor", code: "Y", message: "" });
  log.record("casa-nova", { origin: "servidor", code: "Z", message: "" });
  assert.equal(log.list("casa-0").length, 2);
  assert.equal(log.list("casa-1").length, 0);
  assert.equal(log.list("casa-nova").length, 1);
});

// ---------------------------------------------------------------------------
// HTTP completo: rotas /v1/stremio/diagnostics.
// ---------------------------------------------------------------------------

async function loggedInApp(options: { adminPassword?: string } = {}) {
  const authProvider = new InMemoryAuthProvider({
    users: [
      { id: "user-a", email: "casa-a@example.com", password: "correct-secret-a" },
      { id: "user-b", email: "casa-b@example.com", password: "correct-secret-b" }
    ],
    tokenFactory: (() => {
      let n = 0;
      return () => `session-${n++}`;
    })()
  });
  const households = new HouseholdService({ repository: new InMemoryHouseholdRepository() });
  const app = await buildApp({
    NODE_ENV: "test",
    CEBOLA_API_HOST: "127.0.0.1",
    CEBOLA_API_PORT: 3001,
    CEBOLA_WEB_ORIGIN: webOrigin,
    CEBOLA_SESSION_TTL_SECONDS: 3_600,
    ...(options.adminPassword ? { CEBOLA_STREMIO_ADMIN_PASSWORD: options.adminPassword } : {})
  }, {
    authProvider,
    householdRepository: new InMemoryHouseholdRepository(),
    householdService: households,
    stremioService: new StremioService({ api: new StremioApiClient(), repository: emptyStremioRepository() }),
    stremioGateway: new StremioAddonGateway()
  });

  async function login(email: string, password: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { origin: webOrigin },
      payload: { email, password }
    });
    assert.equal(response.statusCode, 200);
    return String(response.headers["set-cookie"]).split(";", 1)[0]!;
  }

  return { app, login };
}

test("POST /v1/stremio/diagnostics grava, e GET devolve a entrada mais recente primeiro", async () => {
  const { app, login } = await loggedInApp();
  const cookie = await login("casa-a@example.com", "correct-secret-a");

  const posted = await app.inject({
    method: "POST",
    url: "/v1/stremio/diagnostics",
    headers: { origin: webOrigin, cookie },
    payload: { code: "BROWSER_MEDIA_ERROR", message: "vídeo travou", device: "tizen", context: { season: "1" } }
  });
  assert.equal(posted.statusCode, 204);

  const listed = await app.inject({
    method: "GET",
    url: "/v1/stremio/diagnostics",
    headers: { cookie }
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.headers["cache-control"], "private, no-store");
  const body = JSON.parse(listed.body) as { entries: { code: string; origin: string; device?: string }[] };
  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0]?.code, "BROWSER_MEDIA_ERROR");
  assert.equal(body.entries[0]?.origin, "aparelho");
  assert.equal(body.entries[0]?.device, "tizen");

  const cleared = await app.inject({
    method: "DELETE",
    url: "/v1/stremio/diagnostics",
    headers: { origin: webOrigin, cookie }
  });
  assert.equal(cleared.statusCode, 204);
  const afterClear = await app.inject({ method: "GET", url: "/v1/stremio/diagnostics", headers: { cookie } });
  assert.deepEqual(JSON.parse(afterClear.body).entries, []);
  await app.close();
});

test("GET /v1/stremio/diagnostics fica trancado com senha administrativa configurada e não destrancada", async () => {
  const { app, login } = await loggedInApp({ adminPassword: "senha-bem-longa" });
  const cookie = await login("casa-a@example.com", "correct-secret-a");

  const locked = await app.inject({
    method: "GET",
    url: "/v1/stremio/diagnostics",
    headers: { cookie }
  });
  assert.equal(locked.statusCode, 403);
  assert.equal(JSON.parse(locked.body).error.code, "STREMIO_ADMIN_LOCKED");

  const unlock = await app.inject({
    method: "POST",
    url: "/v1/stremio/admin",
    headers: { origin: webOrigin, cookie },
    payload: { password: "senha-bem-longa" }
  });
  assert.equal(unlock.statusCode, 200);

  const unlocked = await app.inject({
    method: "GET",
    url: "/v1/stremio/diagnostics",
    headers: { cookie }
  });
  assert.equal(unlocked.statusCode, 200);
  await app.close();
});

test("Real-Debrid INFRINGING_FILE em /streams/resolve vira entrada servidor com detail do error_code 35", async () => {
  const { app, login } = await loggedInApp();
  const cookie = await login("casa-a@example.com", "correct-secret-a");

  // O cache de torrentId por infoHash é de módulo (ver real-debrid.ts) e sobrevive entre
  // arquivos de teste; sem limpar, um hash já resolvido por outro teste pularia direto para
  // `/torrents/info/...`, que este mock não conhece.
  clearTorrentIdCache();
  const realDebrid = new RealDebridClient({
    token: "private-token-with-enough-characters",
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/torrents?limit=100")) return json([]);
      if (url.endsWith("/torrents/addMagnet")) {
        return json({ error_code: 35 }, 451);
      }
      throw new Error("unexpected Real-Debrid request");
    }
  });

  // Reconstrói o app só desta vez com o Real-Debrid mockado — o helper `loggedInApp` não aceita
  // dependência extra, e criar duas instâncias de app deixaria as duas casas em processos
  // diferentes; aqui basta reabrir com o mesmo authProvider/households não é possível, então o
  // teste refaz login contra um app novo com o mock plugado.
  await app.close();
  const authProvider = new InMemoryAuthProvider({
    users: [{ id: "user-a", email: "casa-a@example.com", password: "correct-secret-a" }],
    tokenFactory: () => "session-rd"
  });
  const households = new HouseholdService({ repository: new InMemoryHouseholdRepository() });
  const appComDebrid = await buildApp({
    NODE_ENV: "test",
    CEBOLA_API_HOST: "127.0.0.1",
    CEBOLA_API_PORT: 3001,
    CEBOLA_WEB_ORIGIN: webOrigin,
    CEBOLA_SESSION_TTL_SECONDS: 3_600
  }, {
    authProvider,
    householdRepository: new InMemoryHouseholdRepository(),
    householdService: households,
    stremioService: new StremioService({ api: new StremioApiClient(), repository: emptyStremioRepository() }),
    stremioGateway: new StremioAddonGateway(),
    realDebrid,
    // Sessão via cookie (não bearer) só resolve com o relay disponível — sem ele a rota nem
    // chega a consultar o Real-Debrid, e lança NOT_CONFIGURED antes de tudo.
    realDebridMediaRelay: new RealDebridMediaRelay()
  });
  const login2 = await appComDebrid.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: { origin: webOrigin },
    payload: { email: "casa-a@example.com", password: "correct-secret-a" }
  });
  const cookie2 = String(login2.headers["set-cookie"]).split(";", 1)[0]!;

  const resolved = await appComDebrid.inject({
    method: "POST",
    url: "/v1/stremio/streams/resolve",
    headers: { origin: webOrigin, cookie: cookie2 },
    payload: { infoHash: "0123456789abcdef0123456789abcdef01234567", fileIdx: 0 }
  });
  assert.equal(resolved.statusCode, 409);
  assert.equal(JSON.parse(resolved.body).error.code, "REAL_DEBRID_FILE_BLOCKED");

  const listed = await appComDebrid.inject({
    method: "GET",
    url: "/v1/stremio/diagnostics",
    headers: { cookie: cookie2 }
  });
  const body = JSON.parse(listed.body) as {
    entries: { code: string; origin: string; status?: number; detail?: string; route?: string }[];
  };
  assert.equal(body.entries.length, 1);
  const [entry] = body.entries;
  assert.equal(entry?.origin, "servidor");
  assert.equal(entry?.code, "REAL_DEBRID_FILE_BLOCKED");
  assert.equal(entry?.status, 409);
  assert.equal(entry?.route, "/v1/stremio/streams/resolve");
  assert.match(entry?.detail ?? "", /error_code 35/);
  await appComDebrid.close();
  void cookie;
});

test("Casa A não enxerga entradas registradas pela casa B", async () => {
  const { app, login } = await loggedInApp();
  const cookieA = await login("casa-a@example.com", "correct-secret-a");
  const cookieB = await login("casa-b@example.com", "correct-secret-b");

  await app.inject({
    method: "POST",
    url: "/v1/stremio/diagnostics",
    headers: { origin: webOrigin, cookie: cookieB },
    payload: { code: "SOMENTE_CASA_B", message: "" }
  });

  const listedA = await app.inject({ method: "GET", url: "/v1/stremio/diagnostics", headers: { cookie: cookieA } });
  assert.deepEqual(JSON.parse(listedA.body).entries, []);

  const listedB = await app.inject({ method: "GET", url: "/v1/stremio/diagnostics", headers: { cookie: cookieB } });
  const bodyB = JSON.parse(listedB.body) as { entries: { code: string }[] };
  assert.equal(bodyB.entries.length, 1);
  assert.equal(bodyB.entries[0]?.code, "SOMENTE_CASA_B");
  await app.close();
});
