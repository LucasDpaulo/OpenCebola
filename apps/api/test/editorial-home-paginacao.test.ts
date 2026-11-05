import assert from "node:assert/strict";
import test from "node:test";
import { TmdbClient } from "../src/editorial/client.js";

/**
 * O "+ Ver mais" precisa continuar dando sugestões. Antes, a fileira nascia com 20 itens e
 * acabava ali: o card sumia do fim da trilha, e sumir era o que fazia a trilha pular de volta
 * para o começo (`scroll-snap-type: x proximity` perde a âncora quando o último filho some).
 *
 * A página vem sob demanda em vez de tudo na primeira carga: a home abre leve, e só quem
 * clica paga a viagem seguinte.
 */

function itemDePagina(pagina: number, indice: number) {
  const id = pagina * 100 + indice;
  return {
    id,
    name: `Série p${pagina}n${indice}`,
    title: `Série p${pagina}n${indice}`,
    overview: "Sinopse.",
    first_air_date: "2001-01-01",
    release_date: "2001-01-01",
    genre_ids: [18],
    origin_country: ["US"],
    original_language: "en",
    vote_average: 7,
    vote_count: 800,
    poster_path: `/p${id}.jpg`,
    backdrop_path: `/b${id}.jpg`
  };
}

function clienteQueContaPaginas(): { tmdb: TmdbClient; paginasPedidas: () => readonly string[] } {
  const pedidas: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const pagina = Number(url.searchParams.get("page") ?? "1");
    pedidas.push(url.searchParams.get("page") ?? "(sem page)");
    return new Response(
      JSON.stringify({ results: Array.from({ length: 20 }, (_, i) => itemDePagina(pagina, i)) }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  return { tmdb: new TmdbClient({ token: "token-de-teste", fetchImpl }), paginasPedidas: () => pedidas };
}

test("a primeira carga pede a página 1", async () => {
  const { tmdb, paginasPedidas } = clienteQueContaPaginas();
  await tmdb.home("series");
  assert.ok(paginasPedidas().every((p) => p === "1"), `pediu ${[...new Set(paginasPedidas())].join(", ")}`);
});

test("a página 2 traz itens diferentes da página 1", async () => {
  const { tmdb } = clienteQueContaPaginas();
  const primeira = await tmdb.home("series", 1);
  const segunda = await tmdb.home("series", 2);

  const titulosPagina1 = primeira.rails.find((r) => r.id === "series-classics")?.items.map((i) => i.title) ?? [];
  const titulosPagina2 = segunda.rails.find((r) => r.id === "series-classics")?.items.map((i) => i.title) ?? [];

  assert.ok(titulosPagina1.length > 0 && titulosPagina2.length > 0);
  assert.equal(titulosPagina1.some((t) => titulosPagina2.includes(t)), false, "as duas páginas se repetem");
  assert.ok(titulosPagina2[0]?.startsWith("Série p2"), `pagina 2 devolveu ${titulosPagina2[0]}`);
});

test("cada página tem cache próprio e não é buscada duas vezes", async () => {
  const { tmdb, paginasPedidas } = clienteQueContaPaginas();
  await tmdb.home("series", 2);
  const depoisDaPrimeira = paginasPedidas().length;
  await tmdb.home("series", 2);

  assert.equal(paginasPedidas().length, depoisDaPrimeira, "a segunda chamada refez a viagem");
});

test("a página do Início também vale para as fileiras combinadas", async () => {
  const { tmdb } = clienteQueContaPaginas();
  const segunda = await tmdb.home("home", 2);
  const classicos = segunda.rails.find((r) => r.id === "home-classics");

  assert.ok((classicos?.items.length ?? 0) > 0, "a fileira combinada sumiu na página 2");
  assert.ok(
    classicos!.items.every((item) => item.title.startsWith("Série p2")),
    `veio item de outra página: ${classicos!.items.map((i) => i.title).slice(0, 3).join(", ")}`
  );
});

test("fileiras principais respondem enquanto provedores ainda estão pendentes", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const tmdb = new TmdbClient({ token: "test", fetchImpl: async (input) => {
    const url = new URL(String(input));
    if (url.searchParams.has("with_watch_providers")) await blocked;
    return new Response(JSON.stringify({ results: [itemDePagina(1, 0)] }));
  } });
  const providers = tmdb.home("series", 1, "providers");
  const primary = await tmdb.home("series", 1, "primary");
  assert.ok(primary.rails.length > 0);
  assert.ok(primary.rails.every((rail) => !rail.id.startsWith("provider-")));
  release();
  assert.ok((await providers).rails.every((rail) => rail.id.startsWith("provider-")));
  const all = await tmdb.home("series");
  assert.equal(all.rails.length, primary.rails.length + (await providers).rails.length);
});
