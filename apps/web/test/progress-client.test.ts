import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { setCredential } from "../app/api-client.js";
import { fetchProgressItems, sendProgress, fetchTitleProgress, hideProgress, mergeSavedProgress } from "../app/progress/client.js";

type Chamada = { url: string; init: RequestInit };

/** `responder` decide a resposta de cada chamada; devolver `Error` simula falha de rede. */
function falsoFetch(responder: (chamada: Chamada) => Response | Error): Chamada[] {
  const chamadas: Chamada[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const chamada = { url: String(url), init };
    chamadas.push(chamada);
    const resposta = responder(chamada);
    if (resposta instanceof Error) throw resposta;
    return resposta;
  }) as typeof globalThis.fetch;
  return chamadas;
}

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });

const item = (videoId: string, extra: object = {}) => ({
  id: "1", mediaId: "tt1", videoId, positionSeconds: 120, durationSeconds: 3600, completed: false,
  updatedAt: "2026-09-01T10:00:00.000Z", playbackScenario: null, ...extra
});

const corpoPut = JSON.stringify({ mediaId: "tt1", videoId: "tt1:1:2", positionSeconds: 10 });

function diagnosticos(chamadas: Chamada[]): Chamada[] {
  return chamadas.filter((c) => c.url.endsWith("/v1/stremio/diagnostics"));
}

// A leitura da lista divide a resposta por 2 s: cada teste começa num relógio bem à frente do
// anterior para nunca herdar a lista em cache do teste de antes.
let relogio = 1_000_000;
function novoRelogio(): void {
  relogio += 3_600_000;
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"], now: relogio });
}

test("sendProgress faz o PUT com keepalive e devolve true", async () => {
  setCredential({ kind: "cookie" });
  const chamadas = falsoFetch(() => json({}));
  assert.equal(await sendProgress(corpoPut), true);
  assert.equal(chamadas.length, 1);
  assert.ok(chamadas[0]?.url.endsWith("/v1/progress"));
  assert.equal(chamadas[0]?.init.method, "PUT");
  assert.equal(chamadas[0]?.init.keepalive, true);
  assert.equal(chamadas[0]?.init.cache, "no-store");
  assert.equal(chamadas[0]?.init.body, corpoPut);
  assert.equal(new Headers(chamadas[0]?.init.headers).get("content-type"), "application/json");
});

test("401 avisa a tela e não vira diagnóstico", async () => {
  setCredential({ kind: "cookie" });
  const chamadas = falsoFetch(() => json({}, 401));
  let avisos = 0;
  assert.equal(await sendProgress(corpoPut, { onUnauthorized: () => { avisos += 1; } }), false);
  assert.equal(avisos, 1);
  assert.equal(diagnosticos(chamadas).length, 0);
});

test("401 sem ouvinte, ou com ouvinte que lança, não lança", async () => {
  setCredential({ kind: "cookie" });
  falsoFetch(() => json({}, 401));
  assert.equal(await sendProgress(corpoPut), false);
  assert.equal(await sendProgress(corpoPut, { onUnauthorized: () => { throw new Error("tela caiu"); } }), false);
});

test("recusa da API vira PROGRESS_SAVE_FAILED com o status e o vídeo", async () => {
  setCredential({ kind: "cookie" });
  const chamadas = falsoFetch((chamada) => chamada.url.endsWith("/v1/progress") ? json({}, 400) : json({}));
  assert.equal(await sendProgress(corpoPut), false);
  const relatos = diagnosticos(chamadas);
  assert.equal(relatos.length, 1);
  const relato = JSON.parse(String(relatos[0]?.init.body)) as { code: string; message: string; context: Record<string, string> };
  assert.equal(relato.code, "PROGRESS_SAVE_FAILED");
  assert.match(relato.message, /400/);
  assert.deepEqual(relato.context, { status: "400", mediaId: "tt1", videoId: "tt1:1:2" });
});

test("falha de rede devolve false, relata e nunca lança", async () => {
  setCredential({ kind: "cookie" });
  const chamadas = falsoFetch((chamada) => chamada.url.endsWith("/v1/progress") ? new Error("sem rede") : json({}));
  assert.equal(await sendProgress("isto não é json"), false);
  assert.equal(diagnosticos(chamadas).length, 1);
});

test("fetchProgressItems pede a lista completa e fica só com itens bem formados", async () => {
  setCredential({ kind: "cookie" });
  novoRelogio();
  const chamadas = falsoFetch(() => json({
    items: [
      item("tt1:1:1", { playbackScenario: { audio: { id: "1", language: "pt", name: "x" } } }),
      item("tt1:1:2", { completed: true }),
      { ...item("sem-posicao"), positionSeconds: "120" },
      { ...item("sem-duracao"), durationSeconds: undefined },
      { ...item("sem-completed"), completed: "yes" },
      { mediaId: 5, videoId: "tt1:1:3", positionSeconds: 1, durationSeconds: 2, completed: false },
      { mediaId: "tt1", positionSeconds: 1, durationSeconds: 2, completed: false },
      null,
      "lixo"
    ]
  }));
  const itens = await fetchProgressItems();
  assert.deepEqual(itens.map((i) => i.videoId), ["tt1:1:1", "tt1:1:2"]);
  assert.deepEqual(itens[0]?.playbackScenario, { audio: { id: "1", language: "pt", name: "x" } });
  assert.equal(itens[0]?.updatedAt, "2026-09-01T10:00:00.000Z");
  assert.equal(chamadas.length, 1);
  assert.ok(chamadas[0]?.url.endsWith("/v1/progress?limit=100&includeCompleted=true"));
  assert.equal(chamadas[0]?.init.cache, "no-store");
  assert.equal(chamadas[0]?.init.method, undefined);
});

test("chamadas concorrentes dividem uma requisição; passados 2 s, pede de novo", async () => {
  setCredential({ kind: "cookie" });
  novoRelogio();
  const chamadas = falsoFetch(() => json({ items: [item("tt1:1:1")] }));
  const [a, b] = await Promise.all([fetchProgressItems(), fetchProgressItems()]);
  assert.equal(a, b);
  mock.timers.setTime(relogio + 1_900);
  await fetchProgressItems();
  assert.equal(chamadas.length, 1);
  mock.timers.setTime(relogio + 2_100);
  await fetchProgressItems();
  assert.equal(chamadas.length, 2);
});

test("depois de gravar, a próxima leitura busca de novo (a lista em cache ficou velha)", async () => {
  setCredential({ kind: "cookie" });
  novoRelogio();
  const chamadas = falsoFetch(() => json({ items: [item("tt1:1:1")] }));
  await fetchProgressItems();
  await sendProgress(corpoPut);
  await fetchProgressItems();
  assert.equal(chamadas.filter((c) => c.url.includes("?limit=100")).length, 2);
});

test("falha vira lista vazia e não fica em cache", async () => {
  setCredential({ kind: "cookie" });
  novoRelogio();
  let tentativa = 0;
  const chamadas = falsoFetch(() => {
    tentativa += 1;
    if (tentativa === 1) return new Error("sem rede");
    if (tentativa === 2) return json({}, 500);
    if (tentativa === 3) return json({ items: "nao-e-lista" });
    return json({ items: [item("tt1:1:1")] });
  });
  assert.deepEqual(await fetchProgressItems(), []);
  assert.deepEqual(await fetchProgressItems(), []);
  assert.deepEqual(await fetchProgressItems(), []);
  assert.equal((await fetchProgressItems()).length, 1);
  assert.equal(chamadas.length, 4);
  mock.timers.reset();
});

test("consulta da obra lê todas as páginas e inclui os IDs alternativos", async () => {
  setCredential({ kind: "cookie" });
  const calls = falsoFetch(({ init }) => {
    const request = JSON.parse(String(init.body));
    assert.deepEqual(request.videoIds, ["tt1:1:1"]);
    return json({ items: request.offset === 0 ? Array.from({ length: 100 }, (_, i) => item(`ep${i}`)) : [item("antigo")] });
  });
  const result = await fetchTitleProgress({ mediaId: "tmdb:1", mediaType: "series", videoIds: ["tt1:1:1", "tt1:1:1"] });
  assert.equal(result.length, 101);
  assert.equal(result[100]?.videoId, "antigo");
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(String(calls[1]?.init.body)).offset, 100);
});

test("falha em página posterior não apresenta histórico parcial como completo", async () => {
  falsoFetch(({ url, init }) => {
    if (!url.endsWith("/title")) return json({});
    return JSON.parse(String(init.body)).offset === 0
      ? json({ items: Array.from({ length: 100 }, () => item("ep")) }) : json({}, 503);
  });
  assert.deepEqual(await fetchTitleProgress({ mediaId: "tt1", mediaType: "series", videoIds: [] }), []);
});

test("a confirmação do servidor atualiza assistido sem depender de recarregar a tela", async () => {
  const saved = item("tt1", { completed: true, watched: true });
  falsoFetch(() => json(saved));
  let received: unknown;
  assert.equal(await sendProgress(corpoPut, { onSaved: (value) => { received = value; } }), true);
  assert.deepEqual(received, saved);
  assert.deepEqual(mergeSavedProgress([item("tt1")], saved), [saved]);
  const latest = item("tt1", { updatedAt: "2026-10-15T00:00:00Z", watched: true });
  assert.deepEqual(mergeSavedProgress([latest], saved), [latest]);
});

test("ocultar usa operação própria e invalida cache, sem fabricar conclusão", async () => {
  novoRelogio();
  const calls = falsoFetch(({ url }) => url.endsWith("/hidden") ? new Response(null, { status: 204 }) : json({ items: [] }));
  await fetchProgressItems();
  assert.equal(await hideProgress({ mediaId: "tt1", videoId: "tt1:1:2", mediaType: "series" }), true);
  await fetchProgressItems();
  assert.equal(calls.length, 3);
  assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), { mediaId: "tt1", videoId: "tt1:1:2", mediaType: "series" });
  mock.timers.reset();
});
