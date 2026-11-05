"use client";

import type { EditorialHomeRail, EditorialProvider } from "@cebola/contracts";
import { apiFetch } from "./api-client";

/**
 * Carregamento das fileiras editoriais da home, fora do React.
 *
 * Três problemas moravam no efeito que isto substitui. O primeiro: ele só disparava depois que
 * `/v1/home/bootstrap` respondia, porque dependia do perfil já estar no estado — duas viagens
 * em série antes de aparecer qualquer conteúdo, sendo que nenhuma precisa da outra. O segundo:
 * nada era compartilhado, então voltar para a home refazia a consulta inteira. O terceiro: o
 * cache que existia morava num `useRef` e sumia junto com o componente.
 *
 * Vive fora do React pelo mesmo motivo de `editorial.ts`: precisa sobreviver a quem desmonta.
 *
 * `localStorage` e não `sessionStorage`. A primeira versão usou `sessionStorage` justificando
 * que "o app recarrega a página a cada abertura" — o que é verdade e não ajuda em nada, porque
 * `sessionStorage` morre junto com o contexto de navegação: matar e reabrir o app Android cria
 * um WebView novo, com o depósito vazio. Era exatamente o boot frio que a justificativa citava.
 * `localStorage` é o que o resto do app já usa para estado que atravessa abertura
 * (`native/session-store.ts`, `cebola:library:`, `cebola_theme`). O conteúdo é curadoria do
 * TMDB, idêntica para todo mundo: nada pessoal fica guardado no aparelho.
 */

export type EditorialHomeResult =
  | { readonly status: "ok"; readonly rails: readonly EditorialHomeRail[] }
  | { readonly status: "unauthorized" }
  | { readonly status: "unavailable" };

/** Curto: a seleção muda pouco, mas ninguém quer ficar preso a uma home velha. */
const TTL_MS = 10 * 60 * 1_000;
export const EDITORIAL_HOME_STORAGE_PREFIX = "cebola:editorial-home:";

/**
 * A home abre com a página 1 e só busca a seguinte quando alguém clica em "+ Ver mais". Cada
 * página tem entrada própria no cache: quem nunca clica nunca paga a viagem extra.
 */
type RailGroup = "all" | "primary" | "providers";

function pageKey(section: string, page: number, group: RailGroup = "all"): string {
  return `${section}:${page}${group === "all" ? "" : `:${group}`}`;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly rails: readonly EditorialHomeRail[];
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<EditorialHomeResult>>();

export function isEditorialHomeRail(value: unknown): value is EditorialHomeRail {
  if (typeof value !== "object" || value === null) return false;
  const rail = value as Partial<EditorialHomeRail>;
  const provider = rail.provider as Partial<EditorialProvider> | null | undefined;
  const validProvider = provider === undefined || provider === null ||
    (typeof provider.id === "number" && typeof provider.name === "string" && (typeof provider.logoUrl === "string" || provider.logoUrl === null));
  return validProvider && typeof rail.id === "string" && typeof rail.title === "string" && Array.isArray(rail.items) && rail.items.every((item) =>
    typeof item === "object" && item !== null && typeof item.tmdbId === "number" &&
    (item.type === "movie" || item.type === "series") && typeof item.title === "string"
  );
}

/** Storage pode faltar ou lançar (aba privada, TV, WebView restrito). Nunca é motivo de erro. */
function store(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function readStored(key: string): CacheEntry | null {
  const storage = store();
  if (!storage) return null;
  try {
    const raw = storage.getItem(`${EDITORIAL_HOME_STORAGE_PREFIX}${key}`);
    if (raw === null) return null;
    const entry = JSON.parse(raw) as Partial<CacheEntry>;
    if (typeof entry.expiresAt !== "number" || entry.expiresAt <= Date.now()) return null;
    if (!Array.isArray(entry.rails) || !entry.rails.every(isEditorialHomeRail)) return null;
    return { expiresAt: entry.expiresAt, rails: entry.rails };
  } catch {
    return null;
  }
}

function remember(key: string, rails: readonly EditorialHomeRail[]): void {
  const entry: CacheEntry = { expiresAt: Date.now() + TTL_MS, rails };
  cache.set(key, entry);
  const storage = store();
  if (!storage) return;
  try {
    storage.setItem(`${EDITORIAL_HOME_STORAGE_PREFIX}${key}`, JSON.stringify(entry));
  } catch {
    // Cota estourada não é falha da home: o cache de memória continua valendo.
  }
}

/** O que já está pronto, para a primeira renderização não piscar entre vazio e cheio. */
export function cachedEditorialHome(section: string, page = 1, group: RailGroup = "all"): readonly EditorialHomeRail[] | null {
  const key = pageKey(section, page, group);
  const known = cache.get(key);
  if (known && known.expiresAt > Date.now()) return known.rails;

  const stored = readStored(key);
  if (!stored) return null;
  // O `expiresAt` guardado é preservado, não recarimbado: renovar o prazo a cada reidratação
  // fazia uma seleção de 10 minutos ser servida por quase 20.
  cache.set(key, stored);
  return stored.rails;
}

export function loadEditorialHome(section: string, page = 1, group: RailGroup = "all"): Promise<EditorialHomeResult> {
  const key = pageKey(section, page, group);
  const ready = cachedEditorialHome(section, page, group);
  if (ready) return Promise.resolve({ status: "ok", rails: ready });

  const alreadyAsked = inFlight.get(key);
  if (alreadyAsked) return alreadyAsked;

  // Sem AbortController: quem pediu pode desmontar, mas a resposta ainda serve para a próxima
  // montagem. Abortar jogaria fora uma viagem já paga. Quem chama decide se ainda quer o
  // resultado — em `home-experience.tsx` isso é uma bandeira local no efeito.
  const request = apiFetch(`/v1/editorial/home?section=${encodeURIComponent(section)}&page=${page}${group === "all" ? "" : `&group=${group}`}`, {
    cache: "default",
    headers: { Accept: "application/json" }
  }).then(async (response): Promise<EditorialHomeResult> => {
    if (response.status === 401) return { status: "unauthorized" };
    if (!response.ok) return { status: "unavailable" };
    const body = await response.json() as { rails?: unknown };
    if (!Array.isArray(body.rails) || !body.rails.every(isEditorialHomeRail)) {
      return { status: "unavailable" };
    }
    remember(key, body.rails);
    return { status: "ok", rails: body.rails };
  }).catch((): EditorialHomeResult => ({ status: "unavailable" }))
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, request);
  return request;
}

/**
 * Só para os testes: zera o que o processo lembra. Remove exclusivamente as chaves com o nosso
 * prefixo — `clear()` derrubaria o depósito inteiro, inclusive a sessão do app.
 */
export function resetEditorialHomeCache(options: { readonly keepStorage?: boolean } = {}): void {
  cache.clear();
  inFlight.clear();
  if (options.keepStorage) return;
  const storage = store();
  if (!storage) return;
  try {
    const ours: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null && key.startsWith(EDITORIAL_HOME_STORAGE_PREFIX)) ours.push(key);
    }
    for (const key of ours) storage.removeItem(key);
  } catch {
    // Nada a fazer.
  }
}

/** Publica a categoria sem esperar pelas fileiras dos provedores. A ordem final é estável. */
export async function loadEditorialCategory(
  section: string,
  publish: (rails: readonly EditorialHomeRail[]) => void
): Promise<EditorialHomeResult> {
  const ready = cachedEditorialHome(section);
  if (ready) { publish(ready); return { status: "ok", rails: ready }; }
  if (!["movies", "series", "anime"].includes(section)) {
    const result = await loadEditorialHome(section);
    if (result.status === "ok") publish(result.rails);
    return result;
  }
  const parts: Partial<Record<RailGroup, readonly EditorialHomeRail[]>> = {};
  // Também aceita a API anterior durante uma atualização: ela ignora `group` e devolve tudo.
  const merged = () => [...new Map([...(parts.primary ?? []), ...(parts.providers ?? [])]
    .map((rail) => [rail.id, rail])).values()];
  const results = await Promise.all((["primary", "providers"] as const).map(async (group) => {
    const result = await loadEditorialHome(section, 1, group);
    if (result.status === "ok") {
      parts[group] = result.rails;
      publish(merged());
    }
    return result;
  }));
  if (results.some((result) => result.status === "unauthorized")) return { status: "unauthorized" };
  if (results.every((result) => result.status === "unavailable")) return { status: "unavailable" };
  const rails = merged();
  // Falha parcial não vira uma categoria incompleta guardada por dez minutos.
  if (results.every((result) => result.status === "ok")) remember(pageKey(section, 1), rails);
  return { status: "ok", rails };
}
