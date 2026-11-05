import assert from "node:assert/strict";
import test from "node:test";
import { StremioApiClient } from "../src/stremio/api-client.js";
import type {
  SaveStremioConnection,
  StremioConnectionRepository
} from "../src/stremio/repository.js";
import { StremioService } from "../src/stremio/service.js";
import {
  StremioIntegrationError,
  type AddonDescriptor,
  type StremioConnection,
  type StremioConnectionStatus
} from "../src/stremio/types.js";

const addons: readonly AddonDescriptor[] = [{
  manifest: {
    id: "org.example",
    version: "1.0.0",
    name: "Example",
    resources: ["catalog"],
    types: ["movie"],
    catalogs: [{ id: "top", type: "movie", name: "Top" }]
  },
  transportUrl: "https://example.com/manifest.json"
}];

class FakeApi extends StremioApiClient {
  loginCalls = 0;
  pullCalls = 0;

  override async login(email: string, password: string) {
    this.loginCalls += 1;
    assert.equal(email, "owner@example.com");
    assert.equal(password, "senha-efemera");
    return { authKey: "auth-key-with-enough-length", addons };
  }

  override async pullAddons(authKey: string) {
    this.pullCalls += 1;
    assert.equal(authKey, "auth-key-with-enough-length");
    return addons;
  }
}

class MemoryRepository implements StremioConnectionRepository {
  current: StremioConnection | null = null;

  async save(record: SaveStremioConnection): Promise<void> {
    this.current = { ...record };
  }
  async find(): Promise<StremioConnection | null> { return this.current; }
  async status(): Promise<StremioConnectionStatus | null> {
    return this.current ? { addonCount: this.current.addons.length, syncedAt: this.current.syncedAt } : null;
  }
  async delete(): Promise<void> { this.current = null; }
}

test("vínculo descarta senha do modelo persistido e sincronização é somente leitura", async () => {
  const api = new FakeApi();
  const repository = new MemoryRepository();
  const service = new StremioService({
    api,
    repository,
    now: () => new Date("2026-08-19T05:00:00.000Z")
  });
  const linked = await service.link("household", "owner@example.com", "senha-efemera");
  assert.equal(linked.addonCount, 1);
  assert.equal(api.loginCalls, 1);
  assert.equal("password" in (repository.current ?? {}), false);
  assert.equal(repository.current?.authKey, "auth-key-with-enough-length");

  await service.sync("household");
  assert.equal(api.pullCalls, 1);
  await service.disconnect("household");
  assert.deepEqual(await service.status("household"), { linked: false, addonCount: 0, syncedAt: null, rejected: [] });
});

test("addons desatualizados são sincronizados automaticamente e falha preserva a última coleção", async () => {
  const api = new FakeApi();
  const repository = new MemoryRepository();
  repository.current = {
    householdId: "household",
    authKey: "auth-key-with-enough-length",
    addons: [],
    syncedAt: new Date("2026-08-19T04:00:00.000Z")
  };
  const service = new StremioService({
    api,
    repository,
    now: () => new Date("2026-08-19T05:00:00.000Z"),
    refreshAfterMs: 60_000
  });

  assert.deepEqual(await service.addons("household"), addons);
  assert.equal(api.pullCalls, 1);
  assert.deepEqual(repository.current?.addons, addons);

  repository.current = {
    householdId: "household",
    authKey: "auth-key-with-enough-length",
    addons,
    syncedAt: new Date("2026-08-19T04:00:00.000Z")
  };
  api.pullAddons = async () => { throw new StremioIntegrationError("UPSTREAM_UNAVAILABLE"); };
  assert.deepEqual(await service.addons("household"), addons);
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function assertRejectsWith(
  code: StremioIntegrationError["code"],
  action: () => Promise<unknown>
): Promise<void> {
  return assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof StremioIntegrationError, `esperava StremioIntegrationError, veio ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("envelope com error do upstream vira AUTHENTICATION_FAILED", async (t) => {
  const client = new StremioApiClient();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = (async () => jsonResponse({ error: { code: 3, message: "User not found" } })) as typeof fetch;
  await assertRejectsWith("AUTHENTICATION_FAILED", () => client.login("owner@example.com", "senha-errada"));
  await assertRejectsWith("AUTHENTICATION_FAILED", () => client.pullAddons("auth-key-with-enough-length"));
});

test("200 fora do formato esperado vira INVALID_RESPONSE, nunca falha de credencial", async (t) => {
  const client = new StremioApiClient();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  // 200 sem "result" nem "error".
  globalThis.fetch = (async () => jsonResponse({})) as typeof fetch;
  await assertRejectsWith("INVALID_RESPONSE", () => client.login("owner@example.com", "senha"));

  // Corpo que não é JSON (ex.: página de manutenção).
  globalThis.fetch = (async () => new Response("<html>manutenção</html>", { status: 200 })) as typeof fetch;
  await assertRejectsWith("INVALID_RESPONSE", () => client.login("owner@example.com", "senha"));

  // Corpo JSON que não é o envelope objeto.
  globalThis.fetch = (async () => jsonResponse("ok")) as typeof fetch;
  await assertRejectsWith("INVALID_RESPONSE", () => client.login("owner@example.com", "senha"));

  // Login aceito mas authKey com shape errado.
  globalThis.fetch = (async () => jsonResponse({ result: { authKey: "curta" } })) as typeof fetch;
  await assertRejectsWith("INVALID_RESPONSE", () => client.login("owner@example.com", "senha"));

  // Coleção cujo campo addons não é array.
  globalThis.fetch = (async () => jsonResponse({ result: { addons: "nada" } })) as typeof fetch;
  await assertRejectsWith("INVALID_RESPONSE", () => client.pullAddons("auth-key-with-enough-length"));
});

test("falha de rede e HTTP não-ok viram UPSTREAM_UNAVAILABLE", async (t) => {
  const client = new StremioApiClient();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = (async () => new Response("bad gateway", { status: 502 })) as typeof fetch;
  await assertRejectsWith("UPSTREAM_UNAVAILABLE", () => client.login("owner@example.com", "senha"));

  globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  await assertRejectsWith("UPSTREAM_UNAVAILABLE", () => client.pullAddons("auth-key-with-enough-length"));
});

test("login real interpreta o envelope result e mantém apenas addons https", async (t) => {
  const client = new StremioApiClient();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const inseguro = { manifest: addons[0]!.manifest, transportUrl: "http://addon.example/manifest.json" };
  globalThis.fetch = (async (input: string | URL | Request) =>
    String(input).endsWith("/login")
      ? jsonResponse({ result: { authKey: "auth-key-with-enough-length" } })
      : jsonResponse({ result: { addons: [addons[0], inseguro] } })) as typeof fetch;

  const linked = await client.login("owner@example.com", "senha-correta");
  assert.equal(linked.authKey, "auth-key-with-enough-length");
  assert.deepEqual(linked.addons, [addons[0]]);
});

// Payload "cru" (pré-validação) de um add-on, no formato que a API do Stremio realmente manda.
function realWireAddon(overrides: {
  id?: string;
  name?: string;
  idPrefixes?: unknown;
  catalogs?: unknown;
  transportUrl?: string;
} = {}): unknown {
  return {
    manifest: {
      id: overrides.id ?? "org.example.real",
      version: "1.0.0",
      name: overrides.name ?? "Add-on real",
      resources: ["catalog", "meta", "stream"],
      types: ["movie", "series"],
      idPrefixes: overrides.idPrefixes,
      catalogs: overrides.catalogs ?? []
    },
    transportUrl: overrides.transportUrl ?? "https://addon.example/manifest.json"
  };
}

test("pullAddons aceita idPrefixes null, catalogs.type desconhecido e catalogs.name null (formatos reais de add-ons Stremio)", async (t) => {
  const client = new StremioApiClient();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  // Comet | ElfHosted, OpenSubtitles, Local Files etc.: idPrefixes null em vez de omitido.
  const comet = realWireAddon({ id: "org.stremio.comet", name: "Comet | ElfHosted", idPrefixes: null });
  // Torrentio RD (o add-on principal do usuário no bug real): catálogo com type "other", fora
  // do antigo enum movie/series.
  const torrentioRd = realWireAddon({
    id: "org.stremio.torrentio-rd",
    name: "Torrentio RD",
    catalogs: [{ id: "torrentio-rd-catalog", type: "other" }]
  });
  // BT4G, Public Domain Movies: catálogo com name null em vez de omitido.
  const bt4g = realWireAddon({
    id: "org.stremio.bt4g",
    name: "BT4G",
    catalogs: [{ id: "bt4g-search", type: "movie", name: null }]
  });

  globalThis.fetch = (async () =>
    jsonResponse({ result: { addons: [comet, torrentioRd, bt4g] } })) as typeof fetch;

  const result = await client.pullAddons("auth-key-with-enough-length");
  assert.deepEqual(result.map((addon) => addon.manifest.id), [
    "org.stremio.comet",
    "org.stremio.torrentio-rd",
    "org.stremio.bt4g"
  ]);
  assert.equal(result[0]?.manifest.idPrefixes, undefined);
  assert.equal(result[1]?.manifest.catalogs[0]?.type, "other");
  assert.equal(result[2]?.manifest.catalogs[0]?.name, undefined);
});

test("pullAddons continua descartando add-on genuinamente inválido", async (t) => {
  const client = new StremioApiClient();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const semId = {
    manifest: { version: "1.0.0", name: "Sem id", resources: [], types: [], catalogs: [] },
    transportUrl: "https://addon.example/manifest.json"
  };
  const semName = {
    manifest: { id: "org.example.sem-nome", version: "1.0.0", resources: [], types: [], catalogs: [] },
    transportUrl: "https://addon.example/manifest.json"
  };
  const httpInseguro = realWireAddon({
    id: "org.example.http",
    transportUrl: "http://addon.example/manifest.json"
  });
  const semResources = {
    manifest: { id: "org.example.sem-resources", version: "1.0.0", name: "Sem resources", types: [], catalogs: [] },
    transportUrl: "https://addon.example/manifest.json"
  };

  globalThis.fetch = (async () =>
    jsonResponse({ result: { addons: [semId, semName, httpInseguro, semResources] } })) as typeof fetch;

  const result = await client.pullAddons("auth-key-with-enough-length");
  assert.deepEqual(result, []);
});

test("pullAddons reporta descartes via onRejected, agregável pelo chamador e sem vazar transportUrl", async (t) => {
  const client = new StremioApiClient();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const semId = {
    manifest: { version: "1.0.0", name: "Sem id", resources: [], types: [], catalogs: [] },
    transportUrl: "https://addon.example/SEGREDO-DEBRID-KEY/manifest.json"
  };
  const httpInseguro = {
    manifest: {
      id: "org.example.http",
      version: "1.0.0",
      name: "Inseguro",
      resources: ["catalog"],
      types: ["movie"],
      catalogs: []
    },
    transportUrl: "http://addon.example/OUTRO-SEGREDO/manifest.json"
  };
  const bom = realWireAddon({ id: "org.example.bom" });

  globalThis.fetch = (async () =>
    jsonResponse({ result: { addons: [semId, httpInseguro, bom] } })) as typeof fetch;

  const rejected: { identifier: string; reason: string }[] = [];
  const result = await client.pullAddons("auth-key-with-enough-length", (item) => rejected.push(item));

  assert.deepEqual(result.map((addon) => addon.manifest.id), ["org.example.bom"]);
  assert.equal(rejected.length, 2);

  // Agregação simples por motivo, do jeito que um chamador real faria com o callback.
  const porMotivo = new Map<string, number>();
  for (const item of rejected) porMotivo.set(item.reason, (porMotivo.get(item.reason) ?? 0) + 1);
  assert.equal(porMotivo.size, 2);

  assert.equal(rejected[0]?.identifier, "Sem id");
  assert.match(rejected[0]?.reason ?? "", /id/i);
  assert.equal(rejected[1]?.identifier, "Inseguro");
  assert.match(rejected[1]?.reason ?? "", /política/i);

  // Nada sensível (transportUrl completa, host do add-on) pode vazar no relatório de descarte.
  const serializado = JSON.stringify(rejected);
  for (const segredo of ["SEGREDO-DEBRID-KEY", "OUTRO-SEGREDO", "addon.example", "http://"]) {
    assert.equal(serializado.includes(segredo), false);
  }
});
