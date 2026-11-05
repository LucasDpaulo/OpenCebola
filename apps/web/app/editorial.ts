"use client";

import { useEffect, useState } from "react";
import type { EditorialTitleResponse, MediaType } from "@cebola/contracts";
import { apiFetch } from "./api-client";


/**
 * Cache de processo para o enriquecimento do TMDB.
 *
 * Antes, cada card pedia por conta própria e nada era reaproveitado: voltar da página de um
 * título refazia todas as consultas da home, e o mesmo filme que aparece em duas rails era
 * pedido duas vezes. Com o teto da rota em 60 por 5 minutos POR IP, passear pela home bastava
 * para começar a receber 429 — e como o código só olha `response.ok`, o enriquecimento sumia
 * da tela sem nenhum aviso. O teto subiu, mas o desperdício era o problema de verdade.
 *
 * Vive fora do React de propósito: precisa sobreviver à desmontagem dos cards durante o scroll
 * (as rails usam content-visibility) e é zerado ao recarregar a página, então dados do TMDB
 * nunca envelhecem além da sessão.
 */
const cache = new Map<string, EditorialTitleResponse | null>();
const inFlight = new Map<string, Promise<EditorialTitleResponse | null>>();
const failedAt = new Map<string, number>();

// Falha não é resposta: 429 e queda de rede voltam a ser tentadas, só não de imediato.
const RETRY_AFTER_FAILURE_MS = 60_000;
// Teto de memória. A home carrega poucas centenas de títulos; passar disso é navegação longa,
// e descartar o mais antigo é suficiente — o servidor mantém o mesmo dado 6 h em cache.
const MAX_ENTRIES = 500;

export interface EditorialLookup {
  readonly type: MediaType;
  readonly mediaId: string;
  readonly title: string;
  readonly year?: number | null;
}

function lookupKey(lookup: EditorialLookup): string {
  return `${lookup.type}:${lookup.mediaId}:${lookup.year ?? ""}`;
}

export function isEditorialTitle(value: unknown): value is EditorialTitleResponse {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<EditorialTitleResponse>;
  return typeof item.tmdbId === "number" && (item.type === "movie" || item.type === "series") &&
    typeof item.title === "string" && Array.isArray(item.cast) && Array.isArray(item.recommendations) &&
    typeof item.availability === "object" && item.availability !== null;
}

/** Identificador do vídeo no YouTube, a partir da URL de trailer que o TMDB devolve. */
export function youtubeId(trailerUrl: string | null | undefined): string | null {
  if (!trailerUrl) return null;
  try {
    const url = new URL(trailerUrl);
    const id = url.searchParams.get("v") ?? url.pathname.split("/").pop() ?? "";
    return /^[A-Za-z0-9_-]{5,20}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function cachedEditorial(lookup: EditorialLookup): EditorialTitleResponse | null {
  return cache.get(lookupKey(lookup)) ?? null;
}

export function loadEditorial(lookup: EditorialLookup): Promise<EditorialTitleResponse | null> {
  const key = lookupKey(lookup);
  const cached = cache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);

  const pending = inFlight.get(key);
  if (pending) return pending;

  const lastFailure = failedAt.get(key);
  if (lastFailure !== undefined && Date.now() - lastFailure < RETRY_AFTER_FAILURE_MS) {
    return Promise.resolve(null);
  }

  const query = new URLSearchParams({ title: lookup.title });
  if (lookup.year) query.set("year", String(lookup.year));
  const path = [lookup.type, lookup.mediaId].map(encodeURIComponent).join("/");

  // Sem AbortController: quem pediu pode desmontar, mas a resposta ainda serve para o próximo
  // card. Abortar aqui jogaria fora uma consulta já paga e devolveria a lista ao estado antigo.
  // `default` e não `no-store`: a rota devolve `private, max-age=3600` e o corpo é o mesmo
  // para todo mundo. Deixar o navegador guardar é o que faz voltar para a home não repetir
  // dezenas de consultas que já foram pagas.
  const request = apiFetch(`/v1/editorial/${path}?${query.toString()}`, {
    cache: "default",
    headers: { Accept: "application/json" }
  }).then(async (response) => {
    if (!response.ok) {
      // 404 é resposta definitiva: este título não existe no TMDB e perguntar de novo não muda.
      // Qualquer outro status é transitório e merece nova chance depois do intervalo.
      if (response.status === 404) rememberValue(key, null);
      else failedAt.set(key, Date.now());
      return null;
    }
    const body = await response.json() as unknown;
    if (!isEditorialTitle(body)) {
      failedAt.set(key, Date.now());
      return null;
    }
    rememberValue(key, body);
    return body;
  }).catch(() => {
    failedAt.set(key, Date.now());
    return null;
  }).finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, request);
  return request;
}

function rememberValue(key: string, value: EditorialTitleResponse | null): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  failedAt.delete(key);
  cache.set(key, value);
}

/**
 * Busca sob demanda: `enabled` é o que decide, e o resultado já em cache aparece na primeira
 * renderização — sem piscar entre "sem dados" e "com dados" ao voltar para a home.
 */
export function useEditorial(
  lookup: EditorialLookup | null,
  enabled: boolean
): EditorialTitleResponse | null {
  const [value, setValue] = useState<EditorialTitleResponse | null>(
    () => lookup ? cachedEditorial(lookup) : null
  );
  const key = lookup ? lookupKey(lookup) : null;

  useEffect(() => {
    if (!lookup) {
      setValue(null);
      return;
    }
    const known = cachedEditorial(lookup);
    setValue(known);
    if (known || !enabled) return;

    let current = true;
    void loadEditorial(lookup).then((result) => {
      if (current && result) setValue(result);
    });
    return () => {
      current = false;
    };
    // A identidade do objeto muda a cada render de quem chama; a chave é o que importa.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return value;
}
