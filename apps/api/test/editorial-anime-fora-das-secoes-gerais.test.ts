import assert from "node:assert/strict";
import test from "node:test";
import { TmdbClient } from "../src/editorial/client.js";

/**
 * A regra que este teste protege está em docs/REGRAS_DE_CATALOGO.md: "Anime não aparece nesta
 * seção" (Início). Ela era só texto — nada no código a fazia valer.
 *
 * As fontes `anime-*` selecionam anime por gênero 16 MAIS origem JP. As fontes genéricas
 * (`series-classics`, `movies-classics`, ...) não excluíam essa combinação, e o TMDB devolve
 * muito anime quando se ordena por nota: medido contra a API real, `series-classics` trazia
 * 10 de 20 resultados em anime japonês, incluindo Slam Dunk e Ranma ½ — que apareciam colados
 * em "A Grande Família" e "O Pagador de Promessas" na fileira Clássicos da home.
 */

const ANIME = {
  id: 12345,
  name: "Slam Dunk",
  original_name: "スラムダンク",
  overview: "Basquete no ensino médio.",
  first_air_date: "1993-10-16",
  genre_ids: [16, 10759],
  origin_country: ["JP"],
  original_language: "ja",
  vote_average: 8.4,
  vote_count: 900,
  poster_path: "/slamdunk.jpg",
  backdrop_path: "/slamdunk-bg.jpg"
};

const SERIE_BRASILEIRA = {
  id: 7777,
  name: "A Grande Família",
  original_name: "A Grande Família",
  overview: "A rotina de uma família carioca.",
  first_air_date: "2001-01-11",
  genre_ids: [35],
  origin_country: ["BR"],
  original_language: "pt",
  vote_average: 7.4,
  vote_count: 600,
  poster_path: "/grandefamilia.jpg",
  backdrop_path: "/grandefamilia-bg.jpg"
};

const SERIE_AMERICANA = {
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

// Animação ocidental NÃO é anime: gênero 16, mas origem americana. Tem de continuar aparecendo.
const ANIMACAO_OCIDENTAL = {
  id: 2098,
  name: "Batman: A Série Animada",
  original_name: "Batman: The Animated Series",
  overview: "O morcego de Gotham.",
  first_air_date: "1992-09-05",
  genre_ids: [16, 10759],
  origin_country: ["US"],
  original_language: "en",
  vote_average: 8.5,
  vote_count: 1_200,
  poster_path: "/batman.jpg",
  backdrop_path: "/batman-bg.jpg"
};

// Anime em filme: /discover/movie não devolve origin_country, só original_language.
const FILME_ANIME = {
  id: 129,
  title: "A Viagem de Chihiro",
  original_title: "千と千尋の神隠し",
  overview: "Uma menina num mundo de espíritos.",
  release_date: "2001-07-20",
  genre_ids: [16, 14],
  original_language: "ja",
  vote_average: 8.5,
  vote_count: 16_000,
  poster_path: "/chihiro.jpg",
  backdrop_path: "/chihiro-bg.jpg"
};

const FILME_BRASILEIRO = {
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

test("as séries clássicas não trazem anime japonês", async () => {
  const tmdb = clienteComResultados(() => [ANIME, SERIE_AMERICANA, ANIMACAO_OCIDENTAL]);
  const home = await tmdb.home("series");
  const classicos = fileira(home.rails, "series-classics");

  const titulos = classicos?.items.map((item) => item.title) ?? [];
  assert.ok(titulos.length > 0, "a fileira deveria existir");
  assert.ok(!titulos.includes("Slam Dunk"), `anime vazou: ${titulos.join(", ")}`);
  assert.ok(titulos.includes("Família Soprano"), "série comum sumiu junto");
});

// O filtro é gênero 16 MAIS origem japonesa. Só o gênero derrubaria Batman e os Simpsons.
test("animação ocidental continua aparecendo nas seções gerais", async () => {
  const tmdb = clienteComResultados(() => [ANIME, ANIMACAO_OCIDENTAL]);
  const home = await tmdb.home("series");
  const titulos = fileira(home.rails, "series-classics")?.items.map((item) => item.title) ?? [];

  assert.ok(titulos.includes("Batman: A Série Animada"), `Batman foi derrubado junto: ${titulos.join(", ")}`);
});

test("filme de anime também fica fora das fileiras gerais de filmes", async () => {
  const tmdb = clienteComResultados(() => [FILME_ANIME, FILME_BRASILEIRO]);
  const home = await tmdb.home("movies");
  const titulos = fileira(home.rails, "movies-classics")?.items.map((item) => item.title) ?? [];

  assert.ok(!titulos.includes("A Viagem de Chihiro"), `anime vazou nos filmes: ${titulos.join(", ")}`);
  assert.ok(titulos.includes("Cidade de Deus"), "filme comum sumiu junto");
});

// A seção Anime existe para isto: lá o anime é o conteúdo, não o intruso.
test("a seção Anime continua trazendo anime", async () => {
  const tmdb = clienteComResultados(() => [ANIME, SERIE_AMERICANA]);
  const home = await tmdb.home("anime");
  const titulos = fileira(home.rails, "anime-classics")?.items.map((item) => item.title) ?? [];

  assert.ok(titulos.includes("Slam Dunk"), `a seção Anime perdeu o anime: ${titulos.join(", ")}`);
});

// O Início combina fontes brasileiras com as gerais na mesma fileira. É onde o defeito apareceu.
test("a fileira Clássicos do Início não mistura anime com brasileiro", async () => {
  // O falso responde como o TMDB responderia: a consulta brasileira leva `with_origin_country=BR`
  // e por isso nunca devolveria anime japonês. Quem traz o anime é a fonte genérica.
  const tmdb = clienteComResultados((url) => {
    const brasileira = url.searchParams.get("with_origin_country") === "BR";
    if (url.pathname.includes("/discover/tv")) return brasileira ? [SERIE_BRASILEIRA] : [ANIME, SERIE_AMERICANA];
    return brasileira ? [FILME_BRASILEIRO] : [FILME_ANIME];
  });
  const home = await tmdb.home("home");
  const titulos = fileira(home.rails, "home-classics")?.items.map((item) => item.title) ?? [];

  assert.ok(!titulos.includes("Slam Dunk"), `anime na vitrine do Início: ${titulos.join(", ")}`);
  assert.ok(!titulos.includes("A Viagem de Chihiro"), `anime em filme na vitrine: ${titulos.join(", ")}`);
  assert.ok(titulos.includes("A Grande Família"), "o brasileiro sumiu junto");
});
