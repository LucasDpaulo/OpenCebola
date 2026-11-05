import assert from "node:assert/strict";
import test from "node:test";
import { TmdbClient } from "../src/editorial/client.js";

/**
 * O Início e as fileiras de cada streaming ordenam por popularidade, e desenho e pré-escolar
 * lideram a popularidade no TMDB. Sem excluí-los, "O que está em alta" e as trilhas dos
 * provedores enchiam de conteúdo infantil. As fontes gerais passam a mandar `without_genres`
 * (Família 10751 + Kids/TV 10762) e, para o que `/trending` ignora esse parâmetro, um filtro
 * por gênero cobre o "top 10 da semana".
 *
 * Anime é caso à parte (gênero 16 + origem JP, ver o teste vizinho) e tem fileiras próprias, por
 * isso continua fora deste filtro.
 */

// Animação ocidental de família: gênero 16 mas origem americana — o filtro de ANIME a mantém.
// É o filtro INFANTIL (10751) que precisa barrá-la nas fileiras gerais.
const FILME_INFANTIL = {
  id: 109445,
  title: "Frozen",
  original_title: "Frozen",
  overview: "Duas irmãs e um reino congelado.",
  release_date: "2013-11-27",
  genre_ids: [16, 10751, 12],
  original_language: "en",
  vote_average: 7.3,
  vote_count: 15_000,
  poster_path: "/frozen.jpg",
  backdrop_path: "/frozen-bg.jpg"
};

const SERIE_INFANTIL = {
  id: 90280,
  name: "CoComelon",
  original_name: "CoComelon",
  overview: "Canções infantis.",
  first_air_date: "2020-06-01",
  genre_ids: [10762],
  origin_country: ["US"],
  original_language: "en",
  vote_average: 6.9,
  vote_count: 300,
  poster_path: "/cocomelon.jpg",
  backdrop_path: "/cocomelon-bg.jpg"
};

const FILME_ADULTO = {
  id: 598,
  title: "Cidade de Deus",
  original_title: "Cidade de Deus",
  overview: "A vida na favela carioca.",
  release_date: "2002-02-05",
  genre_ids: [18, 80],
  original_language: "pt",
  vote_average: 8.4,
  vote_count: 6_000,
  poster_path: "/cdd.jpg",
  backdrop_path: "/cdd-bg.jpg"
};

const SERIE_ADULTA = {
  id: 1398,
  name: "Família Soprano",
  original_name: "The Sopranos",
  overview: "Um chefe da máfia em terapia.",
  first_air_date: "1999-01-10",
  genre_ids: [18],
  origin_country: ["US"],
  original_language: "en",
  vote_average: 8.6,
  vote_count: 3_000,
  poster_path: "/sopranos.jpg",
  backdrop_path: "/sopranos-bg.jpg"
};

function clienteComResultados(porCaminho: (url: URL) => readonly unknown[]): TmdbClient {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    return new Response(JSON.stringify({ results: porCaminho(url) }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  return new TmdbClient({ token: "token-de-teste", fetchImpl });
}

function fileira(rails: readonly { id: string; items: readonly { title: string }[] }[], id: string) {
  return rails.find((rail) => rail.id === id);
}

// `/trending/movie/week` ignora `without_genres`: aqui o mock devolve o infantil mesmo assim,
// provando que o filtro por gênero (`ehInfantil`), e não só o parâmetro, é quem o barra.
test("o top 10 da semana não traz conteúdo infantil (Família)", async () => {
  const tmdb = clienteComResultados(() => [FILME_INFANTIL, FILME_ADULTO]);
  const home = await tmdb.home("movies");
  const titulos = fileira(home.rails, "movies-top10")?.items.map((item) => item.title) ?? [];

  assert.ok(titulos.length > 0, "a fileira deveria existir");
  assert.ok(!titulos.includes("Frozen"), `conteúdo infantil vazou: ${titulos.join(", ")}`);
  assert.ok(titulos.includes("Cidade de Deus"), "filme adulto sumiu junto");
});

test("as séries não trazem conteúdo infantil (Kids/TV)", async () => {
  const tmdb = clienteComResultados(() => [SERIE_INFANTIL, SERIE_ADULTA]);
  const home = await tmdb.home("series");
  const titulos = fileira(home.rails, "series-trending")?.items.map((item) => item.title) ?? [];

  assert.ok(!titulos.includes("CoComelon"), `série infantil vazou: ${titulos.join(", ")}`);
  assert.ok(titulos.includes("Família Soprano"), "série adulta sumiu junto");
});

test("as fileiras de provedor não trazem conteúdo infantil", async () => {
  const tmdb = clienteComResultados(() => [FILME_INFANTIL, FILME_ADULTO]);
  const home = await tmdb.home("movies");
  const titulos = fileira(home.rails, "provider-movie-netflix")?.items.map((item) => item.title) ?? [];

  assert.ok(titulos.length > 0, "a fileira de provedor deveria existir");
  assert.ok(!titulos.includes("Frozen"), `conteúdo infantil vazou no provedor: ${titulos.join(", ")}`);
  assert.ok(titulos.includes("Cidade de Deus"), "filme adulto sumiu junto");
});
