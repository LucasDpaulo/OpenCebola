import assert from "node:assert/strict";
import test from "node:test";
import { TmdbClient, TmdbError } from "../src/editorial/client.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

test("TMDB resolve IMDb, enriquece o título e mantém resultado em cache", async () => {
  const requests: Array<{ url: URL; authorization: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    requests.push({
      url,
      authorization: new Headers(init?.headers).get("Authorization")
    });
    if (url.pathname.endsWith("/find/tt0137523")) {
      return jsonResponse({ movie_results: [{ id: 550 }], tv_results: [] });
    }
    if (url.pathname.endsWith("/movie/550/watch/providers")) {
      return jsonResponse({
        results: {
          BR: {
            link: "https://www.themoviedb.org/movie/550/watch?locale=BR",
            flatrate: [{
              provider_id: 119,
              provider_name: "Prime Video",
              logo_path: "/prime.jpg",
              display_priority: 1
            }]
          }
        }
      });
    }
    if (url.pathname.endsWith("/movie/550")) {
      return jsonResponse({
        id: 550,
        imdb_id: "tt0137523",
        title: "Clube da Luta",
        original_title: "Fight Club",
        tagline: "Mischief. Mayhem. Soap.",
        overview: "Um homem encontra uma forma radical de escapar da rotina.",
        release_date: "1999-10-15",
        runtime: 139,
        genres: [{ name: "Drama" }],
        production_countries: [{ name: "Estados Unidos" }],
        origin_country: ["US"],
        original_language: "en",
        spoken_languages: [{ english_name: "English", name: "English" }],
        vote_average: 8.4,
        vote_count: 30_000,
        poster_path: "/poster.jpg",
        backdrop_path: "/backdrop.jpg",
        created_by: [],
        credits: {
          crew: [{ name: "David Fincher", job: "Director" }],
          cast: [{ id: 1, name: "Edward Norton", character: "Narrador", profile_path: "/actor.jpg", order: 0 }]
        },
        videos: { results: [{ key: "trailer", site: "YouTube", type: "Trailer", official: true }] },
        recommendations: {
          results: [{ id: 680, title: "Pulp Fiction", release_date: "1994-09-10", overview: "", poster_path: null, backdrop_path: null, vote_average: 8.5 }]
        },
        similar: { results: [] },
        external_ids: { imdb_id: "tt0137523" }
      });
    }
    return new Response("not found", { status: 404 });
  };

  const client = new TmdbClient({ token: "x".repeat(100), fetchImpl });
  const first = await client.title({ type: "movie", mediaId: "tt0137523" });
  const second = await client.title({ type: "movie", mediaId: "tt0137523" });

  assert.equal(first.title, "Clube da Luta");
  assert.deepEqual(first.directors, ["David Fincher"]);
  assert.equal(first.availability.subscription[0]?.name, "Prime Video");
  assert.equal(first.attribution.providersSource, "JustWatch");
  assert.equal(first.recommendations[0]?.title, "Pulp Fiction");
  assert.deepEqual(second, first);
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.authorization === `Bearer ${"x".repeat(100)}`));
  assert.ok(requests.every((request) => !request.url.search.includes("x".repeat(20))));
});

test("TMDB usa busca por título quando o identificador não é IMDb", async () => {
  const paths: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    paths.push(`${url.pathname}?${url.searchParams.toString()}`);
    if (url.pathname.endsWith("/search/tv")) return jsonResponse({ results: [{ id: 1396 }] });
    if (url.pathname.endsWith("/tv/1396/watch/providers")) return jsonResponse({ results: {} });
    if (url.pathname.endsWith("/tv/1396")) {
      return jsonResponse({
        id: 1396, name: "Breaking Bad", original_name: "Breaking Bad", first_air_date: "2008-01-20",
        episode_run_time: [47], genres: [], production_countries: [], origin_country: ["US"],
        spoken_languages: [], created_by: [{ name: "Vince Gilligan" }], vote_count: 0,
        credits: { crew: [], cast: [] }, videos: { results: [] }, recommendations: { results: [] }, similar: { results: [] }
      });
    }
    return new Response("not found", { status: 404 });
  };
  const client = new TmdbClient({ token: "x".repeat(100), fetchImpl });
  const result = await client.title({ type: "series", mediaId: "local-id", title: "Breaking Bad", year: 2008 });
  assert.equal(result.creators[0], "Vince Gilligan");
  assert.equal(result.runtimeMinutes, 47);
  assert.ok(paths[0]?.includes("first_air_date_year=2008"));
});

test("destaque do login usa a alta da SEMANA e pula filme sem trailer", async () => {
  const paths: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    paths.push(`${url.pathname}?${url.searchParams.toString()}`);
    if (url.pathname.endsWith("/trending/movie/week")) {
      return jsonResponse({
        results: [
          // Sem arte: não serve de fundo e não pode virar um ZodError de URL vazia.
          { id: 1, title: "Sem arte", overview: "", backdrop_path: null, poster_path: null },
          // Tem arte, mas nenhum trailer: vira só a reserva, caso ninguém mais tenha.
          { id: 2, title: "Sem trailer", overview: "Nada em vídeo.", backdrop_path: "/b2.jpg", poster_path: "/p2.jpg" },
          { id: 3, title: "Com trailer", overview: "Uma cena de verdade.", backdrop_path: "/b3.jpg", poster_path: "/p3.jpg" }
        ]
      });
    }
    if (url.pathname.endsWith("/movie/3/videos")) {
      return jsonResponse({ results: [{ key: "cena-3", site: "YouTube", type: "Trailer" }] });
    }
    return jsonResponse({ results: [] });
  };

  const client = new TmdbClient({ token: "x".repeat(100), fetchImpl });
  const destaque = await client.dailyFeatured();

  assert.equal(destaque.title, "Com trailer");
  assert.equal(destaque.trailerKey, "cena-3");
  assert.equal(destaque.subtitle, "Uma cena de verdade.");
  assert.equal(destaque.backdropUrl, "https://image.tmdb.org/t/p/original/b3.jpg");
  assert.ok(paths[0]?.includes("/trending/movie/week"));
  assert.ok(paths[0]?.includes("language=pt-BR"));
});

test("sem nenhum trailer na semana, o destaque cai para a cena parada em vez de falhar", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.pathname.endsWith("/trending/movie/week")) {
      return jsonResponse({
        results: [{ id: 9, title: "Só cartaz", overview: "Sem vídeo.", backdrop_path: "/b9.jpg", poster_path: "/p9.jpg" }]
      });
    }
    return jsonResponse({ results: [] });
  };

  const destaque = await new TmdbClient({ token: "x".repeat(100), fetchImpl }).dailyFeatured();
  assert.equal(destaque.title, "Só cartaz");
  assert.equal(destaque.trailerKey, null);
  assert.equal(destaque.backdropUrl, "https://image.tmdb.org/t/p/original/b9.jpg");
});

test("home editorial carrega somente a seção pedida e reaproveita fontes entre as abas", async () => {
  const requests: URL[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    requests.push(url);
    return jsonResponse({
      results: [{
        id: requests.length,
        title: `Título ${requests.length}`,
        overview: "Descoberta renovada.",
        release_date: "2026-08-01",
        backdrop_path: `/capa-${requests.length}.jpg`,
        poster_path: null,
        vote_average: 8.1
      }]
    });
  };

  const client = new TmdbClient({ token: "x".repeat(100), fetchImpl, now: () => Date.UTC(2026, 7, 28) });
  const first = await client.home();
  const second = await client.home();

  assert.equal(first.rails.length, 17);
  assert.deepEqual(second, first);
  assert.equal(requests.length, 26);
  assert.equal(first.rails.some((rail) => rail.id.startsWith("anime-") || rail.id.startsWith("provider-anime-")), false);
  assert.equal(first.rails.some((rail) => rail.id === "movies-top10" || rail.id === "series-top10"), false);
  assert.deepEqual(first.rails.slice(0, 3).map((rail) => rail.id), ["home-new", "home-trending", "home-classics"]);
  assert.ok(requests.some((url) => url.searchParams.get("primary_release_date.lte") === "1999-12-31"));
  assert.ok(requests.some((url) => url.searchParams.get("with_watch_providers") === "8" && url.searchParams.get("watch_region") === "BR"));
  assert.ok(requests.some((url) => url.pathname.endsWith("/discover/tv") && url.searchParams.get("with_watch_providers") === "531"));
  assert.deepEqual(first.rails.find((rail) => rail.id === "provider-movie-netflix")?.provider, {
    id: 8,
    name: "Netflix",
    logoUrl: null
  });
  assert.ok(requests.some((url) => url.searchParams.get("with_origin_country") === "BR" && url.pathname.endsWith("/discover/movie")));
  assert.ok(requests.some((url) => url.searchParams.get("with_origin_country") === "BR" && url.searchParams.get("first_air_date.lte") === "2005-12-31"));
  assert.ok(first.rails.every((rail) => rail.items[0]?.backdropUrl?.startsWith("https://image.tmdb.org/t/p/original/")));

  const anime = await client.home("anime");
  assert.equal(anime.rails.length, 6);
  assert.equal(anime.rails.find((rail) => rail.id === "provider-anime-crunchyroll")?.provider?.name, "Crunchyroll");
  assert.ok(requests.some((url) => url.searchParams.get("with_genres") === "16" && url.searchParams.get("with_origin_country") === "JP"));
  assert.equal(requests.length, 32);

  const movies = await client.home("movies");
  assert.equal(movies.rails.length, 11);
  assert.ok(movies.rails.some((rail) => rail.id === "movies-top10"));
  // Dez fontes de filmes já vieram na Início; somente o Top 10 precisou tocar o TMDB.
  assert.equal(requests.length, 33);

  const brazil = await client.home("brazil");
  assert.equal(brazil.rails.length, 6);
  assert.equal(requests.length, 33);

  const documentaries = await client.home("documentaries");
  assert.equal(documentaries.rails.length, 7);
  assert.ok(documentaries.rails.some((rail) => rail.id === "documentaries-top10-movies"));
  assert.ok(documentaries.rails.some((rail) => rail.id === "documentaries-top10-series"));
  assert.equal(requests.length, 40);
});

test("home editorial preserva os catálogos saudáveis da seção quando uma fonte falha", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.searchParams.get("first_air_date.lte") === "2005-12-31" && url.searchParams.get("with_origin_country") === "JP") {
      return new Response("indisponível", { status: 503 });
    }
    return jsonResponse({
      results: [{ id: 42, title: "Disponível", backdrop_path: "/ok.jpg", poster_path: null }]
    });
  };

  const home = await new TmdbClient({ token: "x".repeat(100), fetchImpl }).home("anime");
  assert.equal(home.rails.length, 5);
  assert.equal(home.rails.some((rail) => rail.id === "anime-classics"), false);
  assert.equal(home.rails.some((rail) => rail.id === "anime-top10"), true);
});

test("id de vídeo fora do formato do YouTube não derruba o destaque, só perde o trailer", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.pathname.endsWith("/trending/movie/week")) {
      return jsonResponse({
        results: [{ id: 4, title: "Chave torta", overview: "Tem vídeo, mas o id não presta.", backdrop_path: "/b4.jpg", poster_path: null }]
      });
    }
    if (url.pathname.endsWith("/movie/4/videos")) {
      // Um "key" com espaço e barra entraria direto na URL do embed montada por concatenação.
      return jsonResponse({ results: [{ key: "nao é/uma chave", site: "YouTube", type: "Trailer" }] });
    }
    return jsonResponse({ results: [] });
  };

  const destaque = await new TmdbClient({ token: "x".repeat(100), fetchImpl }).dailyFeatured();
  assert.equal(destaque.title, "Chave torta");
  assert.equal(destaque.trailerKey, null);
});

test("resposta fora do contrato vira TmdbError, não exceção crua de schema", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.pathname.endsWith("/trending/movie/week")) {
      // Título acima do teto do contrato: antes, `parse` lançava ZodError e a rota devolvia 500.
      return jsonResponse({
        results: [{ id: 5, title: "t".repeat(400), overview: "x", backdrop_path: "/b5.jpg", poster_path: null }]
      });
    }
    if (url.pathname.endsWith("/movie/5/videos")) {
      return jsonResponse({ results: [{ key: "chave-boa1", site: "YouTube", type: "Trailer" }] });
    }
    return jsonResponse({ results: [] });
  };

  const client = new TmdbClient({ token: "x".repeat(100), fetchImpl });
  await assert.rejects(() => client.dailyFeatured(), (error: unknown) =>
    error instanceof TmdbError && error.code === "INVALID_RESPONSE");
});
