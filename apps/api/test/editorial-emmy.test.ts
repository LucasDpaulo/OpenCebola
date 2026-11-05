import assert from "node:assert/strict";
import test from "node:test";
import { TmdbClient } from "../src/editorial/client.js";

/**
 * A fileira "Vencedores do Emmy" nasce de uma curadoria fixa na API. Cada vencedor é resolvido
 * pelo mesmo pipeline dos detalhes (busca por título + ano) e sai com a arte do TMDB e as
 * categorias que a obra venceu. Este teste protege esse contrato: 3 campeões, categorias
 * preservadas e arte resolvida.
 */

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

// id fake por título, para a busca `/search/tv` devolver algo estável.
const IDS: Record<string, number> = {
  "The Pitt": 1001,
  "Widow's Bay": 1002,
  "DTF St. Louis": 1003
};

function detalhesTv(id: number, name: string) {
  return {
    id,
    name,
    overview: `Sinopse de ${name}.`,
    first_air_date: "2025-01-01",
    genres: [{ name: "Drama" }],
    episode_run_time: [50],
    origin_country: ["US"],
    original_language: "en",
    spoken_languages: [{ english_name: "English", name: "English" }],
    vote_average: 8.1,
    vote_count: 1_200,
    poster_path: "/poster.jpg",
    backdrop_path: "/backdrop.jpg",
    created_by: [],
    credits: { crew: [], cast: [] },
    videos: { results: [] },
    recommendations: { results: [] },
    similar: { results: [] },
    external_ids: {}
  };
}

function clienteEmmy(): TmdbClient {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.pathname.endsWith("/search/tv")) {
      const query = url.searchParams.get("query") ?? "";
      const id = IDS[query];
      return jsonResponse({ results: id ? [{ id }] : [] });
    }
    const match = /\/tv\/(\d+)$/.exec(url.pathname);
    if (match) {
      const id = Number(match[1]);
      const name = Object.keys(IDS).find((title) => IDS[title] === id) ?? "Desconhecido";
      return jsonResponse(detalhesTv(id, name));
    }
    if (url.pathname.endsWith("/watch/providers")) return jsonResponse({ results: {} });
    return new Response("not found", { status: 404 });
  };
  return new TmdbClient({ token: "x".repeat(100), fetchImpl });
}

test("emmy() devolve os campeões com categorias e arte resolvida", async () => {
  const response = await clienteEmmy().emmy();

  assert.equal(response.edition, 2026);
  assert.equal(response.winners.length, 3, "deveriam ser os 3 campeões de série");

  const thePitt = response.winners.find((winner) => winner.title === "The Pitt");
  assert.ok(thePitt, "The Pitt deveria estar na lista");
  assert.ok(thePitt!.categories.includes("Melhor Série Dramática"), "categoria principal preservada");
  assert.ok(thePitt!.posterUrl?.startsWith("https://"), "a arte deveria ser resolvida");

  const comedia = response.winners.find((winner) => winner.title === "Widow's Bay");
  assert.ok(comedia?.categories.includes("Melhor Comédia"), "Widow's Bay deveria trazer sua categoria");
});

test("emmy() mantém o resultado em cache entre chamadas", async () => {
  const client = clienteEmmy();
  const first = await client.emmy();
  const second = await client.emmy();
  assert.equal(first, second, "a segunda chamada deveria reusar o cache");
});
