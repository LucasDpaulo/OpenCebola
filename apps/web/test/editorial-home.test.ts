import assert from "node:assert/strict";
import test from "node:test";
import { setCredential } from "../app/api-client.js";
import {
  EDITORIAL_HOME_STORAGE_PREFIX,
  cachedEditorialHome,
  loadEditorialHome,
  loadEditorialCategory,
  resetEditorialHomeCache
} from "../app/editorial-home.js";

const railDeExemplo = {
  id: "trending-movie",
  title: "Em alta",
  provider: null,
  items: [{ tmdbId: 1234, type: "movie", title: "Um filme" }]
};

function memoriaLocal(): Storage {
  const dados = new Map<string, string>();
  return {
    get length() { return dados.size; },
    clear: () => dados.clear(),
    getItem: (chave: string) => dados.get(chave) ?? null,
    key: (indice: number) => [...dados.keys()][indice] ?? null,
    removeItem: (chave: string) => { dados.delete(chave); },
    setItem: (chave: string, valor: string) => { dados.set(chave, valor); }
  } satisfies Storage;
}

function preparar(respostas: readonly (() => Response)[]): { pedidos: string[] } {
  const pedidos: string[] = [];
  let indice = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    pedidos.push(String(url));
    const proxima = respostas[Math.min(indice, respostas.length - 1)];
    indice += 1;
    return proxima!();
  }) as typeof globalThis.fetch;
  return { pedidos };
}

function respostaOk(rails: readonly unknown[] = [railDeExemplo]): Response {
  return new Response(JSON.stringify({ rails }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

test.beforeEach(() => {
  setCredential({ kind: "cookie" });
  (globalThis as { window?: unknown }).window = undefined;
  (globalThis as { localStorage?: Storage }).localStorage = memoriaLocal();
  resetEditorialHomeCache();
});

test("duas chamadas simultâneas para a mesma seção viram um pedido só", async () => {
  const { pedidos } = preparar([respostaOk]);

  const [uma, outra] = await Promise.all([
    loadEditorialHome("home"),
    loadEditorialHome("home")
  ]);

  assert.equal(pedidos.length, 1);
  assert.equal(uma.status, "ok");
  assert.equal(outra.status, "ok");
});

test("a segunda chamada depois de pronta vem do cache, sem rede", async () => {
  const { pedidos } = preparar([respostaOk]);

  await loadEditorialHome("home");
  const segunda = await loadEditorialHome("home");

  assert.equal(pedidos.length, 1);
  assert.equal(segunda.status, "ok");
});

test("seções diferentes não compartilham cache", async () => {
  const { pedidos } = preparar([respostaOk]);

  await loadEditorialHome("home");
  await loadEditorialHome("movies");

  assert.equal(pedidos.length, 2);
  assert.match(pedidos[1]!, /section=movies/);
});

test("401 é devolvido como não autorizado e não fica em cache", async () => {
  const { pedidos } = preparar([
    () => new Response("{}", { status: 401 }),
    respostaOk
  ]);

  const primeira = await loadEditorialHome("home");
  assert.equal(primeira.status, "unauthorized");

  const segunda = await loadEditorialHome("home");
  assert.equal(segunda.status, "ok");
  assert.equal(pedidos.length, 2);
});

test("falha do servidor não fica em cache", async () => {
  const { pedidos } = preparar([
    () => new Response("{}", { status: 502 }),
    respostaOk
  ]);

  assert.equal((await loadEditorialHome("home")).status, "unavailable");
  assert.equal((await loadEditorialHome("home")).status, "ok");
  assert.equal(pedidos.length, 2);
});

test("resposta com formato inesperado não fica em cache", async () => {
  const { pedidos } = preparar([
    () => new Response(JSON.stringify({ rails: [{ id: 1 }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }),
    respostaOk
  ]);

  assert.equal((await loadEditorialHome("home")).status, "unavailable");
  assert.equal((await loadEditorialHome("home")).status, "ok");
  assert.equal(pedidos.length, 2);
});

// O que faz a abertura do app parecer instantânea na segunda vez: o resultado sobrevive ao
// recarregar da página, que é exatamente o que o Android e o PC fazem a cada boot frio.
test("o resultado sobrevive à reabertura do app: volta do localStorage sem rede", async () => {
  const { pedidos } = preparar([respostaOk]);
  await loadEditorialHome("home");
  assert.equal(pedidos.length, 1);

  // Reinício da página: a memória do processo some, o localStorage fica.
  resetEditorialHomeCache({ keepStorage: true });

  const restaurada = await loadEditorialHome("home");
  assert.equal(restaurada.status, "ok");
  assert.equal(pedidos.length, 1);
});

test("entrada vencida no localStorage é ignorada", async () => {
  const { pedidos } = preparar([respostaOk]);
  globalThis.localStorage.setItem(
    `${EDITORIAL_HOME_STORAGE_PREFIX}home:1`,
    JSON.stringify({ expiresAt: Date.now() - 1, rails: [railDeExemplo] })
  );

  const resultado = await loadEditorialHome("home");

  assert.equal(resultado.status, "ok");
  assert.equal(pedidos.length, 1);
});

test("lixo no localStorage não derruba a home", async () => {
  const { pedidos } = preparar([respostaOk]);
  globalThis.localStorage.setItem(`${EDITORIAL_HOME_STORAGE_PREFIX}home:1`, "isto não é json");

  const resultado = await loadEditorialHome("home");

  assert.equal(resultado.status, "ok");
  assert.equal(pedidos.length, 1);
});

test("cachedEditorialHome responde sem rede para quem já está pronto", async () => {
  preparar([respostaOk]);
  assert.equal(cachedEditorialHome("home"), null);

  await loadEditorialHome("home");

  assert.equal(cachedEditorialHome("home")?.length, 1);
});

// O defeito que este teste tranca: reidratar recarimbava 10 minutos novos, e uma seleção de
// 10 minutos acabava sendo servida por quase 20.
test("reidratar preserva o prazo guardado, não carimba um novo", async () => {
  const { pedidos } = preparar([respostaOk]);
  const quaseVencendo = Date.now() + 1_000;
  globalThis.localStorage.setItem(
    `${EDITORIAL_HOME_STORAGE_PREFIX}home:1`,
    JSON.stringify({ expiresAt: quaseVencendo, rails: [railDeExemplo] })
  );

  assert.equal(cachedEditorialHome("home")?.length, 1);
  assert.equal(pedidos.length, 0);

  // Passado o prazo ORIGINAL, a entrada tem de morrer — mesmo tendo sido lida há instantes.
  const relogioReal = Date.now;
  Date.now = () => relogioReal() + 2_000;
  try {
    assert.equal(cachedEditorialHome("home"), null);
  } finally {
    Date.now = relogioReal;
  }
});

// Cada página é uma entrada própria: quem nunca clica em "+ Ver mais" nunca paga a viagem extra.
test("páginas diferentes não compartilham cache", async () => {
  const { pedidos } = preparar([respostaOk]);

  await loadEditorialHome("home", 1);
  await loadEditorialHome("home", 2);
  await loadEditorialHome("home", 1);

  assert.equal(pedidos.length, 2, `pediu: ${pedidos.join(" | ")}`);
  assert.match(pedidos[0]!, /page=1/);
  assert.match(pedidos[1]!, /page=2/);
});

test("categoria publica fileiras principais antes do provedor lento, sem perder a ordem", async () => {
  let finishProvider!: (response: Response) => void;
  const provider = { ...railDeExemplo, id: "provider-movie-netflix" };
  globalThis.fetch = (async (input) => String(input).includes("group=providers")
    ? new Promise<Response>((resolve) => { finishProvider = resolve; })
    : respostaOk()) as typeof fetch;
  const published: string[][] = [];
  let first!: () => void;
  const firstPublished = new Promise<void>((resolve) => { first = resolve; });
  const pending = loadEditorialCategory("movies", (rails) => {
    published.push(rails.map((rail) => rail.id));
    first();
  });
  await firstPublished;
  assert.deepEqual(published, [[railDeExemplo.id]]);
  assert.equal(cachedEditorialHome("movies"), null);
  finishProvider(respostaOk([provider]));
  await pending;
  assert.deepEqual(published.at(-1), [railDeExemplo.id, provider.id]);
  assert.equal(cachedEditorialHome("movies")?.length, 2);
});

test("falha de provedor não apaga a categoria nem guarda resposta parcial como completa", async () => {
  globalThis.fetch = (async (input) => String(input).includes("group=providers")
    ? new Response("", { status: 502 }) : respostaOk()) as typeof fetch;
  const result = await loadEditorialCategory("series", () => {});
  assert.equal(result.status, "ok");
  assert.equal(cachedEditorialHome("series"), null);
});

test("API anterior que ignora group não duplica fileiras durante atualização", async () => {
  preparar([() => respostaOk()]);
  const result = await loadEditorialCategory("anime", () => {});
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.equal(result.rails.length, 1);
});
