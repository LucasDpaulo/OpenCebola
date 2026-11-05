/**
 * Confere se uma fonte é do título e do episódio pedidos, só pelo que o nome do lançamento e o do
 * arquivo DECLARAM. Add-on que busca por nome devolve outra série ("Normal People" para "Os
 * Normais") ou outro episódio do mesmo pacote; a escolha automática não pode abrir isso. Na
 * dúvida a resposta é "unknown": uma fonte que pode estar certa nunca é descartada.
 */
export type SourceMatchVerdict = "match" | "mismatch" | "unknown";

export interface SourceMatch {
  readonly verdict: SourceMatchVerdict;
  readonly reason?: "outro título" | "outro episódio" | "outra temporada" | "um episódio de série" | "outro ano" | "um trailer";
}

export interface SourceMatchTarget {
  readonly type: "movie" | "series";
  /** Nomes conhecidos do título: do add-on, do TMDB (localizado) e o original. */
  readonly titles: readonly (string | null | undefined)[];
  readonly year: number | null;
  readonly season: number | null;
  readonly episode: number | null;
  /** Falso em anime: o lançamento costuma usar o romaji ("Kimetsu no Yaiba" ≠ "Demon Slayer"). */
  readonly checkTitle: boolean;
  /** Duração conhecida do filme (TMDB), para conferir o arquivo depois de aberto. */
  readonly runtimeMinutes?: number | null;
  /** Primeira data em casa (digital, disco ou TV) em qualquer país, "AAAA-MM-DD". */
  readonly homeReleaseDate?: string | null;
}

export interface MatchableSource {
  readonly label: string;
  readonly filename?: string | null;
  /** Alguns add-ons (MediaFusion) põem o próprio nome no rótulo; ele não é o nome do lançamento. */
  readonly addonName?: string | null;
}

const STOPWORDS = new Set([
  "the", "an", "of", "and", "os", "as", "de", "do", "da", "dos", "das", "no", "na", "nos", "nas",
  "el", "la", "los", "las", "le", "les", "der", "die", "das", "und"
]);

function words(text: string): string[] {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}

const significant = (word: string) => word.length >= 3 && !STOPWORDS.has(word);

// Onde o nome do lançamento acaba: episódio/temporada, ano, resolução ou palavras de pacote.
const TITLE_END = /^(?:s\d{1,2}(?:e\d{1,3})?|\d{1,2}x\d{2,3}|(?:19|20)\d{2}|\d{3,4}p|4k|uhd|season|seasons|temporada|temporadas|complete|completa|ep|episode|episodio)$/;

function releaseTitleWords(name: string): string[] {
  // "[Erai-raws] Sousou no Frieren - 01": o grupo entre colchetes não é parte do nome.
  const tokens = words(name.replace(/^\s*(?:\[[^\]]*\]\s*)+/, ""));
  const end = tokens.findIndex((token) => TITLE_END.test(token));
  return (end < 0 ? tokens : tokens.slice(0, end)).filter(significant);
}

function titleMatches(source: MatchableSource, target: SourceMatchTarget): boolean | null {
  const known = new Set(target.titles.flatMap((title) => (title ? words(title).filter(significant) : [])));
  if (known.size === 0) return null;
  // Rótulo e arquivo: basta um dos dois nomear o título. "MediaFusion | Midnight 2160p" não nomeia
  // nada (é o add-on) e fica de fora; quem diz o lançamento ali é o arquivo.
  const addon = new Set(source.addonName ? words(source.addonName) : []);
  const verdicts = [source.label, source.filename]
    .map((text) => (text ? releaseTitleWords(text).filter((word) => !addon.has(word)) : []))
    .filter((release) => release.length > 0)
    .map((release) => release.some((word) => known.has(word)));
  return verdicts.length === 0 ? null : verdicts.some(Boolean);
}

interface EpisodeMark { readonly season: number; readonly from: number; readonly to: number }

function episodeMarks(text: string): EpisodeMark[] {
  const marks: EpisodeMark[] = [];
  for (const m of text.matchAll(/\bs(\d{1,2})[ ._-]?e(\d{1,3})(?:[ ._-]?(?:-|e|-e)(\d{1,3}))?(?!\d)/gi)) {
    const from = Number(m[2]);
    marks.push({ season: Number(m[1]), from, to: m[3] ? Math.max(from, Number(m[3])) : from });
  }
  for (const m of text.matchAll(/(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?!\d)/gi)) {
    marks.push({ season: Number(m[1]), from: Number(m[2]), to: Number(m[2]) });
  }
  return marks;
}

// Temporadas que um pacote declara: "S01", "S01-S03", "Season 2", "Temporada 1-3".
function seasonMarks(text: string): { readonly from: number; readonly to: number }[] {
  const marks: { from: number; to: number }[] = [];
  for (const m of text.matchAll(/\bs(\d{1,2})(?:[ ._-]*(?:-|a|to)[ ._-]*s?(\d{1,2}))?\b(?![ ._-]?e\d)/gi)) {
    const from = Number(m[1]);
    marks.push({ from, to: m[2] ? Math.max(from, Number(m[2])) : from });
  }
  for (const m of text.matchAll(/\b(?:season|seasons|temporada|temporadas)[ ._-]*(\d{1,2})(?:[ ._-]*(?:-|a|to|e)[ ._-]*(\d{1,2}))?\b/gi)) {
    const from = Number(m[1]);
    marks.push({ from, to: m[2] ? Math.max(from, Number(m[2])) : from });
  }
  return marks;
}

function releaseYear(name: string): number | null {
  const match = /(?:^|[^0-9])((?:19|20)\d{2})(?:[^0-9p]|$)/.exec(name.replace(/^\s*(?:\[[^\]]*\]\s*)+/, ""));
  return match ? Number(match[1]) : null;
}

// Trailer e amostra vêm com o nome e o ano da obra ("The Odyssey (2026) Official Teaser Trailer 4K").
const TRAILER = /(?:^|[^a-z0-9])(?:trailer|teaser|sample|featurette|prologue)s?(?![a-z0-9])/i;
// Quem sobe outro filme de mesmo nome e ano costuma avisar: "The Odyssey 2026 (NOT The Chris Nolan FILM)".
const NOT_THIS_FILM = /(?:^|[^a-z0-9])not[\s._-]+the[\s._-][^()[\]]*?(?:film|movie)(?![a-z0-9])/i;
// Lançamentos que só existem depois de o filme sair em casa. Enquanto ele está só no cinema, todo
// "The Odyssey (2026) WEB-DL" era outro filme de mesmo nome e ano (visto na TV em 31/10/2026).
const HOME_RELEASE = /(?:^|[^a-z0-9])(?:web[ ._-]?dl(?:rip)?|web[ ._-]?rip|blu[ ._-]?ray|bd[ ._-]?rip|br[ ._-]?rip|remux|dvd[ ._-]?rip|hdtv)(?![a-z0-9])/i;
// Margem para o digital que sai um ou dois dias antes da data do TMDB.
const HOME_RELEASE_MARGIN_MS = 3 * 24 * 60 * 60 * 1_000;

function onlyInTheaters(target: SourceMatchTarget, now: number): boolean {
  if (target.type !== "movie" || !target.homeReleaseDate) return false;
  const date = Date.parse(`${target.homeReleaseDate}T00:00:00Z`);
  return Number.isFinite(date) && date - now > HOME_RELEASE_MARGIN_MS;
}

export function sourceMatch(source: MatchableSource, target: SourceMatchTarget, now = Date.now()): SourceMatch {
  if (target.checkTitle && titleMatches(source, target) === false) return { verdict: "mismatch", reason: "outro título" };
  // O arquivo diz mais que o pacote: num "S01 COMPLETE" é ele que nomeia o episódio.
  const texts = [source.filename, source.label].filter((text): text is string => Boolean(text));
  if (texts.some((text) => NOT_THIS_FILM.test(text))) return { verdict: "mismatch", reason: "outro título" };
  if (onlyInTheaters(target, now) && texts.some((text) => HOME_RELEASE.test(text))) return { verdict: "mismatch", reason: "outro título" };
  // "Trailer Park Boys" é o nome da série, não um trailer.
  const titleText = target.titles.filter(Boolean).join(" ");
  if (texts.some((text) => TRAILER.test(text)) && !TRAILER.test(titleText)) return { verdict: "mismatch", reason: "um trailer" };
  if (target.type === "movie") {
    if (texts.some((text) => episodeMarks(text).length > 0)) return { verdict: "mismatch", reason: "um episódio de série" };
    const year = releaseYear(source.label) ?? (source.filename ? releaseYear(source.filename) : null);
    if (target.checkTitle && target.year !== null && year !== null && Math.abs(year - target.year) > 1) {
      return { verdict: "mismatch", reason: "outro ano" };
    }
    return { verdict: target.checkTitle ? "match" : "unknown" };
  }
  if (target.season === null || target.episode === null) return { verdict: "unknown" };
  for (const text of texts) {
    const marks = episodeMarks(text);
    if (marks.length === 0) continue;
    return marks.some((mark) => mark.season === target.season && mark.from <= target.episode! && target.episode! <= mark.to)
      ? { verdict: "match" }
      : { verdict: "mismatch", reason: "outro episódio" };
  }
  const seasons = texts.flatMap(seasonMarks);
  if (seasons.length > 0 && !seasons.some((mark) => mark.from <= target.season! && target.season! <= mark.to)) {
    return { verdict: "mismatch", reason: "outra temporada" };
  }
  return { verdict: "unknown" };
}

/**
 * Segunda camada, depois de aberto: o nome pode mentir ("The Odyssey (2026) AMZN WEB-DL" era outro
 * filme de mesmo nome e ano, antes de o do Nolan sair em digital), a duração do arquivo não. Filme
 * com menos de 70% da duração conhecida é outra obra, trailer ou amostra. Episódio não entra: a
 * duração do TMDB é a média da série.
 */
export function durationMismatch(target: SourceMatchTarget | null, durationSeconds: number): boolean {
  const runtime = target?.type === "movie" ? target.runtimeMinutes ?? null : null;
  if (runtime === null || runtime < 40 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return false;
  return durationSeconds < runtime * 60 * 0.7;
}
