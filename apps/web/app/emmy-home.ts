"use client";

import type { EmmyWinner } from "@cebola/contracts";
import { apiFetch } from "./api-client";

/**
 * Vencedores do Emmy para a home. A curadoria mora na API (ver `editorial/client.ts`), então aqui
 * só se busca, valida e guarda por alguns minutos — no mesmo espírito de `editorial-home.ts`, mas
 * bem mais simples porque é uma lista só, igual para todo mundo.
 */

export type EmmyWinnersData = {
  readonly edition: number;
  readonly ceremonyName: string;
  readonly winners: readonly EmmyWinner[];
};

const TTL_MS = 30 * 60 * 1_000;
let cache: { expiresAt: number; value: EmmyWinnersData } | null = null;
let inFlight: Promise<EmmyWinnersData | null> | null = null;

function isEmmyWinner(value: unknown): value is EmmyWinner {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<EmmyWinner>;
  return (
    typeof item.tmdbId === "number" &&
    (item.type === "movie" || item.type === "series") &&
    typeof item.title === "string" &&
    Array.isArray(item.categories) && item.categories.every((category) => typeof category === "string")
  );
}

export async function loadEmmyWinners(): Promise<EmmyWinnersData | null> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  if (inFlight) return inFlight;

  inFlight = apiFetch("/v1/editorial/emmy", {
    cache: "default",
    headers: { Accept: "application/json" }
  }).then(async (response): Promise<EmmyWinnersData | null> => {
    if (!response.ok) return null;
    const body = (await response.json()) as { edition?: unknown; ceremonyName?: unknown; winners?: unknown };
    if (typeof body.edition !== "number" || !Array.isArray(body.winners)) return null;
    const winners = body.winners.filter(isEmmyWinner);
    if (winners.length === 0) return null;
    const value: EmmyWinnersData = {
      edition: body.edition,
      ceremonyName: typeof body.ceremonyName === "string" ? body.ceremonyName : `Emmy ${body.edition}`,
      winners
    };
    cache = { expiresAt: Date.now() + TTL_MS, value };
    return value;
  }).catch(() => null).finally(() => {
    inFlight = null;
  });

  return inFlight;
}
