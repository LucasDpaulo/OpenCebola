import { z } from "zod";

const boundedString = (maximum: number) => z.string().trim().min(1).max(maximum);

// Vários add-ons reais mandam "idPrefixes: null" em vez de simplesmente omitir o campo (ex.:
// Comet | ElfHosted, OpenSubtitles, Local Files). O schema aceita null como equivalente a
// ausente e normaliza para undefined no parse, para o restante do código (ex.: matchesResource
// em gateway.ts) continuar enxergando "sem prefixos" de uma única forma, sem precisar saber
// que null existe.
const optionalIdPrefixes = (maxLength: number) =>
  z.array(boundedString(100)).max(maxLength).nullish().transform((value) => value ?? undefined);

export const addonResourceSchema = z.union([
  boundedString(50),
  z.object({
    name: boundedString(50),
    types: z.array(boundedString(50)).max(20).optional(),
    idPrefixes: optionalIdPrefixes(50)
  }).passthrough()
]);

export const addonCatalogSchema = z.object({
  id: boundedString(200),
  // Não é mais um enum restrito a "movie"/"series": add-ons reais usam "other", "tv", "anime",
  // "channels" etc. Um tipo desconhecido não pode mais derrubar o add-on inteiro na validação —
  // quem decide o que é navegável é o gateway (listCatalogs), que filtra para movie/series.
  type: boundedString(50),
  // BT4G e Public Domain Movies, por exemplo, mandam "name: null" em vez de omitir o campo.
  name: boundedString(200).nullish().transform((value) => value ?? undefined)
}).passthrough();

export const addonManifestSchema = z.object({
  id: boundedString(200),
  version: boundedString(100),
  name: boundedString(200),
  description: z.string().max(2_000).optional(),
  resources: z.array(addonResourceSchema).max(50),
  types: z.array(boundedString(50)).max(50),
  catalogs: z.array(addonCatalogSchema).max(100).default([]),
  idPrefixes: optionalIdPrefixes(100)
}).passthrough();

export const addonDescriptorSchema = z.object({
  manifest: addonManifestSchema,
  transportUrl: z.string().url().max(4_096)
}).passthrough();

export const addonCollectionSchema = z.array(addonDescriptorSchema).max(100);

export type AddonManifest = z.infer<typeof addonManifestSchema>;
export type AddonDescriptor = z.infer<typeof addonDescriptorSchema>;

export interface StremioConnection {
  readonly householdId: string;
  readonly authKey: string;
  readonly addons: readonly AddonDescriptor[];
  readonly syncedAt: Date;
}

export interface StremioConnectionStatus {
  readonly addonCount: number;
  readonly syncedAt: Date;
}

export class StremioIntegrationError extends Error {
  readonly code:
    | "AUTHENTICATION_FAILED"
    | "NOT_LINKED"
    | "UPSTREAM_UNAVAILABLE"
    | "ADDON_NOT_FOUND"
    | "UNSAFE_ADDON"
    | "INVALID_RESPONSE";

  constructor(code: StremioIntegrationError["code"]) {
    super("Não foi possível concluir a operação com o Stremio.");
    this.name = "StremioIntegrationError";
    this.code = code;
  }
}

export class RealDebridError extends Error {
  readonly code: "NOT_CONFIGURED" | "AUTHENTICATION_FAILED" | "TRAFFIC_EXHAUSTED" |
    "INFRINGING_FILE" | "NOT_PLAYABLE_FILE" | "UNAVAILABLE" | "INVALID_RESPONSE";
  /**
   * Contexto para o log do servidor, NUNCA para a resposta ao navegador. "UNAVAILABLE" era
   * lançado tanto para falha de rede quanto para qualquer status ruim, e o status de origem era
   * descartado — na produção isso virava um 503 mudo, impossível de investigar.
   *
   * Só entra aqui o que é seguro registrar: endpoint e status. Token, link liberado e nome de
   * arquivo ficam de fora.
   */
  readonly detail?: string;

  constructor(code: RealDebridError["code"], detail?: string) {
    super("Não foi possível concluir a operação no Real-Debrid.");
    this.name = "RealDebridError";
    this.code = code;
    this.detail = detail;
  }
}

export function resourceSupported(manifest: AddonManifest, resource: string): boolean {
  return manifest.resources.some((entry) =>
    typeof entry === "string" ? entry === resource : entry.name === resource
  );
}
