// Abertura/recapitulação/encerramento (task "pular abertura e próximo episódio"). Puro e sem
// nenhuma dependência do player: só transforma os segmentos que a API devolve em blocos exibíveis
// e responde perguntas de "o que mostrar agora" a partir da posição/duração atuais.
//
// Regra do Lucas (2026-09-25, ver o plano): um só botão no começo. Segmentos `intro`/`recap` com
// intervalo de até 10s entre si (em qualquer ordem) viram UM bloco "Pular abertura" que salta do
// início do bloco para o fim do ÚLTIMO segmento. Segmentos separados por mais que isso (cold open)
// continuam como blocos distintos — cada um com o mesmo botão, sem pular o que está no meio.

export type SkipSegmentKind = "intro" | "recap" | "outro";

export interface SkipSegment {
  readonly kind: SkipSegmentKind;
  readonly start: number;
  readonly end: number;
  // null quando a fonte (AniSkip) não informou a duração do episódio usado no cálculo.
  readonly episodeLength: number | null;
}

export type SkipBlockKind = "opening" | "outro";

export interface SkipBlock {
  readonly kind: SkipBlockKind;
  readonly start: number;
  readonly end: number;
  readonly episodeLength: number | null;
  /** Marcações originais: agrupar a ação de pular não apaga a identificação dos trechos. */
  readonly segments?: readonly SkipSegment[];
}

const OPENING_MERGE_GAP_SECONDS = 10;
const EPISODE_LENGTH_TOLERANCE = 0.05;
const SKIP_BUTTON_ALWAYS_VISIBLE_SECONDS = 10;
const NEXT_EPISODE_DEFAULT_MARGIN_SECONDS = 60;
const NEXT_EPISODE_LONG_EPISODE_MARGIN_SECONDS = 90;
const NEXT_EPISODE_LONG_EPISODE_THRESHOLD_SECONDS = 40 * 60;
// Episódio curto (anime): sem encerramento conhecido, o final da história costuma estar a ~40 s do
// fim (no One Piece, "To Be Continued" em 23:10 de 23:51, seguido só da prévia). 60 s caía na história.
const NEXT_EPISODE_SHORT_EPISODE_MARGIN_SECONDS = 45;
const NEXT_EPISODE_SHORT_EPISODE_THRESHOLD_SECONDS = 30 * 60;
// 5 s (era 10, depois 3): tempo de ver o cartão e cancelar, sem esperar à toa (pedido do Lucas).
export const NEXT_EPISODE_COUNTDOWN_SECONDS = 5;
// Contagem do "Pular abertura" automático: dá para cancelar se a pessoa quiser ver a abertura.
export const AUTO_SKIP_COUNTDOWN_SECONDS = 2;

/**
 * Junta intro+recap contíguos (gap <= 10s, em qualquer ordem) num só bloco "opening" que vai do
 * primeiro início ao último fim. Segmentos mais afastados viram blocos "opening" separados —
 * mesmo rótulo/botão, cada um pulando só o próprio trecho. `outro` nunca entra nessa fusão.
 */
export function mergeOpeningSegments(segments: readonly SkipSegment[]): readonly SkipBlock[] {
  const openings = segments
    .filter((segment) => segment.kind === "intro" || segment.kind === "recap")
    .slice()
    .sort((a, b) => a.start - b.start);

  const blocks: SkipBlock[] = [];
  let current: { start: number; end: number; episodeLength: number | null } | null = null;
  for (const segment of openings) {
    if (current && segment.start - current.end <= OPENING_MERGE_GAP_SECONDS) {
      current.end = Math.max(current.end, segment.end);
      if (current.episodeLength === null) current.episodeLength = segment.episodeLength;
    } else {
      if (current) blocks.push({ kind: "opening", ...current });
      current = { start: segment.start, end: segment.end, episodeLength: segment.episodeLength };
    }
  }
  if (current) blocks.push({ kind: "opening", ...current });

  const outros: SkipBlock[] = segments
    .filter((segment) => segment.kind === "outro")
    .map((segment) => ({ kind: "outro", start: segment.start, end: segment.end, episodeLength: segment.episodeLength }));

  return [...blocks, ...outros].sort((a, b) => a.start - b.start);
}

export function playbackSkipBlocks(segments: readonly SkipSegment[]): readonly SkipBlock[] {
  return mergeOpeningSegments(segments).map((block) => ({
    ...block,
    segments: segments.filter((segment) =>
      (block.kind === "outro" ? segment.kind === "outro" : segment.kind !== "outro") &&
      segment.start >= block.start && segment.end <= block.end)
  }));
}

export function skipBlockLabel(block: SkipBlock): string {
  if (block.kind === "outro") return "Pular encerramento";
  const hasIntro = block.segments?.some((segment) => segment.kind === "intro");
  const hasRecap = block.segments?.some((segment) => segment.kind === "recap");
  return hasRecap ? (hasIntro ? "Pular abertura e resumo" : "Pular resumo") : "Pular abertura";
}

/**
 * Um `episodeLength` que destoa da duração real em mais de 5% denuncia uma release com cortes
 * diferentes (abertura removida, por exemplo) — os tempos calculados por ele já não valem para
 * ESTE arquivo, então descartamos o conjunto inteiro em vez de confiar em parte dele.
 */
function segmentsAreReliable(blocks: readonly SkipBlock[], durationSeconds: number): boolean {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return true;
  return blocks.every((block) => {
    if (block.episodeLength === null) return true;
    return Math.abs(block.episodeLength - durationSeconds) / durationSeconds <= EPISODE_LENGTH_TOLERANCE;
  });
}

/** O bloco que contém a posição atual, ou null (fora de qualquer bloco, ou conjunto não confiável). */
export function activeSkipSegment(
  blocks: readonly SkipBlock[],
  positionSeconds: number,
  durationSeconds: number
): SkipBlock | null {
  if (blocks.length === 0 || !segmentsAreReliable(blocks, durationSeconds)) return null;
  return blocks.find((block) => positionSeconds >= block.start && positionSeconds < block.end) ?? null;
}

// Um encerramento antes da metade do arquivo não é encerramento: é tempo de outro episódio
// (numeração absoluta trocada no AniSkip) ou capítulo "ED" mal posicionado no MKV.
const OUTRO_MIN_FRACTION_OF_EPISODE = 0.5;

/**
 * O encerramento só manda no cartão quando dá para confiar nele PARA ESTE ARQUIVO: duração já
 * conhecida, `episodeLength` compatível e começo na segunda metade. Antes ele valia sem checagem
 * nenhuma, e um tempo errado trocava de episódio segundos depois de abrir.
 */
function reliableOutro(blocks: readonly SkipBlock[], durationSeconds: number): SkipBlock | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  const outro = blocks.find((block) => block.kind === "outro");
  if (!outro || !segmentsAreReliable([outro], durationSeconds)) return null;
  if (outro.start < durationSeconds * OUTRO_MIN_FRACTION_OF_EPISODE || outro.start >= durationSeconds) return null;
  return outro;
}

/**
 * Início do cartão "Próximo episódio": o começo do encerramento quando ele é confiável; senão os
 * últimos 60s (90s em episódios de mais de 40 min). null quando a duração ainda não é conhecida.
 */
export function nextEpisodePromptStart(blocks: readonly SkipBlock[], durationSeconds: number): number | null {
  const outro = reliableOutro(blocks, durationSeconds);
  if (outro) return outro.start;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  const margin = durationSeconds > NEXT_EPISODE_LONG_EPISODE_THRESHOLD_SECONDS
    ? NEXT_EPISODE_LONG_EPISODE_MARGIN_SECONDS
    : durationSeconds <= NEXT_EPISODE_SHORT_EPISODE_THRESHOLD_SECONDS
      ? NEXT_EPISODE_SHORT_EPISODE_MARGIN_SECONDS
      : NEXT_EPISODE_DEFAULT_MARGIN_SECONDS;
  return Math.max(0, durationSeconds - margin);
}

/**
 * Só um encerramento marcado permite contagem antecipada. Sem ele, o cartão é manual;
 * a continuação automática depende do evento `ended` do player.
 */
export function nextEpisodeCountdownStart(blocks: readonly SkipBlock[], durationSeconds: number): number | null {
  return reliableOutro(blocks, durationSeconds)?.start ?? null;
}

/**
 * O botão "Pular abertura" some com o resto dos controles depois de inatividade — EXCETO nos
 * primeiros 10s do bloco, onde fica visível mesmo com os controles ocultos (dá tempo de reagir
 * assim que a abertura começa, sem depender de mexer no controle). Após uma busca manual,
 * permanece visível enquanto houver um bloco ativo.
 */
export function skipButtonVisible(active: SkipBlock | null, positionSeconds: number, controlsVisible: boolean, manualSeek = false): boolean {
  if (!active) return false;
  if (manualSeek) return true;
  if (positionSeconds - active.start < SKIP_BUTTON_ALWAYS_VISIBLE_SECONDS) return true;
  return controlsVisible;
}

/** Uma busca para o encerramento mantém a decisão de avançar nas mãos da pessoa. */
export function isManualEndingVisit(promptStart: number | null, position: number, manualTarget: number | null): boolean {
  return promptStart !== null && manualTarget !== null && manualTarget >= promptStart && position >= promptStart;
}

export interface NextEpisodePromptState {
  readonly visible: boolean;
  /** Só tem sentido quando `visible` é true; 5 no instante em que o cartão aparece, até 0. */
  readonly countdownSeconds: number;
  /** true no instante exato em que a contagem chega a zero — dispara `onNextEpisode` uma vez. */
  readonly triggerAutoplay: boolean;
}

/**
 * Estado do cartão de próximo episódio, derivado direto da posição — sem timer próprio: a
 * contagem regressiva É a distância entre a posição e o início do cartão, então ela nunca
 * dessincroniza de pausas ou variação de framerate do `requestAnimationFrame`.
 * Ao buscar manualmente para o encerramento, oferece apenas a ação, inclusive no fim exato.
 */
export function nextEpisodePromptState(
  promptStart: number | null,
  positionSeconds: number,
  durationSeconds: number,
  cancelled: boolean,
  countdownStart: number | null = promptStart,
  manualVisit = false
): NextEpisodePromptState {
  const hidden: NextEpisodePromptState = { visible: false, countdownSeconds: NEXT_EPISODE_COUNTDOWN_SECONDS, triggerAutoplay: false };
  if (promptStart === null || cancelled) return hidden;
  if (positionSeconds < promptStart) return hidden;
  if (manualVisit) return { ...hidden, visible: true };
  if (Number.isFinite(durationSeconds) && durationSeconds > 0 && positionSeconds >= durationSeconds) return hidden;
  // Um cartão por proximidade do fim oferece ação manual, nunca corta a história sozinho.
  if (countdownStart === null) return { ...hidden, visible: true };
  const elapsed = Math.max(0, positionSeconds - (countdownStart ?? promptStart));
  const countdownSeconds = Math.max(0, Math.ceil(NEXT_EPISODE_COUNTDOWN_SECONDS - elapsed));
  return { visible: true, countdownSeconds, triggerAutoplay: countdownSeconds <= 0 };
}

/** Voltar (seek) para antes do início do cartão desarma um "Cancelar" anterior: ao reaproximar do
 * fim de novo, o cartão deve poder aparecer outra vez. */
export function shouldResetNextEpisodeCancel(promptStart: number | null, positionSeconds: number): boolean {
  return promptStart !== null && positionSeconds < promptStart;
}

// ---------------------------------------------------------------------------
// Preferência "pular abertura automaticamente" (task 4 do plano)
// ---------------------------------------------------------------------------

const AUTO_SKIP_ENTRY_WINDOW_SECONDS = 3;

/**
 * Decide se o auto-skip deve agir AGORA. Só dispara quando a posição está a menos de ~3s do
 * INÍCIO do bloco — ou seja, a reprodução cruzou para dentro dele naturalmente (ou o episódio já
 * começou de lá, no caso de retomada). Um seek deliberado para o meio do bloco não conta como
 * "entrar" nele e não deve ser interrompido. `allowLateDiscovery` permite agir dentro do bloco
 * quando a identificação chegou tarde e a pessoa ainda não buscou uma posição manualmente.
 *
 * `skippedBlockStarts` guarda o `start` de cada bloco já tratado neste episódio — pelo auto-skip
 * ou pelo "Voltar" do aviso — e por isso funciona como o "não pular de novo este bloco" pedido:
 * uma vez marcado, nenhum reingresso (automático ou por seek manual) dispara de novo.
 */
export function shouldAutoSkipOpening(
  block: SkipBlock | null,
  positionSeconds: number,
  skippedBlockStarts: ReadonlySet<number>,
  allowLateDiscovery = false
): boolean {
  if (!block || block.kind !== "opening") return false;
  if (skippedBlockStarts.has(block.start)) return false;
  if (positionSeconds < block.start || positionSeconds >= block.end) return false;
  return allowLateDiscovery || positionSeconds - block.start < AUTO_SKIP_ENTRY_WINDOW_SECONDS;
}

// ---------------------------------------------------------------------------
// Capítulos nativos (MKV via libVLC) como fallback quando a API não tem segmentos (task 5)
// ---------------------------------------------------------------------------

export interface NativeChapter {
  readonly name: string;
  /** Segundos, já convertidos pela camada nativa (o motor entrega em milissegundos). */
  readonly start: number;
  readonly end: number;
}

const CHAPTER_INTRO_PATTERN = /^(op|opening|intro|abertura)\b/i;
// Prévia do próximo episódio também conta como "final": depois dela não há mais história.
const CHAPTER_OUTRO_PATTERN = /^(?:(?:ed|ending|outro|credits|cr[ée]ditos|encerramento|preview|next\s*(?:episode|time)|pr[óo]ximo|pr[ée]via|yokoku)\b|予告)/i;
const CHAPTER_RECAP_PATTERN = /recap|previously|anteriormente|resumo|前回/i;

/**
 * Traduz capítulos crus do arquivo (nomes como "OP", "Ending", "Recap") para os mesmos segmentos
 * que a API de skip-times devolveria. Só usado quando ela não tem dado nenhum — nunca por cima
 * dele. Capítulos sem nome reconhecível (ex.: "Chapter 3", cenas normais) são ignorados: um
 * capítulo qualquer virar "abertura" pularia trecho de episódio.
 */
export function segmentsFromChapters(chapters: readonly NativeChapter[]): readonly SkipSegment[] {
  return chapters.flatMap((chapter): SkipSegment[] => {
    const name = chapter.name.trim();
    const kind: SkipSegmentKind | null = CHAPTER_INTRO_PATTERN.test(name)
      ? "intro"
      : CHAPTER_OUTRO_PATTERN.test(name)
      ? "outro"
      : CHAPTER_RECAP_PATTERN.test(name)
      ? "recap"
      : null;
    if (kind === null) return [];
    return [{ kind, start: chapter.start, end: chapter.end, episodeLength: null }];
  });
}

/** Um evento terminal isolado não prova que a história acabou (erro/transição do motor). */
export function canAdvanceOnEnded(position: number, duration: number): boolean {
  return Number.isFinite(position) && Number.isFinite(duration) && duration > 0 &&
    position >= Math.max(0, duration - 5);
}
