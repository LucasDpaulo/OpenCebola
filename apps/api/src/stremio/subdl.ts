import { createHash } from "node:crypto";
import { getSafeJson } from "./safe-http.js";
import type { StremioSubtitle } from "./gateway.js";

type MediaType = "movie" | "series";
type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord : null;
}

function episodeIdentity(type: MediaType, videoId: string): URLSearchParams | null {
  const parts = videoId.split(":");
  const imdb = /^tt\d{5,12}$/.test(parts[0] ?? "") ? parts[0] : null;
  const tmdb = parts[0] === "tmdb" && /^\d{1,12}$/.test(parts[1] ?? "") ? parts[1] : null;
  if (!imdb && !tmdb) return null;
  const season = type === "series" ? Number(parts[imdb ? 1 : 2]) : null;
  const episode = type === "series" ? Number(parts[imdb ? 2 : 3]) : null;
  if (type === "series" && (!Number.isInteger(season) || !Number.isInteger(episode) ||
    season === null || episode === null || season < 0 || episode < 1 || season > 100 || episode > 10000)) return null;
  const query = new URLSearchParams({ type: type === "series" ? "tv" : "movie" });
  query.set(imdb ? "imdb_id" : "tmdb_id", (imdb ?? tmdb)!);
  if (type === "series") {
    query.set("season_number", String(season));
    query.set("episode_number", String(episode));
    query.set("full_season", "1");
  }
  return query;
}

function languageCode(value: unknown): "pt-BR" | "pt" | "en" | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toLowerCase().replace(/_/g, "-");
  // A SubDL usa BR_PT (e "brazillian portuguese", com dois L) para o português do Brasil.
  if (["pt-br", "br-pt", "pob", "pb", "brazilian", "brazilian portuguese", "brazillian portuguese", "brazillian-portuguese"].includes(code)) return "pt-BR";
  if (["pt", "por", "portuguese"].includes(code)) return "pt";
  if (["en", "eng", "english"].includes(code)) return "en";
  return null;
}

function subtitleUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/subtitle/")) return null;
  const url = new URL(value, "https://dl.subdl.com");
  if (url.origin !== "https://dl.subdl.com" ||
    !/^\/subtitle\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(url.pathname) ||
    /\.zip$/i.test(url.pathname)) return null;
  // O SubDL devolve ?api_key até nos arquivos individuais. O download público funciona sem ela.
  return `https://dl.subdl.com${url.pathname}`;
}

function usableTextFile(item: JsonRecord): boolean {
  const format = typeof item.format === "string" ? item.format.toLowerCase() : "";
  const name = typeof item.name === "string" ? item.name.toLowerCase() : "";
  return format === "srt" || format === "vtt" || format === "ass" || format === "ssa" ||
    (!format && /\.(?:srt|vtt|ass|ssa)$/.test(name));
}

function matchesEpisode(item: JsonRecord, parent: JsonRecord, type: MediaType, videoId: string): boolean {
  if (type === "movie") return true;
  const parts = videoId.split(":");
  const expectedSeason = Number(parts[parts.length - 2]);
  const expectedEpisode = Number(parts[parts.length - 1]);
  return Number(item.season ?? parent.season) === expectedSeason &&
    Number(item.episode ?? parent.episode) === expectedEpisode;
}

/** Consulta SubDL somente com IDs de mídia. A chave fica no backend e nunca entra na resposta. */
export class SubdlClient {
  readonly #apiKey: string;
  readonly #fetchJson: (url: string) => Promise<unknown>;
  readonly #cache = new Map<string, { expiresAt: number; subtitles: readonly StremioSubtitle[] }>();

  constructor(options: { apiKey: string; fetchJson?: (url: string) => Promise<unknown> }) {
    this.#apiKey = options.apiKey;
    this.#fetchJson = options.fetchJson ?? getSafeJson;
  }

  async subtitles(type: MediaType, videoId: string, filename?: string): Promise<readonly StremioSubtitle[]> {
    const query = episodeIdentity(type, videoId);
    if (!query) return [];
    // O nome do arquivo entra na CHAVE do cache: a mesma resposta guardada para "sem arquivo
    // escolhido" não pode ser devolvida quando a busca já sabe qual release está tocando.
    const cacheKey = `${type}:${videoId}:${filename ?? ""}`;
    const cached = this.#cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.subtitles;
    query.set("api_key", this.#apiKey);
    query.set("subs_per_page", "30");
    query.set("unpack", "1");
    query.set("client", "custom_integration");
    // A SubDL casa pelo nome do release quando ele é informado; ajuda a achar a legenda feita
    // para o MESMO arquivo, em vez de só o episódio certo.
    if (filename) query.set("file_name", filename);
    // A primeira página mista pode vir inteira em inglês e esconder PT-BR. Muita legenda
    // brasileira é publicada como PT genérico, então as duas entram na mesma busca.
    const responses = await Promise.allSettled(["BR_PT,PT", "EN"].map((language) => {
      const languageQuery = new URLSearchParams(query);
      languageQuery.set("languages", language);
      return this.#fetchJson(`https://api.subdl.com/api/v1/subtitles?${languageQuery}`);
    }));
    const found: StremioSubtitle[] = [];
    const urls = new Set<string>();
    for (const response of responses) {
      if (response.status !== "fulfilled") continue;
      const body = record(response.value);
      if (body?.status !== true || !Array.isArray(body.subtitles)) continue;
      for (const value of body.subtitles.slice(0, 100)) {
        const parent = record(value);
        if (!parent) continue;
        const files = Array.isArray(parent.unpack_files) && parent.unpack_files.length > 0
          ? parent.unpack_files : [parent];
        for (const candidate of files.slice(0, 100)) {
          const item = record(candidate);
          if (!item || !usableTextFile(item) || !matchesEpisode(item, parent, type, videoId)) continue;
          const language = languageCode(item.language ?? parent.language ?? item.lang ?? parent.lang);
          const url = subtitleUrl(item.url);
          if (!language || !url || urls.has(url)) continue;
          urls.add(url);
          const rawName = typeof item.release_name === "string" ? item.release_name :
            typeof item.name === "string" ? item.name : "";
          found.push({
            id: createHash("sha256").update(url).digest("base64url").slice(0, 24),
            addonName: "SubDL",
            label: language === "pt-BR" ? "Português (Brasil)" : language === "pt" ? "Português" : "Inglês",
            ...(rawName ? { details: rawName.slice(0, 120) } : {}),
            language,
            url
          });
        }
      }
    }
    const result = found.slice(0, 100);
    if (this.#cache.size >= 200) this.#cache.delete(this.#cache.keys().next().value!);
    this.#cache.set(cacheKey, { expiresAt: Date.now() + 5 * 60_000, subtitles: result });
    return result;
  }
}
