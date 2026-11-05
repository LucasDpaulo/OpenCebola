import assert from "node:assert/strict";
import test from "node:test";
import { apiFetch, setCredential } from "../app/api-client.js";

type Capturado = { url: string; init: RequestInit };

function capturarFetch(): { chamadas: Capturado[] } {
  const chamadas: Capturado[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    chamadas.push({ url: String(url), init });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { chamadas };
}

test("no navegador manda o cookie e nenhum Authorization", async () => {
  const { chamadas } = capturarFetch();
  setCredential({ kind: "cookie" });

  await apiFetch("/v1/health");

  assert.equal(chamadas[0]?.init.credentials, "include");
  assert.equal(new Headers(chamadas[0]?.init.headers).get("authorization"), null);
});

// O ponto que faz o app existir: cliente nativo não tem cookie, e mandar `credentials:
// "include"` de uma origem sem credencial liberada faria o navegador embutido recusar a
// resposta inteira — mesmo com o Bearer correto no cabeçalho.
test("no app manda Bearer e NÃO pede credenciais", async () => {
  const { chamadas } = capturarFetch();
  setCredential({ kind: "bearer", token: "token-de-teste" });

  await apiFetch("/v1/health");

  assert.equal(new Headers(chamadas[0]?.init.headers).get("authorization"), "Bearer token-de-teste");
  assert.equal(chamadas[0]?.init.credentials, "omit");
});

test("primeira chamada do app sem sessão omite cookie e não manda Authorization", async () => {
  const { chamadas } = capturarFetch();
  setCredential({ kind: "cookie" });
  (globalThis as { window?: unknown }).window = {
    Capacitor: { isNativePlatform: () => true },
    localStorage: { getItem: () => null }
  };

  try {
    await apiFetch("/v1/auth/session");
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }

  assert.equal(chamadas[0]?.init.credentials, "omit");
  assert.equal(new Headers(chamadas[0]?.init.headers).get("authorization"), null);
});

test("primeira chamada do app restaura o Bearer antes de tocar na rede", async () => {
  const { chamadas } = capturarFetch();
  setCredential({ kind: "cookie" });
  (globalThis as { window?: unknown }).window = {
    Capacitor: { isNativePlatform: () => true },
    localStorage: { getItem: () => "token-guardado" }
  };

  try {
    await apiFetch("/v1/auth/session");
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }

  assert.equal(chamadas[0]?.init.credentials, "omit");
  assert.equal(new Headers(chamadas[0]?.init.headers).get("authorization"), "Bearer token-guardado");
});

test("runtime Tizen usa a mesma sessão Bearer nativa, sem cookie", async () => {
  const { chamadas } = capturarFetch();
  setCredential({ kind: "cookie" });
  (globalThis as { window?: unknown }).window = {
    tizen: { application: {} },
    webapis: { avplay: {} },
    localStorage: { getItem: () => "token-tv" }
  };
  try { await apiFetch("/v1/auth/session"); }
  finally { delete (globalThis as { window?: unknown }).window; }

  assert.equal(chamadas[0]?.init.credentials, "omit");
  assert.equal(new Headers(chamadas[0]?.init.headers).get("authorization"), "Bearer token-tv");
});

test("cabeçalho de quem chama é preservado, e o caminho vira URL absoluta", async () => {
  const { chamadas } = capturarFetch();
  setCredential({ kind: "cookie" });

  await apiFetch("/v1/stremio/link", {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });

  assert.match(chamadas[0]?.url ?? "", /\/v1\/stremio\/link$/);
  assert.equal(new Headers(chamadas[0]?.init.headers).get("content-type"), "application/json");
  assert.equal(chamadas[0]?.init.method, "POST");
});

// `cache: "no-store"` era escrito por cima do que o chamador pedisse, o que tornava impossível
// aproveitar qualquer `Cache-Control` que a API mandasse. Continua sendo o padrão — só deixou
// de ser imposição.
test("sem pedido explícito, continua sem guardar nada", async () => {
  const { chamadas } = capturarFetch();
  (globalThis as { window?: unknown }).window = undefined;
  setCredential({ kind: "cookie" });

  await apiFetch("/v1/health");

  assert.equal(chamadas[0]?.init.cache, "no-store");
});

test("quem pede um modo de cache é respeitado", async () => {
  const { chamadas } = capturarFetch();
  (globalThis as { window?: unknown }).window = undefined;
  setCredential({ kind: "cookie" });

  await apiFetch("/v1/editorial/home?section=home", { cache: "default" });

  assert.equal(chamadas[0]?.init.cache, "default");
});

test("o modo de cache não interfere na credencial", async () => {
  const { chamadas } = capturarFetch();
  (globalThis as { window?: unknown }).window = undefined;
  setCredential({ kind: "bearer", token: "token-de-teste" });

  await apiFetch("/v1/editorial/movie/42", { cache: "default" });

  assert.equal(chamadas[0]?.init.cache, "default");
  assert.equal(chamadas[0]?.init.credentials, "omit");
  assert.equal(new Headers(chamadas[0]?.init.headers).get("authorization"), "Bearer token-de-teste");
});
