import { z } from "zod";
import {
  dailyFeaturedResponseSchema,
  editorialHomeResponseSchema,
  editorialTitleResponseSchema,
  emmyWinnersResponseSchema,
  type DailyFeaturedResponse,
  type EditorialProvider,
  type EditorialHomeRail,
  type EditorialHomeResponse,
  type EditorialRecommendation,
  type EditorialSection,
  type EditorialTitleResponse,
  type EmmyWinnersResponse,
  type MediaType
} from "@cebola/contracts";

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_URL = "https://image.tmdb.org/t/p";
const TMDB_NOTICE = "This product uses the TMDB API but is not endorsed or certified by TMDB.";
const RESPONSE_LIMIT_BYTES = 3_000_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const MAX_CACHE_ENTRIES = 500;

const nullableText = z.string().nullable().optional();
const nullablePath = z.string().nullable().optional();

const searchItemSchema = z.object({ id: z.number().int().positive() });
const findResponseSchema = z.object({
  movie_results: z.array(searchItemSchema).default([]),
  tv_results: z.array(searchItemSchema).default([])
});
const searchResponseSchema = z.object({ results: z.array(searchItemSchema).default([]) });

const trendingMovieItemSchema = z.object({
  id: z.number().int().positive(),
  title: nullableText,
  name: nullableText,
  overview: nullableText,
  backdrop_path: nullablePath,
  poster_path: nullablePath
});
const trendingResponseSchema = z.object({
  results: z.array(trendingMovieItemSchema).default([])
});

const discoveryItemSchema = trendingMovieItemSchema.extend({
  release_date: nullableText,
  first_air_date: nullableText,
  vote_average: z.number().min(0).max(10).optional(),
  // Os três campos que identificam anime. `/discover` devolve gêneros como ids, e só a busca
  // de TV traz `origin_country` — em filme, quem sobra é o idioma original.
  genre_ids: z.array(z.number().int()).default([]),
  origin_country: z.array(z.string()).default([]),
  original_language: nullableText
});
const discoveryResponseSchema = z.object({ results: z.array(discoveryItemSchema).default([]) });

const videoItemSchema = z.object({
  key: z.string(),
  site: z.string(),
  type: z.string()
});
const movieVideosResponseSchema = z.object({
  results: z.array(videoItemSchema).default([])
});

const recommendationItemSchema = z.object({
  id: z.number().int().positive(),
  title: nullableText,
  name: nullableText,
  release_date: nullableText,
  first_air_date: nullableText,
  overview: nullableText,
  poster_path: nullablePath,
  backdrop_path: nullablePath,
  vote_average: z.number().min(0).max(10).optional()
});

const detailsResponseSchema = z.object({
  id: z.number().int().positive(),
  imdb_id: nullableText,
  title: nullableText,
  name: nullableText,
  original_title: nullableText,
  original_name: nullableText,
  tagline: nullableText,
  overview: nullableText,
  release_date: nullableText,
  first_air_date: nullableText,
  runtime: z.number().int().positive().nullable().optional(),
  episode_run_time: z.array(z.number().int().positive()).optional(),
  genres: z.array(z.object({ name: z.string() })).default([]),
  production_countries: z.array(z.object({ name: z.string() })).default([]),
  origin_country: z.array(z.string()).default([]),
  original_language: nullableText,
  spoken_languages: z.array(z.object({
    english_name: nullableText,
    name: nullableText
  })).default([]),
  vote_average: z.number().min(0).max(10).optional(),
  vote_count: z.number().int().min(0).default(0),
  poster_path: nullablePath,
  backdrop_path: nullablePath,
  created_by: z.array(z.object({ name: z.string() })).default([]),
  credits: z.object({
    crew: z.array(z.object({ name: z.string(), job: z.string() })).default([]),
    cast: z.array(z.object({
      id: z.number().int().positive(),
      name: z.string(),
      character: nullableText,
      profile_path: nullablePath,
      order: z.number().int().min(0).optional()
    })).default([])
  }).optional(),
  videos: z.object({
    results: z.array(z.object({
      key: z.string(),
      site: z.string(),
      type: z.string(),
      official: z.boolean().optional()
    })).default([])
  }).optional(),
  recommendations: z.object({ results: z.array(recommendationItemSchema).default([]) }).optional(),
  similar: z.object({ results: z.array(recommendationItemSchema).default([]) }).optional(),
  external_ids: z.object({ imdb_id: nullableText }).optional(),
  release_dates: z.object({
    results: z.array(z.object({
      release_dates: z.array(z.object({ type: z.number().int(), release_date: z.string() })).default([])
    })).default([])
  }).optional(),
  images: z.object({
    logos: z.array(z.object({
      file_path: nullablePath,
      iso_639_1: nullableText,
      aspect_ratio: z.number().optional(),
      vote_average: z.number().optional()
    })).default([])
  }).optional()
});

const providerSchema = z.object({
  provider_id: z.number().int().positive(),
  provider_name: z.string(),
  logo_path: nullablePath,
  display_priority: z.number().int().optional()
});
const providerRegionSchema = z.object({
  link: nullableText,
  flatrate: z.array(providerSchema).default([]),
  free: z.array(providerSchema).default([]),
  ads: z.array(providerSchema).default([]),
  rent: z.array(providerSchema).default([]),
  buy: z.array(providerSchema).default([])
});
const providersResponseSchema = z.object({
  results: z.record(z.string(), providerRegionSchema).default({})
});

/**
 * O TMDB é de fora, e o contrato é nosso: qualquer campo fora do esperado (título gigante, id de
 * vídeo com formato estranho) fazia `parse` lançar um ZodError cru, que a rota não reconhece e
 * o Fastify transforma em 500. Traduzir para TmdbError mantém a resposta em 502 com mensagem
 * própria, e o log continua dizendo que a origem foi o TMDB.
 */
function conform<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new TmdbError("INVALID_RESPONSE", "O TMDB devolveu dados fora do contrato.");
  }
  return parsed.data;
}

export class TmdbError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "UPSTREAM_UNAVAILABLE" | "INVALID_RESPONSE",
    message: string
  ) {
    super(message);
    this.name = "TmdbError";
  }
}

interface TmdbClientOptions {
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

interface EditorialLookup {
  readonly type: MediaType;
  readonly mediaId: string;
  readonly title?: string;
  readonly year?: number;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly value: EditorialTitleResponse;
}

/** Gênero "Animação" no TMDB. */
const TMDB_GENERO_ANIMACAO = 16;

/**
 * Família (10751) e Kids/TV (10762). O Início e as fileiras de provedor ordenam por
 * popularidade, e desenho e pré-escolar lideram a popularidade no TMDB — sem excluí-los, eles
 * tomam conta de "O que está em alta" e das trilhas de cada streaming. Anime é tratado à parte
 * (ver `ehAnime`) e continua fora deste filtro, porque tem suas próprias fileiras.
 */
const GENEROS_INFANTIS: readonly number[] = [10751, 10762];

interface EmmyCuratedWinner {
  readonly type: MediaType;
  readonly title: string;
  readonly year: number;
  readonly categories: readonly string[];
}

/**
 * Curadoria dos vencedores do Emmy. Não existe API de premiações, então esta lista é mantida à
 * mão — mas na API, e não no bundle web (como o `award-badges`): assim, para publicar o Emmy 2027,
 * basta trocar `EMMY_EDITION`/`EMMY_CERIMONIA` e esta lista, e o app recebe na hora, sem
 * republicação. A arte, a sinopse e a nota saem do mesmo pipeline dos detalhes (`title`),
 * resolvidos por título + ano no TMDB.
 */
const EMMY_EDITION = 2026;
const EMMY_CERIMONIA = "Emmy 2026";
const EMMY_WINNERS: readonly EmmyCuratedWinner[] = [
  {
    type: "series",
    title: "The Pitt",
    year: 2025,
    categories: ["Melhor Série Dramática", "Melhor Ator: Noah Wyle", "Melhor Ator Convidado"]
  },
  {
    type: "series",
    title: "Widow's Bay",
    year: 2026,
    categories: [
      "Melhor Comédia",
      "Melhor Direção",
      "Melhor Roteiro",
      "Melhor Ator: Matthew Rhys",
      "Ator Coadjuvante",
      "Atriz Coadjuvante",
      "Atriz Convidada"
    ]
  },
  {
    type: "series",
    title: "DTF St. Louis",
    year: 2026,
    categories: [
      "Melhor Minissérie",
      "Melhor Direção",
      "Melhor Roteiro",
      "Ator Coadjuvante: David Harbour",
      "Atriz Coadjuvante: Linda Cardellini"
    ]
  }
];

/**
 * Anime é animação japonesa, e as duas condições importam.
 *
 * Só o gênero derrubaria Os Simpsons, Batman: A Série Animada e Avatar — animação ocidental,
 * que a regra do catálogo não pede para tirar. Só a origem derrubaria dorama e tokusatsu, que
 * não são anime. É a mesma dupla condição com que as fontes `anime-*` SELECIONAM anime
 * (`with_genres=16` + `with_origin_country=JP`); aqui ela apenas é usada ao contrário.
 *
 * Em filme o TMDB não devolve `origin_country` na busca, só `original_language`: é o melhor
 * sinal disponível sem uma segunda viagem por título.
 */
function ehAnime(item: {
  readonly genre_ids?: readonly number[];
  readonly origin_country?: readonly string[];
  readonly original_language?: string | null;
}): boolean {
  if (!item.genre_ids?.includes(TMDB_GENERO_ANIMACAO)) return false;
  return item.origin_country?.includes("JP") === true || item.original_language === "ja";
}

/**
 * Conteúdo dirigido a crianças: gênero Família ou Kids. Ver `GENEROS_INFANTIS`. O `without_genres`
 * enviado à busca já resolve `/discover`; este filtro cobre também `/trending`, que ignora aquele
 * parâmetro e é a fonte dos "top 10 da semana".
 */
function ehInfantil(item: { readonly genre_ids?: readonly number[] }): boolean {
  return item.genre_ids?.some((id) => GENEROS_INFANTIS.includes(id)) === true;
}

interface EditorialSource {
  readonly id: string;
  readonly title: string;
  readonly type: MediaType;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly limit?: number;
  readonly provider?: EditorialProvider;
  /**
   * Tira anime desta fonte. Ver `ehAnime`. Existe porque `docs/REGRAS_DE_CATALOGO.md` diz que
   * anime não aparece no Início, e nada no código fazia isso valer: ordenar séries por nota
   * enche a lista de anime clássico, e Slam Dunk acabava colado em "A Grande Família" na
   * fileira Clássicos.
   */
  readonly semAnime?: boolean;
}

function imageUrl(path: string | null | undefined, size: "w185" | "w500" | "w1280" | "original"): string | null {
  if (!path || !/^\/[A-Za-z0-9._/-]+$/.test(path)) return null;
  return `${TMDB_IMAGE_URL}/${size}${path}`;
}

/**
 * O contrato só aceita id de vídeo do YouTube no formato real. Descartar um valor estranho é
 * melhor do que deixar `conform` derrubar o destaque inteiro por causa do trailer: sem trailer
 * a tela ainda tem a cena parada; sem destaque ela não tem nada.
 */
function youtubeKey(value: string | null | undefined): string | null {
  return value && /^[A-Za-z0-9_-]{5,20}$/.test(value) ? value : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function yearFromDate(value: string | null | undefined): number | null {
  const match = value?.match(/^(\d{4})-/);
  return match ? Number(match[1]) : null;
}

function unique(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.flatMap((value) => {
    const normalized = nonEmpty(value);
    return normalized ? [normalized] : [];
  }))];
}

function toProvider(provider: z.infer<typeof providerSchema>): EditorialProvider {
  return {
    id: provider.provider_id,
    name: provider.provider_name,
    logoUrl: imageUrl(provider.logo_path, "w185")
  };
}

function mergeRecommendations(
  type: MediaType,
  primary: readonly z.infer<typeof recommendationItemSchema>[],
  fallback: readonly z.infer<typeof recommendationItemSchema>[]
): EditorialRecommendation[] {
  const uniqueItems = new Map<number, z.infer<typeof recommendationItemSchema>>();
  for (const item of [...primary, ...fallback]) uniqueItems.set(item.id, item);
  return [...uniqueItems.values()].slice(0, 20).flatMap((item) => {
    const title = nonEmpty(item.title ?? item.name);
    if (!title) return [];
    const date = item.release_date ?? item.first_air_date;
    return [{
      tmdbId: item.id,
      type,
      title,
      year: yearFromDate(date),
      overview: nonEmpty(item.overview),
      posterUrl: imageUrl(item.poster_path, "w500"),
      // Fundos cobrem a tela inteira. `w1280` era uma miniatura para o desktop atual (e ainda
      // mais insuficiente em uma TV), que o CSS acabava ampliando. O CDN do TMDB mantém cache e
      // entrega a arte original; os cartazes e avatares continuam usando tamanhos proporcionais.
      backdropUrl: imageUrl(item.backdrop_path, "original"),
      backdropPreviewUrl: imageUrl(item.backdrop_path, "w1280"),
      voteAverage: typeof item.vote_average === "number" ? item.vote_average : null
    }];
  });
}

function belongsToEditorialSection(id: string, section: EditorialSection): boolean {
  if (section === "movies") return id.startsWith("movies-") || id.startsWith("provider-movie-");
  if (section === "series") return id.startsWith("series-") || id.startsWith("provider-series-");
  if (section === "documentaries") return id.startsWith("documentaries-");
  if (section === "anime") return id.startsWith("anime-") || id.startsWith("provider-anime-");
  if (section === "brazil") return id.startsWith("brazil-");
  return (
    id === "movies-trending" || id === "movies-new" || id === "movies-classics" ||
    id === "series-trending" || id === "series-new" || id === "series-classics" ||
    id.startsWith("brazil-") || id.startsWith("provider-movie-") || id.startsWith("provider-series-")
  );
}

function combineHomeRail(
  rails: readonly EditorialHomeRail[],
  id: string,
  title: string,
  sourceIds: readonly string[]
): EditorialHomeRail {
  const sources = sourceIds.flatMap((sourceId) => rails.filter((rail) => rail.id === sourceId));
  const seen = new Set<string>();
  const items: EditorialHomeRail["items"][number][] = [];
  for (let index = 0; index < 20 && items.length < 20; index += 1) {
    for (const source of sources) {
      const item = source.items[index];
      const key = item ? `${item.type}:${item.tmdbId}` : "";
      if (!item || seen.has(key)) continue;
      seen.add(key);
      items.push(item);
      if (items.length === 20) break;
    }
  }
  return { id, title, provider: null, items };
}

function compactHomeRails(rails: readonly EditorialHomeRail[]): readonly EditorialHomeRail[] {
  const visible = [
    combineHomeRail(rails, "home-new", "Recém-chegados para descobrir", ["movies-new", "series-new", "brazil-new-movies", "brazil-new-series"]),
    combineHomeRail(rails, "home-trending", "O que está em alta agora", ["movies-trending", "series-trending", "brazil-top10-movies", "brazil-top10-series"]),
    combineHomeRail(rails, "home-classics", "Clássicos que você não pode perder", ["movies-classics", "series-classics", "brazil-classics-movies", "brazil-classics-series"])
  ].filter((rail) => rail.items.length > 0);
  const spotlight = rails
    .filter((rail) => rail.id.startsWith("provider-movie-") || rail.id.startsWith("provider-series-"))
    .map((rail) => ({ ...rail, items: rail.items.slice(0, 2) }));
  return [...visible, ...spotlight];
}

export class TmdbClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<EditorialTitleResponse>>();
  private dailyFeaturedCache: { expiresAt: number; value: DailyFeaturedResponse } | null = null;
  private pendingDailyFeatured: Promise<DailyFeaturedResponse> | null = null;
  private emmyCache: { expiresAt: number; value: EmmyWinnersResponse } | null = null;
  private pendingEmmy: Promise<EmmyWinnersResponse> | null = null;
  // Chaveados por `seção:página`. O "+ Ver mais" da home pede a página seguinte sob demanda,
  // então cada página tem vida própria no cache — a primeira carga continua pedindo só a 1.
  private readonly homeCache = new Map<string, { expiresAt: number; value: EditorialHomeResponse }>();
  private readonly pendingHome = new Map<string, Promise<EditorialHomeResponse>>();
  private readonly homeSourceCache = new Map<string, { expiresAt: number; value: EditorialHomeRail }>();
  private readonly pendingHomeSource = new Map<string, Promise<EditorialHomeRail>>();

  constructor(private readonly options: TmdbClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async dailyFeatured(): Promise<DailyFeaturedResponse> {
    if (this.dailyFeaturedCache && this.dailyFeaturedCache.expiresAt > this.now()) {
      return this.dailyFeaturedCache.value;
    }
    if (this.pendingDailyFeatured) return this.pendingDailyFeatured;

    const request = this.loadDailyFeatured().then((value) => {
      const nextDay = new Date(this.now());
      nextDay.setUTCHours(23, 59, 59, 999);
      const ttl = Math.max(CACHE_TTL_MS, nextDay.getTime() - this.now());
      this.dailyFeaturedCache = { expiresAt: this.now() + ttl, value };
      return value;
    }).finally(() => {
      this.pendingDailyFeatured = null;
    });

    this.pendingDailyFeatured = request;
    return request;
  }

  async emmy(): Promise<EmmyWinnersResponse> {
    if (this.emmyCache && this.emmyCache.expiresAt > this.now()) return this.emmyCache.value;
    if (this.pendingEmmy) return this.pendingEmmy;

    const request = this.loadEmmy().then((value) => {
      this.emmyCache = { expiresAt: this.now() + CACHE_TTL_MS, value };
      return value;
    }).finally(() => {
      this.pendingEmmy = null;
    });

    this.pendingEmmy = request;
    return request;
  }

  private async loadEmmy(): Promise<EmmyWinnersResponse> {
    // Cada vencedor é resolvido pelo mesmo caminho dos detalhes (título + ano). Um que não
    // resolva (ainda sem página no TMDB, por exemplo) apenas fica de fora — a fileira não cai.
    const settled = await Promise.allSettled(EMMY_WINNERS.map(async (winner) => {
      const detail = await this.title({
        type: winner.type,
        mediaId: `emmy:${winner.type}:${winner.title}`,
        title: winner.title,
        year: winner.year
      });
      return {
        tmdbId: detail.tmdbId,
        type: detail.type,
        title: detail.title,
        year: detail.year,
        overview: detail.overview,
        posterUrl: detail.posterUrl,
        backdropUrl: detail.backdropUrl,
        backdropPreviewUrl: detail.backdropUrl,
        voteAverage: detail.voteAverage,
        categories: [...winner.categories]
      };
    }));
    const winners = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    return conform(emmyWinnersResponseSchema, {
      edition: EMMY_EDITION,
      ceremonyName: EMMY_CERIMONIA,
      generatedAt: new Date(this.now()).toISOString(),
      winners,
      attribution: { tmdbNotice: TMDB_NOTICE }
    });
  }

  async home(section: EditorialSection = "home", page = 1, group: "all" | "primary" | "providers" = "all"): Promise<EditorialHomeResponse> {
    const key = `${section}:${page}:${group}`;
    const cached = this.homeCache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    const pending = this.pendingHome.get(key);
    if (pending) return pending;
    const request = this.loadHome(section, page, group).then((value) => {
      this.homeCache.set(key, { expiresAt: this.now() + CACHE_TTL_MS, value });
      return value;
    }).finally(() => { this.pendingHome.delete(key); });
    this.pendingHome.set(key, request);
    return request;
  }

  private async loadHome(section: EditorialSection, page = 1, group: "all" | "primary" | "providers" = "all"): Promise<EditorialHomeResponse> {
    const currentYear = new Date(this.now()).getUTCFullYear();
    const sources: readonly EditorialSource[] = [
      { id: "movies-top10", title: "Os filmes mais assistidos da semana", type: "movie" as const, path: "/trending/movie/week", query: {}, limit: 10 , semAnime: true },
      { id: "movies-trending", title: "Filmes para entrar na conversa", type: "movie" as const, path: "/discover/movie", query: { sort_by: "popularity.desc", "primary_release_date.lte": `${currentYear}-12-31` } , semAnime: true },
      { id: "movies-new", title: "Novos filmes para descobrir", type: "movie" as const, path: "/discover/movie", query: { sort_by: "popularity.desc", "primary_release_date.gte": `${currentYear - 2}-01-01` } , semAnime: true },
      { id: "movies-classics", title: "Filmes que você precisa ver", type: "movie" as const, path: "/discover/movie", query: { sort_by: "vote_average.desc", "vote_count.gte": "1000", "primary_release_date.lte": "1999-12-31" } , semAnime: true },
      { id: "series-top10", title: "As séries mais assistidas da semana", type: "series" as const, path: "/trending/tv/week", query: {}, limit: 10 , semAnime: true },
      { id: "series-trending", title: "Séries para entrar na conversa", type: "series" as const, path: "/discover/tv", query: { sort_by: "popularity.desc", "first_air_date.lte": `${currentYear}-12-31` } , semAnime: true },
      { id: "series-new", title: "Novas séries para descobrir", type: "series" as const, path: "/discover/tv", query: { sort_by: "popularity.desc", "first_air_date.gte": `${currentYear - 2}-01-01` } , semAnime: true },
      { id: "series-classics", title: "Séries que você precisa conhecer", type: "series" as const, path: "/discover/tv", query: { sort_by: "vote_average.desc", "vote_count.gte": "500", "first_air_date.lte": "2005-12-31" } , semAnime: true },
      { id: "documentaries-top10-movies", title: "Top 10 documentários em alta", type: "movie" as const, path: "/discover/movie", query: { sort_by: "popularity.desc", with_genres: "99" }, limit: 10 },
      { id: "documentaries-trending-movies", title: "Documentários em destaque", type: "movie" as const, path: "/discover/movie", query: { sort_by: "popularity.desc", with_genres: "99" } },
      { id: "documentaries-new-movies", title: "Documentários recém-chegados", type: "movie" as const, path: "/discover/movie", query: { sort_by: "primary_release_date.desc", with_genres: "99", "primary_release_date.gte": `${currentYear - 2}-01-01` } },
      { id: "documentaries-classics-movies", title: "Documentários para guardar na memória", type: "movie" as const, path: "/discover/movie", query: { sort_by: "vote_average.desc", with_genres: "99", "vote_count.gte": "100", "primary_release_date.lte": "2015-12-31" } },
      { id: "documentaries-top10-series", title: "Top 10 séries documentais em alta", type: "series" as const, path: "/discover/tv", query: { sort_by: "popularity.desc", with_genres: "99" }, limit: 10 },
      { id: "documentaries-trending-series", title: "Séries documentais em destaque", type: "series" as const, path: "/discover/tv", query: { sort_by: "popularity.desc", with_genres: "99" } },
      { id: "documentaries-new-series", title: "Séries documentais recém-chegadas", type: "series" as const, path: "/discover/tv", query: { sort_by: "first_air_date.desc", with_genres: "99", "first_air_date.gte": `${currentYear - 2}-01-01` } },
      { id: "anime-top10", title: "Top 10 animes em alta", type: "series" as const, path: "/discover/tv", query: { sort_by: "popularity.desc", with_genres: "16", with_origin_country: "JP" }, limit: 10 },
      { id: "anime-trending", title: "Animes em alta", type: "series" as const, path: "/discover/tv", query: { sort_by: "popularity.desc", with_genres: "16", with_origin_country: "JP", "first_air_date.gte": `${currentYear - 2}-01-01` } },
      { id: "anime-classics", title: "Animes clássicos", type: "series" as const, path: "/discover/tv", query: { sort_by: "vote_average.desc", with_genres: "16", with_origin_country: "JP", "vote_count.gte": "100", "first_air_date.lte": "2005-12-31" } },
      { id: "brazil-top10-movies", title: "Top 10 filmes brasileiros em alta", type: "movie" as const, path: "/discover/movie", query: { sort_by: "popularity.desc", with_origin_country: "BR" }, limit: 10 },
      { id: "brazil-new-movies", title: "Filmes brasileiros novos", type: "movie" as const, path: "/discover/movie", query: { sort_by: "popularity.desc", with_origin_country: "BR", "primary_release_date.gte": `${currentYear - 2}-01-01` } },
      { id: "brazil-classics-movies", title: "Clássicos do cinema brasileiro", type: "movie" as const, path: "/discover/movie", query: { sort_by: "vote_average.desc", with_origin_country: "BR", "vote_count.gte": "50", "primary_release_date.lte": "2005-12-31" } },
      { id: "brazil-top10-series", title: "Top 10 séries brasileiras em alta", type: "series" as const, path: "/discover/tv", query: { sort_by: "popularity.desc", with_origin_country: "BR" }, limit: 10 },
      { id: "brazil-new-series", title: "Séries brasileiras novas", type: "series" as const, path: "/discover/tv", query: { sort_by: "popularity.desc", with_origin_country: "BR", "first_air_date.gte": `${currentYear - 2}-01-01` } },
      { id: "brazil-classics-series", title: "Séries brasileiras clássicas", type: "series" as const, path: "/discover/tv", query: { sort_by: "vote_average.desc", with_origin_country: "BR", "vote_count.gte": "30", "first_air_date.lte": "2005-12-31" } },
      ...([
        { slug: "netflix", id: 8, name: "Netflix" },
        { slug: "max", id: 1899, name: "Max" },
        { slug: "prime", id: 119, name: "Prime Video" },
        { slug: "disney", id: 337, name: "Disney Plus" },
        { slug: "paramount", id: 531, name: "Paramount Plus" },
        { slug: "apple", id: 350, name: "Apple TV Plus" },
        { slug: "globoplay", id: 307, name: "Globoplay" }
      ] as const).flatMap((provider) => (["movie", "series"] as const).map((type) => ({
        id: `provider-${type}-${provider.slug}`,
        title: `${type === "movie" ? "Filmes" : "Séries"} para ver na ${provider.name}`,
        type,
        path: type === "movie" ? "/discover/movie" : "/discover/tv",
        query: {
          sort_by: "popularity.desc",
          watch_region: "BR",
          with_watch_monetization_types: "flatrate",
          with_watch_providers: String(provider.id)
        },
        provider: { id: provider.id, name: provider.name, logoUrl: null }
      }))),
      ...([
        { slug: "crunchyroll", id: 283, name: "Crunchyroll" },
        { slug: "netflix", id: 8, name: "Netflix" },
        { slug: "prime", id: 119, name: "Prime Video" }
      ] as const).map((provider) => ({
        id: `provider-anime-${provider.slug}`,
        title: `Animes na ${provider.name}`,
        type: "series" as const,
        path: "/discover/tv",
        query: {
          sort_by: "popularity.desc",
          watch_region: "BR",
          with_watch_monetization_types: "flatrate",
          with_watch_providers: String(provider.id),
          with_genres: "16",
          with_origin_country: "JP"
        },
        provider: { id: provider.id, name: provider.name, logoUrl: null }
      }))
    ];
    const selectedSources = sources.filter((source) => belongsToEditorialSection(source.id, section) &&
      (group === "all" || source.id.startsWith("provider-") === (group === "providers")));
    const settled = await Promise.allSettled(selectedSources.map((source) => this.loadHomeSource(source, page)));
    const loaded = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (loaded.length === 0 && selectedSources.length > 0) {
      throw new TmdbError("UPSTREAM_UNAVAILABLE", "Os catálogos editoriais estão temporariamente indisponíveis.");
    }
    const rails = loaded.filter((rail) => rail.items.length > 0);
    return conform(editorialHomeResponseSchema, {
      generatedAt: new Date(this.now()).toISOString(),
      rails: section === "home" ? compactHomeRails(rails) : rails,
      attribution: { tmdbNotice: TMDB_NOTICE }
    });
  }

  private async loadHomeSource(source: EditorialSource, page = 1): Promise<EditorialHomeRail> {
    const key = `${source.id}:${page}`;
    const cached = this.homeSourceCache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    const pending = this.pendingHomeSource.get(key);
    if (pending) return pending;

    // Conteúdo infantil fica fora de tudo, menos das trilhas de anime (que têm curadoria própria).
    const semInfantil = !source.id.includes("anime");
    const request = this.request(source.path, discoveryResponseSchema, {
      language: "pt-BR",
      include_adult: "false",
      page: String(page),
      // `/discover` já volta filtrado e cheio; o `ehInfantil` abaixo cobre `/trending`, que
      // ignora este parâmetro. Vem antes de `source.query` para a fonte poder sobrepor se preciso.
      ...(semInfantil ? { without_genres: GENEROS_INFANTIS.join(",") } : {}),
      ...source.query
    }).then((response) => {
      const value: EditorialHomeRail = {
        id: source.id,
        title: source.title,
        provider: source.provider ?? null,
        items: mergeRecommendations(
          source.type,
          (response.results ?? []).filter((item) =>
            (!source.semAnime || !ehAnime(item)) && (!semInfantil || !ehInfantil(item))
          ),
          []
        )
          .filter((item) => item.posterUrl || item.backdropUrl)
          .slice(0, source.limit ?? 20)
      };
      this.homeSourceCache.set(key, { expiresAt: this.now() + CACHE_TTL_MS, value });
      return value;
    }).finally(() => {
      this.pendingHomeSource.delete(key);
    });
    this.pendingHomeSource.set(key, request);
    return request;
  }

  private async loadDailyFeatured(): Promise<DailyFeaturedResponse> {
    // Em alta NA SEMANA, não no dia: o destaque do login é uma cena de cinema, e a lista diária
    // troca cedo demais para isso — no meio da tarde já era outro filme. A semana também tem
    // muito mais chance de o título ter trailer publicado, que é o que a tela realmente usa.
    // language=pt-BR porque a sinopse aparece para o usuário; sem isso o TMDB devolve inglês.
    const trending = await this.request("/trending/movie/week", trendingResponseSchema, {
      language: "pt-BR"
    });
    let fallback: {
      id: string;
      title: string;
      subtitle: string;
      backdropUrl: string;
      backdropPreviewUrl: string;
      movie: z.infer<typeof trendingMovieItemSchema>;
    } | null = null;

    for (const movie of (trending.results ?? []).slice(0, 8)) {
      if (!movie.backdrop_path) continue;
      const title = nonEmpty(movie.title ?? movie.name);
      if (!title) continue;
      const subtitle = nonEmpty(movie.overview) ??
        "Assista aos melhores filmes, séries e animes em alta definição.";

      let trailerKey: string | null = null;
      try {
        const videoRes = await this.request(`/movie/${movie.id}/videos`, movieVideosResponseSchema, {
          language: "pt-BR"
        });
        const trailer = (videoRes.results ?? []).find((v) =>
          v.site === "YouTube" && (v.type === "Trailer" || v.type === "Teaser") && youtubeKey(v.key));
        if (trailer) {
          trailerKey = youtubeKey(trailer.key);
        } else {
          const videoEnRes = await this.request(`/movie/${movie.id}/videos`, movieVideosResponseSchema, {
            language: "en-US"
          });
          const trailerEn = (videoEnRes.results ?? []).find((v) =>
            v.site === "YouTube" && (v.type === "Trailer" || v.type === "Teaser") && youtubeKey(v.key));
          if (trailerEn) trailerKey = youtubeKey(trailerEn.key);
        }
      } catch {
        // Fallback with null trailerKey if videos fail
      }

      const backdropUrl = imageUrl(movie.backdrop_path, "original");
      const backdropPreviewUrl = imageUrl(movie.backdrop_path, "w1280");
      // Sem arte utilizável não há destaque: `parse` rejeitaria a URL vazia com um ZodError
      // cru, que a rota não trata e vira 500. Seguir para o próximo filme é o comportamento
      // certo, e é o mesmo que já se faz quando falta título.
      if (!backdropUrl || !backdropPreviewUrl) continue;
      // A tela de login mostra uma CENA, então um destaque sem trailer não serve para nada.
      // Procurar o próximo custa uma chamada barata — e o resultado fica 6 h em cache.
      if (!trailerKey && !fallback) {
        fallback = { id: String(movie.id), title, subtitle, backdropUrl, backdropPreviewUrl, movie };
        continue;
      }
      if (!trailerKey) continue;

      return conform(dailyFeaturedResponseSchema, {
        id: String(movie.id),
        title,
        subtitle,
        backdropUrl,
        backdropPreviewUrl,
        posterUrl: imageUrl(movie.poster_path, "w500"),
        trailerKey
      });
    }

    // Nenhum dos filmes em alta tem trailer: melhor uma cena parada do primeiro deles do que
    // devolver 404 e deixar a tela de login sem fundo nenhum.
    if (fallback) {
      return conform(dailyFeaturedResponseSchema, {
        id: fallback.id,
        title: fallback.title,
        subtitle: fallback.subtitle,
        backdropUrl: fallback.backdropUrl,
        backdropPreviewUrl: fallback.backdropPreviewUrl,
        posterUrl: imageUrl(fallback.movie.poster_path, "w500"),
        trailerKey: null
      });
    }

    throw new TmdbError("NOT_FOUND", "Nenhum filme em destaque encontrado no TMDB.");
  }

  async title(lookup: EditorialLookup): Promise<EditorialTitleResponse> {
    const cacheKey = JSON.stringify(lookup);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    this.cache.delete(cacheKey);
    const existing = this.pending.get(cacheKey);
    if (existing) return existing;

    const request = this.loadTitle(lookup).then((value) => {
      if (this.cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = this.cache.keys().next().value as string | undefined;
        if (oldest) this.cache.delete(oldest);
      }
      this.cache.set(cacheKey, { expiresAt: this.now() + CACHE_TTL_MS, value });
      return value;
    }).finally(() => this.pending.delete(cacheKey));
    this.pending.set(cacheKey, request);
    return request;
  }

  private async loadTitle(lookup: EditorialLookup): Promise<EditorialTitleResponse> {
    const tmdbType = lookup.type === "movie" ? "movie" : "tv";
    const tmdbId = await this.resolveId(lookup, tmdbType);
    const append = "credits,videos,recommendations,similar,external_ids,images" + (tmdbType === "movie" ? ",release_dates" : "");
    const [details, providers] = await Promise.all([
      this.request(`/${tmdbType}/${tmdbId}`, detailsResponseSchema, {
        language: "pt-BR",
        append_to_response: append,
        include_image_language: "pt-BR,pt,en,null"
      }),
      this.request(`/${tmdbType}/${tmdbId}/watch/providers`, providersResponseSchema)
    ]);

    const title = nonEmpty(details.title ?? details.name);
    if (!title) throw new TmdbError("INVALID_RESPONSE", "O TMDB não devolveu o título.");
    const releaseDate = nonEmpty(details.release_date ?? details.first_air_date);
    const region = (providers.results ?? {}).BR;
    const videos = details.videos?.results ?? [];
    const trailer = videos.find((video) =>
      video.site === "YouTube" && video.type === "Trailer" && video.official === true
    ) ?? videos.find((video) => video.site === "YouTube" && video.type === "Trailer");
    const runtime = details.runtime ?? details.episode_run_time?.find((value) => value > 0) ?? null;
    // Tipos 4, 5 e 6 do TMDB: digital, disco e TV. Antes da primeira delas em qualquer país, um
    // "WEB-DL" com o nome do filme é outro filme (ver `source-match.ts` na web).
    const homeReleaseDate = (details.release_dates?.results ?? [])
      .flatMap((country) => country.release_dates)
      .filter((release) => release.type >= 4)
      .map((release) => release.release_date.slice(0, 10))
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
      .sort()[0] ?? null;
    const directors = unique((details.credits?.crew ?? [])
      .filter((member) => member.job === "Director")
      .map((member) => member.name) ?? []);
    const originalTitle = nonEmpty(details.original_title ?? details.original_name);
    const imdbId = nonEmpty(details.imdb_id ?? details.external_ids?.imdb_id);

    const logos = details.images?.logos ?? [];
    const ptLogo = logos.find((logo) => logo.iso_639_1 === "pt" || logo.iso_639_1 === "pt-BR");
    const enLogo = logos.find((logo) => logo.iso_639_1 === "en");
    const noLangLogo = logos.find((logo) => !logo.iso_639_1 || logo.iso_639_1 === "null");
    const bestLogo = ptLogo ?? enLogo ?? noLangLogo ?? logos[0];
    const logoUrl = imageUrl(bestLogo?.file_path, "w500");

    return conform(editorialTitleResponseSchema, {
      tmdbId: details.id,
      imdbId: imdbId && /^tt\d+$/.test(imdbId) ? imdbId : null,
      type: lookup.type,
      title,
      originalTitle: originalTitle === title ? null : originalTitle,
      tagline: nonEmpty(details.tagline),
      overview: nonEmpty(details.overview),
      releaseDate: releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(releaseDate) ? releaseDate : null,
      year: yearFromDate(releaseDate),
      runtimeMinutes: runtime,
      homeReleaseDate,
      genres: unique((details.genres ?? []).map((genre) => genre.name)),
      countries: unique((details.production_countries ?? []).length > 0
        ? (details.production_countries ?? []).map((country) => country.name)
        : (details.origin_country ?? [])),
      originalLanguage: nonEmpty(details.original_language),
      spokenLanguages: unique((details.spoken_languages ?? []).map((language) => language.english_name ?? language.name)),
      directors,
      creators: unique((details.created_by ?? []).map((creator) => creator.name)),
      cast: (details.credits?.cast ?? [])
        .sort((left, right) => (left.order ?? 999) - (right.order ?? 999))
        .slice(0, 20)
        .map((member) => ({
          id: member.id,
          name: member.name,
          character: nonEmpty(member.character),
          profileUrl: imageUrl(member.profile_path, "w185")
        })),
      voteAverage: typeof details.vote_average === "number" && (details.vote_count ?? 0) > 0
        ? details.vote_average : null,
      voteCount: details.vote_count ?? 0,
      posterUrl: imageUrl(details.poster_path, "w500"),
      backdropUrl: imageUrl(details.backdrop_path, "original"),
      logoUrl,
      trailerUrl: youtubeKey(trailer?.key) ? `https://www.youtube.com/watch?v=${trailer!.key}` : null,
      tmdbUrl: `https://www.themoviedb.org/${tmdbType}/${details.id}`,
      availability: {
        subscription: (region?.flatrate ?? []).map(toProvider),
        free: (region?.free ?? []).map(toProvider),
        ads: (region?.ads ?? []).map(toProvider),
        rent: (region?.rent ?? []).map(toProvider),
        buy: (region?.buy ?? []).map(toProvider),
        link: nonEmpty(region?.link)
      },
      recommendations: mergeRecommendations(
        lookup.type,
        details.recommendations?.results ?? [],
        details.similar?.results ?? []
      ),
      attribution: { tmdbNotice: TMDB_NOTICE, providersSource: "JustWatch" }
    });
  }

  private async resolveId(lookup: EditorialLookup, tmdbType: "movie" | "tv"): Promise<number> {
    const directTmdb = /^tmdb:(\d+)$/.exec(lookup.mediaId);
    if (directTmdb) {
      const id = Number(directTmdb[1]);
      if (Number.isSafeInteger(id) && id > 0) return id;
    }
    if (/^tt\d+$/.test(lookup.mediaId)) {
      const found = await this.request(`/find/${lookup.mediaId}`, findResponseSchema, {
        external_source: "imdb_id",
        language: "pt-BR"
      });
      const item = tmdbType === "movie" ? found.movie_results?.[0] : found.tv_results?.[0];
      if (item) return item.id;
    }
    const title = lookup.title?.trim();
    if (title) {
      const searched = await this.request(`/search/${tmdbType}`, searchResponseSchema, {
        query: title,
        language: "pt-BR",
        include_adult: "false",
        ...(lookup.year ? { [tmdbType === "movie" ? "year" : "first_air_date_year"]: String(lookup.year) } : {})
      });
      if (searched.results?.[0]) return searched.results[0].id;
    }
    throw new TmdbError("NOT_FOUND", "Título não encontrado no TMDB.");
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    query: Readonly<Record<string, string>> = {}
  ): Promise<T> {
    const url = new URL(`${TMDB_BASE_URL}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.options.token}`
        },
        redirect: "error",
        signal: AbortSignal.timeout(8_000)
      });
    } catch {
      throw new TmdbError("UPSTREAM_UNAVAILABLE", "Não foi possível consultar o TMDB.");
    }
    if (response.status === 404) throw new TmdbError("NOT_FOUND", "Título não encontrado no TMDB.");
    if (!response.ok) throw new TmdbError("UPSTREAM_UNAVAILABLE", `O TMDB respondeu com status ${response.status}.`);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > RESPONSE_LIMIT_BYTES) {
      throw new TmdbError("INVALID_RESPONSE", "A resposta do TMDB excedeu o limite permitido.");
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new TmdbError("INVALID_RESPONSE", "O TMDB devolveu JSON inválido.");
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new TmdbError("INVALID_RESPONSE", "O TMDB devolveu dados inesperados.");
    return parsed.data;
  }
}
