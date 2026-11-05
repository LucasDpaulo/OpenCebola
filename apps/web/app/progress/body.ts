// MÓDULO PROTEGIDO — salvamento de progresso. Não alterar sem pedido explícito do Lucas (ver AGENTS.md).
import {
  playbackSourceSchema,
  playbackTrackSelectionSchema,
  subtitleSettingsSchema,
  updateWatchProgressRequestSchema
} from "@cebola/contracts";
import { progressVideoId } from "./identity";

/** Maior duração que o contrato aceita (7 dias, em segundos). */
const MAX_SECONDS = 604_800;
/** Maior número de temporada/episódio que o contrato aceita. */
const MAX_EPISODE_NUMBER = 10_000;

/**
 * Tipos soltos de propósito: o corpo nasce de leituras de player, de metadados de addon e de um
 * cenário que veio da tela — textos podem vir vazios/nulos e números podem ser NaN. Quem decide o
 * que é válido é este módulo, não o chamador.
 */
export interface ProgressBodyInput {
  readonly addonId?: string | null;
  readonly playbackAddonId?: string | null;
  readonly mediaId?: string | null;
  readonly videoId?: string | null;
  readonly mediaType?: string | null;
  readonly title?: string | null;
  readonly episodeTitle?: string | null;
  readonly season?: number | null;
  readonly episode?: number | null;
  readonly posterUrl?: string | null;
  readonly positionSeconds?: number | null;
  readonly durationSeconds?: number | null;
  readonly completed?: boolean | null;
  /** Cenário atual (fonte, áudio, legenda, ajustes). Qualquer valor: o que não prestar é descartado. */
  readonly scenario?: unknown;
  /** Última versão boa do cenário; cada parte inválida do atual cai para a mesma parte daqui. */
  readonly fallbackScenario?: unknown;
}

export type ProgressBodyResult =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly reason: string };

function fail(reason: string): ProgressBodyResult {
  return { ok: false, reason };
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Texto aparado e cortado no máximo do contrato; vazio vira `null`. Não deixa meio par substituto
 * no fim do corte (emoji partido ao meio vira JSON que o banco recusa).
 */
function text(value: unknown, max: number): string | null {
  const whole = trimmed(value);
  if (whole === "") return null;
  let cut = whole.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (cut.length < whole.length && last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  const result = cut.trim();
  return result === "" ? null : result;
}

function wholeSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null;
}

function episodeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_EPISODE_NUMBER
    ? value : null;
}

/** O contrato só aceita pôster `https:`; qualquer outra coisa vira `null` em vez de recusar tudo. */
function posterUrl(value: unknown): string | null {
  const url = text(value, Number.MAX_SAFE_INTEGER);
  if (url === null || url.length > 2_048) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- Cenário: cada parte é validada sozinha, com o schema da própria parte ---

function normalizeSource(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  // Só as chaves do contrato: `url` (temporária) e qualquer outra coisa nunca viajam.
  return {
    addonId: text(value.addonId, 200),
    streamId: text(value.streamId, 128),
    infoHash: text(value.infoHash, Number.MAX_SAFE_INTEGER),
    fileIdx: value.fileIdx ?? null,
    releaseTitle: text(value.releaseTitle, 300)
  };
}

/** Faixa sem idioma/nome é comum em MKV ("Track 2", ""): vazio vira `null`, que o contrato aceita. */
function normalizeTrack(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  return { id: text(value.id, 200), language: text(value.language, 35), name: text(value.name, 300) };
}

/** Só os ajustes que o contrato conhece: `position` (altura, só do aparelho) e o resto ficam de fora. */
function normalizeSubtitleSettings(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  return {
    offset: value.offset,
    extraDuration: value.extraDuration,
    color: value.color,
    size: value.size,
    bg: value.bg,
    font: value.font
  };
}

interface PartSchema {
  safeParse(value: unknown): { success: true; data: unknown } | { success: false };
}

interface ScenarioPart {
  readonly key: "source" | "audio" | "subtitle" | "subtitleSettings";
  readonly normalize: (value: unknown) => unknown;
  readonly schema: PartSchema;
}

const SCENARIO_PARTS: readonly ScenarioPart[] = [
  { key: "source", normalize: normalizeSource, schema: playbackSourceSchema },
  { key: "audio", normalize: normalizeTrack, schema: playbackTrackSelectionSchema },
  { key: "subtitle", normalize: normalizeTrack, schema: playbackTrackSelectionSchema },
  { key: "subtitleSettings", normalize: normalizeSubtitleSettings, schema: subtitleSettingsSchema }
];

type PartRead =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly value: unknown };

const ABSENT: PartRead = { kind: "absent" };
const INVALID: PartRead = { kind: "invalid" };

function readPart(part: ScenarioPart, raw: unknown): PartRead {
  // Ausente continua ausente. `null` é uma escolha (legenda desligada) e o contrato a aceita.
  if (raw === undefined) return ABSENT;
  if (raw === null) return { kind: "valid", value: null };
  const parsed = part.schema.safeParse(part.normalize(raw));
  return parsed.success ? { kind: "valid", value: parsed.data } : INVALID;
}

/**
 * Monta o cenário parte por parte. Parte inválida cai para a mesma parte do `fallback` (se ela
 * prestar) ou é omitida — e a posição do vídeo nunca depende disso. Sem nenhuma parte, não há
 * cenário. Um valor que nem é objeto conta como inválido em todas as partes.
 */
function buildScenario(scenario: unknown, fallback: unknown): Record<string, unknown> | null {
  try {
    const garbage = scenario !== undefined && scenario !== null && !isPlainObject(scenario);
    const current = isPlainObject(scenario) ? scenario : null;
    const previous = isPlainObject(fallback) ? fallback : null;
    const result: Record<string, unknown> = {};
    for (const part of SCENARIO_PARTS) {
      let read = garbage ? INVALID : current === null ? ABSENT : readPart(part, current[part.key]);
      if (read.kind === "invalid") {
        read = previous === null ? ABSENT : readPart(part, previous[part.key]);
      }
      if (read.kind === "valid") result[part.key] = read.value;
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    // Um cenário que não dá nem para ler (getter que lança, por exemplo) é só um cenário a menos.
    return null;
  }
}

function describeIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues.map((issue) => `${issue.path.map(String).join(".") || "(corpo)"}: ${issue.message}`).join("; ");
}

function build(input: ProgressBodyInput): ProgressBodyResult {
  const durationSeconds = wholeSeconds(input.durationSeconds);
  if (durationSeconds === null || durationSeconds < 1 || durationSeconds > MAX_SECONDS) {
    return fail(`duração inválida: ${String(input.durationSeconds)}`);
  }
  const completed = input.completed === true;
  let positionSeconds = durationSeconds;
  if (!completed) {
    const position = wholeSeconds(input.positionSeconds);
    if (position === null) return fail(`posição inválida: ${String(input.positionSeconds)}`);
    // Posição zero é player recém-aberto ou em desmontagem, não progresso: gravá-la apagaria no
    // servidor o ponto em que a pessoa parou.
    if (position <= 0) return fail("posição zero não é gravada (apagaria a retomada salva)");
    positionSeconds = Math.min(position, durationSeconds);
  }

  const mediaId = trimmed(input.mediaId);
  if (mediaId === "") return fail("mediaId vazio");
  const mediaType = input.mediaType === "movie" || input.mediaType === "series" ? input.mediaType : null;
  if (mediaType === null) return fail(`mediaType inválido: ${String(input.mediaType)}`);

  const base = {
    addonId: text(input.addonId, 200),
    playbackAddonId: text(input.playbackAddonId, 200),
    mediaId,
    videoId: progressVideoId({ mediaType, mediaId, videoId: trimmed(input.videoId) }),
    mediaType,
    title: text(input.title, 300) ?? text(mediaId, 300),
    episodeTitle: mediaType === "series" ? text(input.episodeTitle, 300) : null,
    season: episodeNumber(input.season),
    episode: episodeNumber(input.episode),
    posterUrl: posterUrl(input.posterUrl),
    positionSeconds,
    durationSeconds,
    completed
  };

  // Garantia final: o corpo só sai se o contrato da API o aceitar. Se o cenário for o problema
  // (algo que nenhuma regra acima previu), a posição segue sem ele.
  const scenario = buildScenario(input.scenario, input.fallbackScenario);
  const attempts = scenario === null ? [base] : [{ ...base, playbackScenario: scenario }, base];
  let issues = "";
  for (const attempt of attempts) {
    const parsed = updateWatchProgressRequestSchema.safeParse(attempt);
    if (parsed.success) return { ok: true, body: JSON.stringify(parsed.data) };
    issues = describeIssues(parsed.error.issues);
  }
  return fail(`o contrato recusou o corpo (${issues})`);
}

/**
 * Corpo do `PUT /v1/progress`, sempre válido no contrato ou recusado aqui — nunca um corpo que a
 * API devolveria 400 (um campo inválido recusa TUDO, inclusive a posição). Nunca lança.
 */
export function buildProgressBody(input: ProgressBodyInput): ProgressBodyResult {
  try {
    return build(input);
  } catch (error) {
    return fail(`erro inesperado ao montar o corpo: ${error instanceof Error ? error.message : String(error)}`);
  }
}
