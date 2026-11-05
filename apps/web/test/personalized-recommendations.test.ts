import assert from "node:assert/strict";
import test from "node:test";
import type { EditorialRecommendation, EditorialTitleResponse } from "@cebola/contracts";
import {
  loadPersonalizedRecommendations,
  type RecommendationSignal
} from "../app/personalized-recommendations.js";

function recommendation(tmdbId: number, title: string, type: "movie" | "series", voteAverage: number): EditorialRecommendation {
  return {
    tmdbId, type, title, year: 2020, overview: null, posterUrl: `https://image.test/${tmdbId}.jpg`,
    backdropUrl: null, voteAverage
  };
}

function title(input: {
  id: number;
  name: string;
  type?: "movie" | "series";
  genres?: string[];
  directors?: string[];
  creators?: string[];
  rating?: number;
  votes?: number;
  recommendations?: EditorialRecommendation[];
}): EditorialTitleResponse {
  const type = input.type ?? "series";
  return {
    tmdbId: input.id, imdbId: null, type, title: input.name, originalTitle: null, tagline: null,
    overview: `${input.name}.`, releaseDate: "2020-01-01", year: 2020, runtimeMinutes: 45,
    genres: input.genres ?? [], countries: [], originalLanguage: "en", spokenLanguages: [],
    directors: input.directors ?? [], creators: input.creators ?? [], cast: [],
    voteAverage: input.rating ?? 7, voteCount: input.votes ?? 1_000,
    posterUrl: `https://image.test/${input.id}.jpg`, backdropUrl: null, logoUrl: null,
    trailerUrl: null, tmdbUrl: `https://www.themoviedb.org/${type === "movie" ? "movie" : "tv"}/${input.id}`,
    availability: { subscription: [], free: [], ads: [], rent: [], buy: [], link: null },
    recommendations: input.recommendations ?? [],
    attribution: { tmdbNotice: "Teste", providersSource: "JustWatch" }
  };
}

test("prioriza obra relacionada com criador, gênero e qualidade compatíveis", async () => {
  const seed = title({
    id: 1, name: "Friends", genres: ["Comédia"], creators: ["Criador recorrente"], rating: 8.4,
    recommendations: [
      recommendation(2, "Comédia bem relacionada", "series", 8.5),
      recommendation(3, "Comédia fraca", "series", 5.6)
    ]
  });
  const good = title({ id: 2, name: "Comédia bem relacionada", genres: ["Comédia"], creators: ["Criador recorrente"], rating: 8.5, votes: 20_000 });
  const weak = title({ id: 3, name: "Comédia fraca", genres: ["Comédia"], rating: 5.6, votes: 40 });
  const byId = new Map([["tmdb:1", seed], ["tmdb:2", good], ["tmdb:3", weak]]);
  const signals: RecommendationSignal[] = [{
    lookup: { type: "series", mediaId: "tmdb:1", title: "Friends", year: 2020 }, weight: 4, origin: "watched"
  }];

  const result = await loadPersonalizedRecommendations(signals, async (lookup) => byId.get(lookup.mediaId) ?? null);
  assert.deepEqual(result.map((item) => item.tmdbId), [2, 3]);
  assert.equal(result[0]?.reason, "Baseado em você ter assistido Friends");
  assert.equal(result.some((item) => item.tmdbId === 1), false);
});

test("permite anime quando ele nasce de uma semente real do perfil", async () => {
  const anime = title({
    id: 10, name: "Anime assistido", genres: ["Animação"],
    recommendations: [recommendation(11, "Anime relacionado", "series", 8.2)]
  });
  const related = title({ id: 11, name: "Anime relacionado", genres: ["Animação"], rating: 8.2 });
  const result = await loadPersonalizedRecommendations([{
    lookup: { type: "series", mediaId: "tmdb:10", title: "Anime assistido" }, weight: 4, origin: "watched"
  }], async (lookup) => lookup.mediaId === "tmdb:10" ? anime : related);

  assert.equal(result[0]?.title, "Anime relacionado");
});
