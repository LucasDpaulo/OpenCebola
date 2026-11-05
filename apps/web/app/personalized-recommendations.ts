import type { EditorialRecommendation, EditorialTitleResponse, MediaType } from "@cebola/contracts";
import { loadEditorial, type EditorialLookup } from "./editorial";

export interface RecommendationSignal {
  readonly lookup: EditorialLookup;
  readonly weight: number;
  readonly origin: "watched" | "library";
}

export type PersonalizedRecommendation = EditorialRecommendation & {
  readonly reason: string;
  readonly genres: readonly string[];
  readonly people: readonly string[];
  readonly provider: { readonly id: number; readonly name: string; readonly logoUrl: string | null } | null;
};

type Loader = (lookup: EditorialLookup) => Promise<EditorialTitleResponse | null>;

type Candidate = {
  readonly preview: EditorialRecommendation;
  readonly sources: Set<number>;
  relationScore: number;
};

function textKey(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase("pt-BR");
}

async function mapConcurrent<T, R>(items: readonly T[], limit: number, load: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await load(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

function addWeight(map: Map<string, number>, values: readonly string[], weight: number): void {
  for (const value of values) {
    const key = textKey(value);
    if (key) map.set(key, (map.get(key) ?? 0) + weight);
  }
}

/**
 * Recomendações pessoais transparentes: os candidatos precisam vir relacionados a uma obra
 * real do perfil. Depois, direção/criação, gêneros recorrentes, repetição entre várias sementes
 * e qualidade comparável decidem a ordem. Categoria sozinha nunca cria um candidato.
 */
export async function loadPersonalizedRecommendations(
  signals: readonly RecommendationSignal[],
  loader: Loader = loadEditorial
): Promise<readonly PersonalizedRecommendation[]> {
  const selectedSignals = [...signals]
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 10);
  if (selectedSignals.length === 0) return [];

  const seedResponses = await mapConcurrent(selectedSignals, 3, async (signal) => ({
    signal,
    title: await loader(signal.lookup)
  }));
  const seeds = seedResponses.filter((entry): entry is typeof entry & { title: EditorialTitleResponse } => entry.title !== null);
  if (seeds.length === 0) return [];

  const watchedIds = new Set(seeds.map(({ title }) => `${title.type}:${title.tmdbId}`));
  const watchedTitles = new Set(selectedSignals.map(({ lookup }) => `${lookup.type}:${textKey(lookup.title)}`));
  const genreAffinity = new Map<string, number>();
  const peopleAffinity = new Map<string, number>();
  let weightedRating = 0;
  let ratingWeight = 0;

  for (const { signal, title } of seeds) {
    addWeight(genreAffinity, title.genres, signal.weight);
    addWeight(peopleAffinity, [...title.directors, ...title.creators], signal.weight);
    if (title.voteAverage !== null) {
      weightedRating += title.voteAverage * signal.weight;
      ratingWeight += signal.weight;
    }
  }
  const targetRating = ratingWeight > 0 ? weightedRating / ratingWeight : 7;

  const candidates = new Map<string, Candidate>();
  seeds.forEach(({ signal, title }, seedIndex) => {
    title.recommendations.slice(0, 12).forEach((preview, rank) => {
      const key = `${preview.type}:${preview.tmdbId}`;
      if (watchedIds.has(key) || watchedTitles.has(`${preview.type}:${textKey(preview.title)}`)) return;
      const candidate = candidates.get(key) ?? { preview, sources: new Set<number>(), relationScore: 0 };
      candidate.sources.add(seedIndex);
      // O próprio TMDB já ordena por relação com a obra; posições iniciais têm mais peso.
      candidate.relationScore += signal.weight * (4 / Math.sqrt(rank + 1));
      candidates.set(key, candidate);
    });
  });

  const shortlist = [...candidates.values()]
    .sort((left, right) => (right.relationScore + right.sources.size * 2) - (left.relationScore + left.sources.size * 2))
    .slice(0, 32);

  const enriched = await mapConcurrent(shortlist, 4, async (candidate) => ({
    candidate,
    details: await loader({
      type: candidate.preview.type,
      mediaId: `tmdb:${candidate.preview.tmdbId}`,
      title: candidate.preview.title,
      year: candidate.preview.year
    })
  }));

  return enriched.flatMap(({ candidate, details }) => {
    if (!details) return [];
    let score = candidate.relationScore + candidate.sources.size * 3.5;
    for (const genre of details.genres) score += (genreAffinity.get(textKey(genre)) ?? 0) * 0.75;
    for (const person of [...details.directors, ...details.creators]) {
      score += (peopleAffinity.get(textKey(person)) ?? 0) * 2.5;
    }

    if (details.voteAverage !== null) {
      const difference = Math.abs(details.voteAverage - targetRating);
      score += Math.max(0, 3.5 - difference * 2);
      if (details.voteAverage < targetRating - 1.25) score -= 5;
      if (details.voteAverage >= 7.5) score += 1.5;
    }
    // Uma nota alta com meia dúzia de votos não deve superar uma obra bem estabelecida.
    score += Math.min(2.5, Math.log10(Math.max(1, details.voteCount)) * 0.75);

    const sourceIndexes = [...candidate.sources];
    const mainSeed = sourceIndexes
      .map((index) => seeds[index])
      .filter((seed): seed is (typeof seeds)[number] => seed !== undefined)
      .sort((left, right) => right.signal.weight - left.signal.weight)[0];
    const reason = mainSeed
      ? mainSeed.signal.origin === "library"
        ? `Porque ${mainSeed.title.title} está na sua biblioteca`
        : `Baseado em você ter assistido ${mainSeed.title.title}`
      : "Relacionado ao que você costuma assistir";

    return [{
      score,
      item: {
        tmdbId: details.tmdbId,
        type: details.type as MediaType,
        title: details.title,
        year: details.year,
        overview: details.overview,
        posterUrl: details.posterUrl,
        backdropUrl: details.backdropUrl,
        backdropPreviewUrl: details.backdropUrl,
        voteAverage: details.voteAverage,
        reason,
        genres: details.genres.slice(0, 3),
        people: [...details.directors, ...details.creators].slice(0, 3),
        provider: details.availability.subscription[0] ?? null
      } satisfies PersonalizedRecommendation
    }];
  }).sort((left, right) => right.score - left.score)
    .slice(0, 20)
    .map(({ item }) => item);
}

const CACHE_PREFIX = "cebola:recomendados:v1:";

/**
 * Última lista calculada para o perfil. A conta leva várias consultas ao TMDB, então sem isto a
 * fileira só surgia segundos depois do resto da home, empurrando a tela. Mostra a lista anterior
 * na hora e troca pela nova quando ela termina.
 */
export function cachedPersonalizedRecommendations(profileId: string): readonly PersonalizedRecommendation[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(CACHE_PREFIX + profileId) ?? "[]");
    return Array.isArray(raw)
      ? raw.filter((item): item is PersonalizedRecommendation =>
        typeof item === "object" && item !== null && typeof (item as { tmdbId?: unknown }).tmdbId === "number" &&
        typeof (item as { title?: unknown }).title === "string" && typeof (item as { reason?: unknown }).reason === "string" &&
        Array.isArray((item as { genres?: unknown }).genres) && Array.isArray((item as { people?: unknown }).people))
      : [];
  } catch {
    return [];
  }
}

export function rememberPersonalizedRecommendations(profileId: string, items: readonly PersonalizedRecommendation[]): void {
  try { window.localStorage.setItem(CACHE_PREFIX + profileId, JSON.stringify(items)); }
  catch { /* Sem armazenamento: a fileira só chega quando a conta terminar. */ }
}
