import { createHash } from "node:crypto";
import ipaddr from "ipaddr.js";
import { z } from "zod";
import type {
  StremioCatalogDescriptor,
  StremioCatalogResponse,
  StremioMetaPreview,
  StremioMetaResponse,
  StremioStream,
  StremioStreamsResponse
} from "@cebola/contracts";
// Padrões de codec vêm do pacote compartilhado: existiam três cópias deste conhecimento (aqui,
// na rota de resolve e no cliente) e elas já tinham divergido.
import { MAY_NOT_PLAY_PATTERN } from "@cebola/contracts";
import { getSafeJson, validatePublicHttpsUrl, validatePublicMediaUrl } from "./safe-http.js";
import {
  StremioIntegrationError,
  resourceSupported,
  type AddonDescriptor,
  type AddonManifest
} from "./types.js";
import { rankSearchResults } from "./search-ranking.js";
import { torrentTrackers } from "./torrent-trackers.js";

const identifier = z.string().trim().min(1).max(255).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value)
);

function cleanText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned === "" ? null : cleaned.slice(0, maximum);
}

function browserSafeHttpsUrl(value: unknown, maximum = 2_048): string | null {
  if (typeof value !== "string" || value.length > maximum) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      (url.port !== "" && url.port !== "443")
    ) return null;
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
      return null;
    }
    if (ipaddr.isValid(hostname) && ipaddr.process(hostname).range() !== "unicast") return null;
    return url.href;
  } catch {
    return null;
  }
}

function transportBase(descriptor: AddonDescriptor): URL {
  const url = new URL(descriptor.transportUrl);
  if (url.protocol !== "https:" || !url.pathname.endsWith("/manifest.json")) {
    throw new StremioIntegrationError("UNSAFE_ADDON");
  }
  url.pathname = url.pathname.slice(0, -"manifest.json".length);
  url.search = "";
  url.hash = "";
  return url;
}

// Protocolo de "extra" do Stremio: um segmento a mais no caminho, "chave=valor&chave=valor",
// só o VALOR passa por encodeURIComponent (a chave é sempre um identificador simples do
// manifesto do add-on). Hoje só o OpenSubtitles v3 declara videoHash/videoSize/filename, mas
// qualquer add-on que não reconheça o extra simplesmente devolve 404 — e isso já vira lista
// vazia para aquele add-on (Promise.allSettled em `subtitles`), nunca um erro para quem chama.
function extraSegment(extra: Record<string, string>): string {
  return Object.entries(extra).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
}

function resourceUrl(
  descriptor: AddonDescriptor,
  resource: "catalog" | "meta" | "stream" | "subtitles",
  type: "movie" | "series",
  id: string,
  extra?: Record<string, string>
): string {
  const parsed = identifier.parse(id);
  const base = transportBase(descriptor);
  const suffix = extra && Object.keys(extra).length > 0 ? `/${extraSegment(extra)}` : "";
  base.pathname += `${resource}/${encodeURIComponent(type)}/${encodeURIComponent(parsed)}${suffix}.json`;
  return base.href;
}

function catalogSearchUrl(
  descriptor: AddonDescriptor,
  type: "movie" | "series",
  catalogId: string,
  query: string
): string {
  const base = transportBase(descriptor);
  base.pathname += `catalog/${encodeURIComponent(type)}/${encodeURIComponent(identifier.parse(catalogId))}/` +
    `search=${encodeURIComponent(query)}.json`;
  return base.href;
}

function findAddon(descriptors: readonly AddonDescriptor[], addonId: string): AddonDescriptor {
  const addon = descriptors.find((candidate) => candidate.manifest.id === addonId);
  if (!addon) throw new StremioIntegrationError("ADDON_NOT_FOUND");
  return addon;
}

// addonCatalogSchema.type aceita qualquer string (add-ons reais usam "other", "tv", "anime" etc.),
// mas o produto hoje só navega filme/série. Catálogos de outros tipos ficam guardados no
// descriptor (o add-on não é descartado) e continuam disponíveis para stream/meta — só não
// aparecem como catálogo navegável em listCatalogs.
type NavigableCatalog = AddonManifest["catalogs"][number] & { type: "movie" | "series" };

function isNavigableCatalog(catalog: AddonManifest["catalogs"][number]): catalog is NavigableCatalog {
  return catalog.type === "movie" || catalog.type === "series";
}

function catalogSupportsSearch(catalog: AddonManifest["catalogs"][number]): boolean {
  const extra = (catalog as Record<string, unknown>).extra;
  return Array.isArray(extra) && extra.some((item) =>
    typeof item === "object" && item !== null && (item as { name?: unknown }).name === "search"
  );
}

function matchesResource(
  descriptor: AddonDescriptor,
  resource: string,
  type: "movie" | "series",
  id?: string
): boolean {
  if (!descriptor.manifest.types.includes(type) || !resourceSupported(descriptor.manifest, resource)) {
    return false;
  }
  const prefixes = descriptor.manifest.idPrefixes;
  return id === undefined || prefixes === undefined || prefixes.some((prefix) => id.startsWith(prefix));
}

function preview(value: unknown, fallbackType: "movie" | "series"): StremioMetaPreview | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const id = identifier.safeParse(raw.id);
  const name = cleanText(raw.name, 300);
  const type = raw.type === "movie" || raw.type === "series" ? raw.type : fallbackType;
  if (!id.success || name === null) return null;
  const genres = Array.isArray(raw.genres)
    ? raw.genres.flatMap((genre) => {
      const cleaned = cleanText(genre, 80);
      return cleaned ? [cleaned] : [];
    }).slice(0, 30)
    : [];
  const logo = browserSafeHttpsUrl(raw.logo);
  return {
    id: id.data,
    type,
    name,
    poster: browserSafeHttpsUrl(raw.poster),
    background: browserSafeHttpsUrl(raw.background),
    ...(logo ? { logo } : {}),
    description: cleanText(raw.description, 5_000),
    releaseInfo: cleanText(raw.releaseInfo, 100),
    ...(genres.length > 0 ? { genres } : {})
  };
}

function normalizedDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

// --- Metadados de stream (formato observado hoje no Torrentio) -----------------------------
// stream.name  = "Torrentio\n4k HDR"                                    (qualidade na 2ª linha)
// stream.title = "Filme.2026.2160p.WEB.h265-GRUPO\n👤 1543 💾 27.59 GB ⚙️ ThePirateBay\n🇬🇧 / 🇪🇸"
// Outros add-ons podem não seguir esse formato: cada extração abaixo é best-effort sobre os
// campos crus (antes do cleanText colapsar quebras de linha) e nunca lança — ausência vira null.

function firstLine(value: unknown): string | null {
  return typeof value === "string" ? value.split("\n")[0] : null;
}

function detectQualityIn(value: unknown): StremioStream["quality"] {
  if (typeof value !== "string") return null;
  if (/2160p|\b4k\b|\buhd\b/i.test(value)) return "4K";
  if (/1080p|full\s?hd|\bfhd\b/i.test(value)) return "1080p";
  if (/720p|\bhd\b/i.test(value)) return "720p";
  if (/480p/i.test(value)) return "480p";
  if (/360p|240p|\bsd\b/i.test(value)) return "SD";
  return null;
}

// name costuma ser mais confiável que title para qualidade (ex.: "Torrentio\n4k HDR").
function streamQuality(rawName: unknown, rawTitle: unknown): StremioStream["quality"] {
  return detectQualityIn(rawName) ?? detectQualityIn(rawTitle);
}

function streamSeeders(rawText: string): number | null {
  const match = rawText.match(/👤\s*(\d+)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 && value <= 1e7 ? value : null;
}

function streamSizeLabel(rawText: string): string | null {
  const match = rawText.match(/💾\s*(\d+(?:[.,]\d+)?\s?[A-Za-zµ]{1,3})/);
  return match ? cleanText(match[1], 40) : null;
}

function streamSource(rawText: string): string | null {
  const match = rawText.match(/⚙️\s*([^\n\r]+)/);
  return match ? cleanText(match[1], 60) : null;
}

// Prazo da busca: o Cinemeta costuma responder em ~1 s, mas um catálogo lento chegou a 6 s.
const SEARCH_DEADLINE_MS = 2_500;
// Quanto os add-ons restantes ainda têm depois que o primeiro trouxe fontes.
const STREAMS_GRACE_MS = 2_500;
const READY_NOW_PATTERN = /\[(?:RD|AD|PM|DL|OC|TB)\+\]|\[\+\]|⚡/i;
const NEEDS_DOWNLOAD_PATTERN = /\[(?:RD|AD|PM|DL|OC|TB)\s+download\]|\[download\]/i;

// null = o add-on não informa. ThePirateBay+, Brazuca Torrents e Orion não informam, e tratá-los
// como "pronto" reintroduziria a espera que este campo existe para eliminar.
function streamReadyNow(rawText: string): boolean | null {
  if (READY_NOW_PATTERN.test(rawText)) return true;
  if (NEEDS_DOWNLOAD_PATTERN.test(rawText)) return false;
  return null;
}

// Idioma de áudio -------------------------------------------------------------------------
// O Torrentio marca os idiomas de ÁUDIO presentes no release com bandeiras, numa linha própria
// do title (ex.: "🇬🇧 / 🇮🇹 / 🇫🇷"). Duas observações que vieram de olhar o payload real e que
// mudam como isso pode ser usado:
//   1. A ORDEM não indica a faixa padrão — o inglês aparece primeiro por convenção do add-on.
//   2. Cerca de METADE dos releases não traz marcação nenhuma. Nesses, o áudio é o original do
//      conteúdo, então lista vazia é sinal de "original", não de "desconhecido ruim".
// A bandeira é um par de indicadores regionais que codifica o código do país, então dá para
// decodificar sem tabela de emoji — só a de país→idioma é necessária.
const COUNTRY_LANGUAGE: Record<string, string> = {
  GB: "en", US: "en", AU: "en", CA: "en", IE: "en", NZ: "en",
  BR: "pt", PT: "pt",
  ES: "es", MX: "es", AR: "es",
  FR: "fr", IT: "it", DE: "de", AT: "de", NL: "nl",
  RU: "ru", UA: "uk", PL: "pl", TR: "tr", GR: "el",
  JP: "ja", KR: "ko", CN: "zh", TW: "zh", HK: "zh",
  IN: "hi", SE: "sv", NO: "no", DK: "da", FI: "fi",
  CZ: "cs", HU: "hu", RO: "ro", IL: "he", SA: "ar", TH: "th", VN: "vi", ID: "id"
};

function countryFromFlag(flag: string): string | null {
  const points = [...flag].map((character) => character.codePointAt(0) ?? 0);
  if (points.length !== 2) return null;
  const letters = points.map((point) => point - 0x1f1e6);
  if (letters.some((index) => index < 0 || index > 25)) return null;
  return letters.map((index) => String.fromCharCode(65 + index)).join("");
}

// A linha de bandeiras pode vir com um prefixo, e ele muda o SIGNIFICADO das bandeiras. Varrendo
// o payload real de quatro títulos só existem quatro casos: sem prefixo (97x), "Dual Audio" (9x),
// "Multi Audio" (6x) e "Multi Subs" (3x). Em "Multi Subs" as bandeiras são LEGENDA, não áudio —
// tratá-las como áudio dizia que um release inglês tinha áudio em italiano.
function flagLine(rawText: string): string | null {
  return rawText.split("\n").find((line) => /[\u{1F1E6}-\u{1F1FF}]{2}/u.test(line)) ?? null;
}

function streamAudioLanguages(rawText: string): string[] {
  const line = flagLine(rawText);
  if (line === null) return [];
  const prefix = line.split(/[\u{1F1E6}-\u{1F1FF}]/u)[0] ?? "";
  if (/subs?\b/i.test(prefix)) return [];
  const found = new Set<string>();
  for (const flag of line.match(/[\u{1F1E6}-\u{1F1FF}]{2}/gu) ?? []) {
    const country = countryFromFlag(flag);
    const language = country === null ? undefined : COUNTRY_LANGUAGE[country];
    if (language !== undefined) found.add(language);
  }
  return [...found].slice(0, 20);
}

function streamSubtitleLanguages(rawText: string, inlineSubtitles: unknown): string[] {
  const found = new Set<string>();
  for (const line of rawText.split("\n")) {
    if (!/\b(?:multi\s*subs?|subs?|subtitles?|legendas?)\b/i.test(line)) continue;
    for (const flag of line.match(/[\u{1F1E6}-\u{1F1FF}]{2}/gu) ?? []) {
      const country = countryFromFlag(flag);
      const language = country === "BR" ? "pt-BR" : country === null ? undefined : COUNTRY_LANGUAGE[country];
      if (language) found.add(language);
    }
    if (/\b(?:pt[-_ ]?br|pob|portugu[eê]s\s*(?:do\s*)?brasil)\b/i.test(line)) found.add("pt-BR");
    else if (/\b(?:portugu[eê]s|\bpor\b)\b/i.test(line)) found.add("pt");
    if (/\b(?:english|ingl[eê]s|\beng\b)\b/i.test(line)) found.add("en");
  }
  if (Array.isArray(inlineSubtitles)) for (const item of inlineSubtitles.slice(0, 50)) {
    if (typeof item !== "object" || item === null) continue;
    const lang = (item as { lang?: unknown }).lang;
    if (typeof lang !== "string") continue;
    const code = lang.trim().toLowerCase();
    if (/^(?:pob|pb|pt[-_]br)$/.test(code)) found.add("pt-BR");
    else if (/^(?:pt|por)(?:[-_].*)?$/.test(code)) found.add("pt");
    else if (/^(?:en|eng)(?:[-_].*)?$/.test(code)) found.add("en");
  }
  return [...found].slice(0, 20);
}

// "Dublado" no sentido que interessa: a faixa de áudio padrão provavelmente NÃO é a original.
// O sinal vem de dois lugares, e o segundo é o que faltava — o nome do arquivo. O release que
// apareceu para o usuário, "Breaking.Bad.S01E01.2008.1080P-Dual-Lat" (Cinecalidad), não tem
// bandeira NENHUMA: só o nome denuncia a dublagem latina. O "multi" exige lookahead porque
// "Multisub" é legenda, não áudio.
const DUBBED_PATTERN =
  /\bdual\b|latino|castellano|dublado|nacional|\bdub(?:bed)?\b|\bmulti(?!ple\s+sub|\s*[- ]?subs?\b)/i;

function streamDubbed(rawText: string): boolean {
  return DUBBED_PATTERN.test(rawText);
}

export function streamMayNotPlay(rawText: string): boolean {
  return MAY_NOT_PLAY_PATTERN.test(rawText);
}

// Ordem de exibição tipo Netflix: melhor qualidade primeiro, sem info por último.
const QUALITY_ORDER: readonly StremioStream["quality"][] = ["4K", "1080p", "720p", "480p", "SD", null];

function qualityRank(quality: StremioStream["quality"]): number {
  const index = QUALITY_ORDER.indexOf(quality);
  return index === -1 ? QUALITY_ORDER.length : index;
}

// Pronto (true) antes de quem não avisa (null), e os dois antes do que precisa baixar (false).
function readyRank(readyNow: boolean | null): number {
  return readyNow === true ? 0 : readyNow === null ? 1 : 2;
}

// Pronto agora vem ANTES de qualidade: uma fonte em 720p que já está no cache do debrid abre na
// hora, enquanto uma em 4K que precisa baixar não toca — não é "melhor", é "não disponível ainda".
// Isto também alinha a lista manual (aqui) com a escolha automática do player
// (`rankAutomaticSources`, no app), que já usa essa mesma ordem. Array#sort é estável: streams
// empatados em tudo mantêm a ordem de chegada.
function compareStreams(a: StremioStream, b: StremioStream): number {
  const byReady = readyRank(a.readyNow) - readyRank(b.readyNow);
  if (byReady !== 0) return byReady;
  const byQuality = qualityRank(a.quality) - qualityRank(b.quality);
  if (byQuality !== 0) return byQuality;
  // Depois, maior chance de tocar com áudio no navegador. EAC3/DTS/TrueHD continuam disponíveis,
  // mas deixam de ocupar o topo apenas por terem mais seeders.
  const byCompatibility = Number(a.mayNotPlay) - Number(b.mayNotPlay);
  return byCompatibility !== 0 ? byCompatibility : (b.seeders ?? -1) - (a.seeders ?? -1);
}

function torrentInfoHash(value: unknown): string | null {
  return typeof value === "string" && /^[a-fA-F0-9]{40}$/.test(value) ? value.toLowerCase() : null;
}

function torrentFileIndex(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 100_000 ? Number(value) : null;
}

// behaviorHints.filename é o nome REAL do arquivo (diferente de `label`/`title`, texto livre do
// add-on) — é o que permite achar a legenda sincronizada com o arquivo escolhido, não só com o
// título anunciado. Sem barra: um valor com caminho poderia ser usado para esconder algo
// diferente do nome do release no lugar do nome real.
function streamBehaviorHintFilename(behaviorHints: unknown): string | null {
  if (typeof behaviorHints !== "object" || behaviorHints === null) return null;
  const raw = (behaviorHints as Record<string, unknown>).filename;
  if (typeof raw !== "string") return null;
  const base = raw.split(/[\\/]/).pop() ?? raw;
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 255) : null;
}

function streamBehaviorHintVideoSize(behaviorHints: unknown): number | null {
  if (typeof behaviorHints !== "object" || behaviorHints === null) return null;
  const raw = (behaviorHints as Record<string, unknown>).videoSize;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw <= 1_000_000_000_000
    ? Math.round(raw) : null;
}

function isBrowserOnlyAddon(descriptor: AddonDescriptor): boolean {
  try {
    const url = new URL(descriptor.transportUrl);
    const torrentioRd = descriptor.manifest.id === "com.stremio.torrentio.addon" &&
      url.protocol === "https:" && url.hostname === "torrentio.strem.fun" &&
      /realdebrid/i.test(url.pathname);
    // Na VM o Orion consome a cota e devolve um pseudo-stream ERROR. No navegador do usuário
    // ele tem a chance de responder normalmente; consultá-lo nos dois lugares dobrava o consumo.
    return torrentioRd || descriptor.manifest.id === "org.community.orion";
  } catch {
    return false;
  }
}

export interface BrowserStreamTarget {
  readonly addonId: string;
  readonly addonName: string;
  readonly url: string;
}

export interface StremioSubtitle {
  readonly id: string;
  readonly addonName: string;
  readonly label: string;
  readonly details?: string;
  readonly language: string;
  readonly url: string;
  // OpenSubtitles casou esta legenda pelo HASH do arquivo de vídeo (campo "m" === "h"), não só
  // pelo id do título: é sincronia exata, o sinal mais forte que existe para escolha automática.
  readonly hashMatch?: boolean;
  // Quadros por segundo do release da legenda (fpsMilli/1000), quando o add-on informa.
  readonly fps?: number;
}

export interface StremioSearchItem extends StremioMetaPreview {
  readonly addonId: string;
}

// A lista vinha com dezenas de idiomas e ficava inutilizável na interface. Só português do
// Brasil e inglês, por pedido explícito do dono. Os add-ons não falam um padrão só: o
// OpenSubtitles usa ISO 639-2 ("por", e "pob" para o brasileiro), outros usam ISO 639-1 ("pt")
// ou tags completas ("pt-BR"). O rótulo entra como segunda chance porque alguns add-ons mandam
// lang vazio e escrevem o idioma só no label.
// O OpenSubtitles v3 manda { id, url, lang } sem label, e o fallback caía no id — a lista
// aparecia como "3265167 · OpenSubtitles v3", sem dizer qual era português e qual era inglês.
// O nome do idioma é a única coisa que importa na hora de escolher.
export function subtitleLanguageName(language: string): string | null {
  const code = language.trim().toLowerCase();
  if (/^(?:pob|pb)$/.test(code) || /^pt[-_]br$/.test(code)) return "Português (Brasil)";
  if (/^(?:pt|por)(?:[-_].*)?$/.test(code)) return "Português";
  if (/^(?:en|eng)(?:[-_].*)?$/.test(code)) return "Inglês";
  if (!/^[a-z]{2,3}(?:[-_][a-z]{2,4})?$/.test(code) || code === "und") return null;
  try {
    const name = new Intl.DisplayNames(["pt-BR"], { type: "language" }).of(code.replace("_", "-"));
    return name ? name.charAt(0).toLocaleUpperCase("pt-BR") + name.slice(1) : null;
  } catch { return null; }
}

function subtitleAllowed(language: string, label: string): boolean {
  const code = language.trim().toLowerCase();
  if (/^(?:pt|por|pob|pb)(?:[-_].*)?$/.test(code)) return true;
  if (/^(?:en|eng)(?:[-_].*)?$/.test(code)) return true;
  if (/^[a-z]{2,3}(?:[-_][a-z]{2,4})?$/.test(code) && code !== "und") {
    try { Intl.getCanonicalLocales(code.replace("_", "-")); return true; }
    catch { return false; }
  }
  if (code !== "" && code !== "und") return false;
  return /portugu|brasil|brazil|ingl[êe]s|english/i.test(label);
}

export class StremioAddonGateway {
  // Busca de JSON injetável nos testes; produção mantém o getSafeJson com a política de rede completa.
  readonly #fetchJson: (url: string) => Promise<unknown>;
  // Flag CEBOLA_ALLOW_INSECURE_STREAMS: default false mantém o método streams https-only, como sempre.
  readonly #allowInsecureStreams: boolean;
  readonly #metadataCache = new Map<string, { expiresAt: number; response: Promise<unknown> }>();

  constructor(options: {
    fetchJson?: (url: string) => Promise<unknown>;
    allowInsecureStreams?: boolean;
  } = {}) {
    this.#fetchJson = options.fetchJson ?? getSafeJson;
    this.#allowInsecureStreams = options.allowInsecureStreams ?? false;
  }

  async #cachedJson(url: string, ttlMs: number): Promise<unknown> {
    const key = createHash("sha256").update(url).digest("base64url");
    const now = Date.now();
    const cached = this.#metadataCache.get(key);
    if (cached && cached.expiresAt > now) return cached.response;
    if (cached) this.#metadataCache.delete(key);

    const response = this.#fetchJson(url).catch((error) => {
      this.#metadataCache.delete(key);
      throw error;
    });
    this.#metadataCache.set(key, { expiresAt: now + ttlMs, response });
    if (this.#metadataCache.size > 250) {
      const oldest = this.#metadataCache.keys().next().value as string | undefined;
      if (oldest) this.#metadataCache.delete(oldest);
    }
    return response;
  }

  listCatalogs(descriptors: readonly AddonDescriptor[]): readonly StremioCatalogDescriptor[] {
    return descriptors.flatMap((descriptor) =>
      descriptor.manifest.catalogs
        .filter(isNavigableCatalog)
        .map((catalog) => ({
          addonId: descriptor.manifest.id,
          catalogId: catalog.id,
          type: catalog.type,
          name: cleanText(catalog.name, 200) ?? descriptor.manifest.name
        }))
    ).slice(0, 100);
  }

  async catalog(
    descriptors: readonly AddonDescriptor[],
    addonId: string,
    type: "movie" | "series",
    catalogId: string
  ): Promise<StremioCatalogResponse> {
    const addon = findAddon(descriptors, addonId);
    const catalog = addon.manifest.catalogs.find((candidate) =>
      candidate.id === catalogId && candidate.type === type
    );
    if (!catalog) throw new StremioIntegrationError("ADDON_NOT_FOUND");
    const body = await this.#cachedJson(resourceUrl(addon, "catalog", type, catalogId), 3 * 60_000);
    const metas = typeof body === "object" && body !== null
      ? (body as { metas?: unknown }).metas
      : null;
    if (!Array.isArray(metas)) throw new StremioIntegrationError("INVALID_RESPONSE");
    return {
      addonId,
      catalogId,
      name: cleanText(catalog.name, 200) ?? addon.manifest.name,
      items: metas.slice(0, 100).map((item) => preview(item, type)).filter((item) => item !== null)
    };
  }

  async search(
    descriptors: readonly AddonDescriptor[],
    query: string,
    deadlineMs = SEARCH_DEADLINE_MS
  ): Promise<{ readonly items: readonly StremioSearchItem[]; readonly complete: boolean }> {
    const cleanedQuery = cleanText(query, 100);
    if (!cleanedQuery || cleanedQuery.length < 2) return { items: [], complete: true };
    const targets = descriptors.flatMap((descriptor) => descriptor.manifest.catalogs
      .filter((catalog): catalog is NavigableCatalog => isNavigableCatalog(catalog) && catalogSupportsSearch(catalog))
      .map((catalog) => ({ descriptor, catalog }))).slice(0, 12);
    // Esperar TODOS os catálogos fazia a busca durar o que o add-on mais lento durasse (até o
    // timeout de 8 s de cada consulta). Responde com o que chegou no prazo; as consultas
    // atrasadas continuam e ficam no cache de 60 s, então a próxima tecla já as aproveita.
    const settled: (readonly StremioSearchItem[] | null)[] = targets.map(() => null);
    const all = Promise.allSettled(targets.map(async ({ descriptor, catalog }, index) => {
      const body = await this.#cachedJson(catalogSearchUrl(descriptor, catalog.type, catalog.id, cleanedQuery), 60_000);
      const metas = typeof body === "object" && body !== null ? (body as { metas?: unknown }).metas : null;
      settled[index] = Array.isArray(metas) ? metas.slice(0, 30).flatMap((item) => {
        const parsed = preview(item, catalog.type);
        return parsed ? [{ ...parsed, addonId: descriptor.manifest.id }] : [];
      }) : [];
    }));
    let complete = false;
    await Promise.race([
      all.then(() => { complete = true; }),
      new Promise<void>((resolve) => setTimeout(resolve, deadlineMs).unref?.())
    ]);
    const unique = new Map<string, { item: StremioSearchItem; name: string; position: number; hits: number }>();
    for (const list of settled) {
      for (const [position, item] of (list ?? []).entries()) {
        const key = `${item.type}:${item.id}`;
        const seen = unique.get(key);
        if (seen) {
          seen.hits += 1;
          seen.position = Math.min(seen.position, position);
        } else {
          unique.set(key, { item, name: item.name, position, hits: 1 });
        }
      }
    }
    return {
      items: rankSearchResults([...unique.values()], cleanedQuery).slice(0, 60).map(({ item }) => item),
      complete
    };
  }

  async meta(
    descriptors: readonly AddonDescriptor[],
    addonId: string,
    type: "movie" | "series",
    mediaId: string
  ): Promise<StremioMetaResponse> {
    const preferred = findAddon(descriptors, addonId);
    const addon = matchesResource(preferred, "meta", type, mediaId)
      ? preferred
      : descriptors.find((candidate) => matchesResource(candidate, "meta", type, mediaId));
    if (!addon) throw new StremioIntegrationError("ADDON_NOT_FOUND");
    const body = await this.#cachedJson(resourceUrl(addon, "meta", type, mediaId), 5 * 60_000);
    const raw = typeof body === "object" && body !== null
      ? (body as { meta?: unknown }).meta
      : null;
    const base = preview(raw, type);
    if (base === null || typeof raw !== "object" || raw === null) {
      throw new StremioIntegrationError("INVALID_RESPONSE");
    }
    const videosRaw = (raw as { videos?: unknown }).videos;
    const videos = Array.isArray(videosRaw)
      ? videosRaw.slice(0, 2_000).flatMap((video) => {
          if (typeof video !== "object" || video === null) return [];
          const item = video as Record<string, unknown>;
          const id = identifier.safeParse(item.id);
          if (!id.success) return [];
          return [{
            id: id.data,
            // `name` PRIMEIRO: o Cinemeta nunca manda `title` em episódio — só `name`. Lendo só
            // `title`, todo episódio caía no fallback e a lista inteira exibia o nome da SÉRIE
            // repetido. Outros add-ons usam `title`, então os dois continuam aceitos.
            title: cleanText(item.name, 300) ?? cleanText(item.title, 300) ?? base.name,
            season: Number.isInteger(item.season) && Number(item.season) >= 0
              ? Number(item.season) : null,
            episode: Number.isInteger(item.episode) && Number(item.episode) >= 0
              ? Number(item.episode) : null,
            released: normalizedDate(item.released),
            thumbnail: browserSafeHttpsUrl(item.thumbnail)
          }];
        })
      : [];
    if (videos.length === 0 && type === "movie") {
      videos.push({
        id: base.id, title: base.name, season: null, episode: null, released: null,
        thumbnail: null
      });
    }
    return { ...base, videos };
  }

  async streams(
    descriptors: readonly AddonDescriptor[],
    type: "movie" | "series",
    videoId: string,
    graceMs = STREAMS_GRACE_MS
  ): Promise<StremioStreamsResponse> {
    const relevant = descriptors.filter((descriptor) =>
      !isBrowserOnlyAddon(descriptor) && matchesResource(descriptor, "stream", type, videoId)
    ).slice(0, 40);
    // Esperar TODOS os add-ons fazia toda busca de fonte durar 8 s: basta um add-on da conta que
    // nunca responde para cada consulta ir até o timeout. Depois que algum trouxer fontes, os
    // demais têm só `graceMs`; sem nenhuma fonte ainda, a espera continua até o timeout normal.
    const collected: StremioStream[] = [];
    let firstStreams: () => void = () => undefined;
    const gotStreams = new Promise<void>((resolve) => { firstStreams = resolve; });
    const all = Promise.allSettled(relevant.map(async (descriptor) => {
      const body = await this.#fetchJson(resourceUrl(descriptor, "stream", type, videoId));
      const streams = await this.normalizeStreamPayload(descriptor, body);
      collected.push(...streams);
      if (streams.length > 0) firstStreams();
    }));
    await Promise.race([
      all,
      gotStreams.then(() => new Promise<void>((resolve) => setTimeout(resolve, graceMs)))
    ]);
    // Ordena (qualidade, depois seeders) antes do corte final, para que os 300 exibidos sejam
    // os "melhores" pelo critério, não apenas os primeiros add-ons a responder.
    return { streams: collected.sort(compareStreams).slice(0, 300) };
  }

  async subtitles(
    descriptors: readonly AddonDescriptor[],
    type: "movie" | "series",
    videoId: string,
    extra?: Record<string, string>
  ): Promise<readonly StremioSubtitle[]> {
    const relevant = descriptors.filter((descriptor) =>
      matchesResource(descriptor, "subtitles", type, videoId)
    ).slice(0, 10);
    const responses = await Promise.allSettled(relevant.map(async (descriptor) => {
      const body = await this.#fetchJson(resourceUrl(descriptor, "subtitles", type, videoId, extra));
      const values = typeof body === "object" && body !== null ? (body as { subtitles?: unknown }).subtitles : null;
      if (!Array.isArray(values)) return [];
      const accepted: StremioSubtitle[] = [];
      // Numera repetidos do mesmo idioma: um título costuma trazer dezenas de legendas em
      // português, e todas com o mesmo nome seriam indistinguíveis na lista.
      const byLanguage = new Map<string, number>();
      for (const [index, value] of values.slice(0, 100).entries()) {
        if (typeof value !== "object" || value === null) continue;
        const raw = value as Record<string, unknown>;
        const url = browserSafeHttpsUrl(raw.url);
        if (!url) continue;
        const language = cleanText(raw.lang, 35) ?? "und";
        const providedLabel = cleanText(raw.label, 120);
        const rawLabel = providedLabel ?? cleanText(raw.id, 120) ?? `${language} ${index + 1}`;
        if (!subtitleAllowed(language, rawLabel)) continue;
        // Nome do idioma primeiro; o rótulo do add-on só entra quando não dá para deduzir.
        const named = subtitleLanguageName(language);
        const seen = (byLanguage.get(named ?? rawLabel) ?? 0) + 1;
        byLanguage.set(named ?? rawLabel, seen);
        const label = named === null ? rawLabel : (seen === 1 ? named : `${named} ${seen}`);
        // O OpenSubtitles v3 nunca manda `label` — sem isto, `details` ficava sempre vazio para
        // ele e o nome do arquivo/release da legenda (o único jeito de casar com o vídeo
        // escolhido) era descartado.
        const fallbackDetails = providedLabel === null
          ? cleanText(raw.subtitleFileName, 200) ?? cleanText(raw.movieReleaseName, 200)
          : null;
        const details = providedLabel !== null && providedLabel.toLocaleLowerCase() !== (named ?? "").toLocaleLowerCase()
          ? providedLabel
          : fallbackDetails;
        // "m" === "h": o OpenSubtitles casou pelo HASH do arquivo de vídeo, não pelo id do
        // título — sincronia confirmada, não uma dedução por nome de release.
        const hashMatch = raw.m === "h" ? true : null;
        const fps = typeof raw.fpsMilli === "number" && Number.isFinite(raw.fpsMilli) ? raw.fpsMilli / 1000 : null;
        accepted.push({
          id: createHash("sha256").update(`${descriptor.manifest.id}\0${url}`).digest("base64url").slice(0, 24),
          addonName: descriptor.manifest.name,
          label,
          ...(details ? { details } : {}),
          ...(hashMatch ? { hashMatch } : {}),
          ...(fps !== null ? { fps } : {}),
          language,
          url
        });
      }
      return accepted;
    }));
    return responses.flatMap((result) => result.status === "fulfilled" ? result.value : []).slice(0, 100);
  }

  async browserStreamTargets(
    descriptors: readonly AddonDescriptor[],
    type: "movie" | "series",
    videoId: string
  ): Promise<readonly BrowserStreamTarget[]> {
    // 40 add-ons: uma conta real passa de 20 com recurso de stream, e o corte antigo descartava
    // add-ons inteiros em silêncio — inclusive os pagos.
    const candidates = descriptors.filter((descriptor) =>
      matchesResource(descriptor, "stream", type, videoId)
    ).slice(0, 40);
    const checked = await Promise.allSettled(candidates.map(async (descriptor) => {
      const url = resourceUrl(descriptor, "stream", type, videoId);
      // O servidor ainda consulta todos os add-ons normalmente. Esta lista é uma segunda rota
      // para os que recusam IPs de datacenter (Cloudflare) mas aceitam o Stremio Web no aparelho
      // do próprio usuário. A validação completa, incluindo DNS público, acontece antes de a URL
      // ser entregue ao navegador.
      await validatePublicHttpsUrl(url);
      return { addonId: descriptor.manifest.id, addonName: descriptor.manifest.name, url };
    }));
    const unique = new Map<string, BrowserStreamTarget>();
    for (const result of checked) {
      if (result.status === "fulfilled") unique.set(result.value.url, result.value);
    }
    return [...unique.values()].slice(0, 40);
  }

  async normalizeBrowserStreamPayload(
    descriptors: readonly AddonDescriptor[],
    addonId: string,
    body: unknown
  ): Promise<StremioStreamsResponse> {
    const descriptor = descriptors.find((candidate) =>
      candidate.manifest.id === addonId && resourceSupported(candidate.manifest, "stream")
    );
    if (!descriptor) throw new StremioIntegrationError("ADDON_NOT_FOUND");
    return { streams: (await this.normalizeStreamPayload(descriptor, body)).sort(compareStreams).slice(0, 300) };
  }

  private async normalizeStreamPayload(
    descriptor: AddonDescriptor,
    body: unknown
  ): Promise<StremioStream[]> {
    const streams = typeof body === "object" && body !== null
      ? (body as { streams?: unknown }).streams
      : null;
    if (!Array.isArray(streams)) return [];
    const accepted: StremioStream[] = [];
    // 300 por add-on: o Torrentio RD medido nesta conta chegou a 233 opções em um único filme.
    // O limite continua protegendo a API de payloads sem fim, mas deixa de cortar títulos reais
    // no centésimo resultado antes que a ordenação possa escolher as melhores fontes.
    for (const [index, value] of streams.slice(0, 300).entries()) {
        if (typeof value !== "object" || value === null) continue;
        const stream = value as Record<string, unknown>;
        const rawText = `${typeof stream.title === "string" ? stream.title : ""}\n` +
          `${typeof stream.name === "string" ? stream.name : ""}\n` +
          `${typeof stream.description === "string" ? stream.description : ""}`;
        const label = cleanText(firstLine(stream.title), 300) ?? cleanText(firstLine(stream.name), 300) ??
          `Opção ${index + 1}`;
        // Orion e alguns add-ons devolvem um pseudo-stream chamado "ERROR!". Ele não é mídia
        // e nunca deve aparecer como opção clicável.
        if (/^(?:⚠️\s*)?error!?/i.test(label)) continue;
        const filename = streamBehaviorHintFilename(stream.behaviorHints);
        const videoSize = streamBehaviorHintVideoSize(stream.behaviorHints);
        const shared = {
          addonId: descriptor.manifest.id,
          addonName: descriptor.manifest.name,
          label,
          quality: streamQuality(stream.name, stream.title),
          sizeLabel: streamSizeLabel(rawText),
          seeders: streamSeeders(rawText),
          source: streamSource(rawText),
          mayNotPlay: streamMayNotPlay(rawText),
          readyNow: streamReadyNow(rawText),
          audioLanguages: streamAudioLanguages(rawText),
          subtitleLanguages: streamSubtitleLanguages(rawText, stream.subtitles),
          dubbed: streamDubbed(rawText),
          ...(filename ? { filename } : {}),
          ...(videoSize !== null ? { videoSize } : {})
        };
        const infoHash = torrentInfoHash(stream.infoHash);
        if (infoHash !== null) {
          const fileIdx = torrentFileIndex(stream.fileIdx);
          const trackers = torrentTrackers(stream.sources);
          accepted.push({
            id: createHash("sha256").update(`${descriptor.manifest.id}\0${infoHash}\0${fileIdx ?? ""}`).digest("hex").slice(0, 32),
            kind: "torrent",
            url: null,
            ...shared,
            infoHash,
            fileIdx,
            ...(trackers.length > 0 ? { trackers } : {})
          });
          continue;
        }
        if (typeof stream.url !== "string") continue;
        try {
          const url = await validatePublicMediaUrl(stream.url, { allowInsecure: this.#allowInsecureStreams });
          accepted.push({
            id: createHash("sha256").update(`${descriptor.manifest.id}\0${url.href}`).digest("hex").slice(0, 32),
            kind: "direct",
            ...shared,
            url: url.href,
          });
        } catch {
          // P2P, IP privado, portas não padrão e (sem CEBOLA_ALLOW_INSECURE_STREAMS) HTTP são
          // recusados sem vazar a URL.
        }
    }
    return accepted;
  }
}
