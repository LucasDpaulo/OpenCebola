"use client";

import type { LibraryItem, UpsertLibraryItemRequest } from "@cebola/contracts";
import { libraryItemSchema, libraryResponseSchema, upsertLibraryItemRequestSchema } from "@cebola/contracts";
import { apiFetch } from "./api-client";

/**
 * Migração única da biblioteca do aparelho para a conta.
 *
 * Antes da conta existir, a biblioteca vivia só no `localStorage`, sob a chave
 * `cebola:library:<profileId>` (ver `home-experience.tsx`). Agora a API é a fonte oficial; este
 * módulo lê o que sobrou no aparelho, tenta importar uma única vez por perfil e nunca apaga nada
 * — só une. `libraryMigrationKey` marca que a importação já aconteceu; sem essa marca, toda
 * inicialização tentaria de novo, duplicando a viagem de rede a cada abertura.
 */

const LEGACY_LIBRARY_PREFIX = "cebola:library:";
// Mesmo teto de `importLibraryRequestSchema`: o aparelho pode ter guardado mais do que o
// servidor aceita numa importação só, e truncar aqui evita mandar um payload que a API recusaria
// inteiro por causa de uma sobra antiga.
const MAX_LEGACY_ITEMS = 200;

export interface ImportLegacyLibraryResult {
  readonly items: readonly LibraryItem[];
  readonly synced: boolean;
}

/** Storage pode faltar ou lançar (aba privada, TV, WebView restrito). Nunca é motivo de erro. */
function store(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

export function libraryMigrationKey(profileId: string): string {
  return `cebola:library:migrated:${profileId}:v1`;
}

/**
 * O formato antigo guarda `poster`/`background`; o contrato da conta usa `posterUrl`/
 * `backgroundUrl`. Campos de identidade (addonId, mediaId, mediaType, name) passam direto para o
 * schema — se estiverem errados, o item inteiro é descartado. As URLs decorativas degradam para
 * `null` em vez de derrubar o item: um pôster corrompido não é motivo para perder o favorito.
 */
function mapLegacyEntry(value: unknown): UpsertLibraryItemRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const candidate = {
    addonId: raw.addonId,
    mediaId: raw.id,
    mediaType: raw.type,
    name: raw.name,
    posterUrl: typeof raw.poster === "string" ? raw.poster : null,
    backgroundUrl: typeof raw.background === "string" ? raw.background : null,
    description: typeof raw.description === "string" ? raw.description : null,
    releaseInfo: typeof raw.releaseInfo === "string" ? raw.releaseInfo : null
  };
  const parsed = upsertLibraryItemRequestSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Lê a biblioteca legada do aparelho. Lixo no storage nunca derruba a home: vira lista vazia. */
export function readLegacyLibrary(profileId: string): readonly UpsertLibraryItemRequest[] {
  const storage = store();
  if (!storage) return [];
  try {
    const raw = storage.getItem(`${LEGACY_LIBRARY_PREFIX}${profileId}`);
    if (!raw) return [];
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .map(mapLegacyEntry)
      .filter((item): item is UpsertLibraryItemRequest => item !== null)
      .slice(0, MAX_LEGACY_ITEMS);
  } catch {
    return [];
  }
}

function itemKey(mediaType: string, mediaId: string): string {
  return `${mediaType}:${mediaId}`;
}

/**
 * União por `mediaType` + `mediaId`. Em conflito, a conta vence sempre: depois da sincronização
 * ela é a fonte oficial, e o item local pode estar desatualizado ou já ter sido removido em
 * outro aparelho. Itens só locais recebem um `id` e timestamps provisórios — servem para exibir
 * a lista antes da confirmação do servidor, nunca são persistidos como se fossem reais.
 */
export function mergeLibraryItems(
  account: readonly LibraryItem[],
  local: readonly UpsertLibraryItemRequest[]
): readonly LibraryItem[] {
  const known = new Set(account.map((item) => itemKey(item.mediaType, item.mediaId)));
  const now = new Date().toISOString();
  const seen = new Set<string>();
  const localOnly: LibraryItem[] = [];
  for (const item of local) {
    const key = itemKey(item.mediaType, item.mediaId);
    if (known.has(key) || seen.has(key)) continue;
    seen.add(key);
    localOnly.push({
      id: crypto.randomUUID(),
      ...item,
      createdAt: now,
      updatedAt: now
    });
  }
  return [...account, ...localOnly];
}

function markMigrated(profileId: string): void {
  const storage = store();
  if (!storage) return;
  try {
    storage.setItem(libraryMigrationKey(profileId), "1");
  } catch {
    // Sem storage utilizável, a próxima abertura tenta de novo — aceitável.
  }
}

function alreadyMigrated(profileId: string): boolean {
  const storage = store();
  if (!storage) return false;
  try {
    return storage.getItem(libraryMigrationKey(profileId)) === "1";
  } catch {
    return false;
  }
}

/**
 * Importa a biblioteca legada uma única vez por perfil. Sucesso grava a marca de migração e
 * devolve a lista canônica da conta. Falha NUNCA grava a marca — a próxima chamada tenta de novo
 * — e devolve uma união temporária (conta + local) com `synced: false`, para a tela não esconder
 * o que a pessoa já tinha guardado enquanto a conta não confirma o recebimento.
 */
export async function importLegacyLibrary(
  profileId: string,
  accountItems: readonly LibraryItem[]
): Promise<ImportLegacyLibraryResult> {
  if (alreadyMigrated(profileId)) return { items: accountItems, synced: true };

  const legacy = readLegacyLibrary(profileId);
  if (legacy.length === 0) {
    markMigrated(profileId);
    return { items: accountItems, synced: true };
  }

  try {
    const response = await apiFetch("/v1/library/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ items: legacy })
    });
    if (!response.ok) return { items: mergeLibraryItems(accountItems, legacy), synced: false };

    const body = await response.json() as unknown;
    const parsed = libraryResponseSchema.safeParse(body);
    if (!parsed.success) return { items: mergeLibraryItems(accountItems, legacy), synced: false };

    markMigrated(profileId);
    return { items: parsed.data.items, synced: true };
  } catch {
    return { items: mergeLibraryItems(accountItems, legacy), synced: false };
  }
}

/**
 * Forma mínima que a home e a tela de título têm em comum para um card/obra: o suficiente para
 * montar o corpo de `PUT /v1/library`. `CatalogItem` (home) e `Meta` (título) satisfazem esta
 * forma estruturalmente, sem precisar de conversão explícita nem de importar tipos um do outro.
 */
export interface LibraryToggleTarget {
  readonly id: string;
  readonly type: "movie" | "series";
  readonly name: string;
  readonly poster: string | null;
  readonly background: string | null;
  readonly description: string | null;
  readonly releaseInfo: string | null;
}

export interface ApplyLibraryChangeParams {
  readonly current: readonly LibraryItem[];
  readonly item: LibraryToggleTarget;
  readonly addonId: string;
  readonly request: (path: string, init?: RequestInit) => Promise<Response>;
  /**
   * Chamado de forma síncrona, antes de qualquer `await`, com a lista já otimisticamente
   * atualizada — é assim que a tela reflete o toque da pessoa sem esperar a rede.
   */
  readonly onOptimistic: (next: readonly LibraryItem[]) => void;
  readonly makeId?: () => string;
  readonly now?: () => string;
}

export interface ApplyLibraryChangeResult {
  readonly items: readonly LibraryItem[];
  readonly ok: boolean;
}

/**
 * Adiciona (`PUT`) ou remove (`DELETE`) um item da biblioteca da conta a partir da lista
 * canônica atual, com atualização otimista e reversão em falha. `current` nunca é mutado: em
 * qualquer falha (resposta não-ok, corpo inválido ou exceção de rede) a função devolve
 * exatamente o `current` recebido — o chamador restaura o estado anterior só usando
 * `result.items`, sem lógica própria de rollback.
 */
export async function applyLibraryChange(
  params: ApplyLibraryChangeParams
): Promise<ApplyLibraryChangeResult> {
  const {
    current,
    item,
    addonId,
    request,
    onOptimistic,
    makeId = () => crypto.randomUUID(),
    now = () => new Date().toISOString()
  } = params;

  const existing = current.find((entry) => entry.mediaId === item.id && entry.mediaType === item.type);

  if (existing) {
    const next = current.filter((entry) => entry.id !== existing.id);
    onOptimistic(next);
    try {
      const response = await request(
        `/v1/library/${encodeURIComponent(item.type)}/${encodeURIComponent(item.id)}`,
        { method: "DELETE", headers: { Accept: "application/json" } }
      );
      if (!response.ok) return { items: current, ok: false };
      return { items: next, ok: true };
    } catch {
      return { items: current, ok: false };
    }
  }

  const optimisticItem: LibraryItem = {
    id: makeId(),
    addonId,
    mediaId: item.id,
    mediaType: item.type,
    name: item.name,
    posterUrl: item.poster,
    backgroundUrl: item.background,
    description: item.description,
    releaseInfo: item.releaseInfo,
    createdAt: now(),
    updatedAt: now()
  };
  const next = [optimisticItem, ...current];
  onOptimistic(next);
  try {
    const response = await request("/v1/library", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        addonId,
        mediaId: item.id,
        mediaType: item.type,
        name: item.name,
        posterUrl: item.poster,
        backgroundUrl: item.background,
        description: item.description,
        releaseInfo: item.releaseInfo
      })
    });
    if (!response.ok) return { items: current, ok: false };
    const body = await response.json() as unknown;
    const parsed = libraryItemSchema.safeParse(body);
    if (!parsed.success) return { items: current, ok: false };
    return { items: [parsed.data, ...current], ok: true };
  } catch {
    return { items: current, ok: false };
  }
}
