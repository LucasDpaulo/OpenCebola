import { parseTimestamp } from "../subtitle-timing";
import type { SkipSegment } from "./skip-segments";

/**
 * Marcas da própria legenda, sincronizada com o arquivo: o AniSkip devolve o MESMO tempo de
 * abertura para episódios inteiros (One Piece 1091–1093: 0:10–2:11), e os arquivos da
 * Crunchyroll não trazem capítulos. A legenda traz o título do episódio, entre aspas, no cartão
 * do título, e o "Continua…" na hora do "To Be Continued" — os dois pontos que a pessoa espera.
 */
export interface SubtitleMarkers {
  /** Começo do cartão com o título do episódio: onde termina abertura + resumo. */
  readonly episodeStart: number | null;
  /** "Continua…": fim da história; dali em diante é encerramento e prévia. */
  readonly storyEnd: number | null;
}

interface TextCue {
  readonly start: number;
  readonly text: string;
}

/** O título só vale no começo: depois dele vêm quadros como "Momento do Chopper", também entre aspas. */
const TITLE_WINDOW_SECONDS = 600;
const TITLE_WINDOW_FRACTION = 0.4;
/** "Continua" antes da metade é fala, não o letreiro do fim. */
const STORY_END_MIN_FRACTION = 0.5;
/** O cartão costuma aparecer um instante antes da fala: cai um pouco antes para não perder o título. */
const EPISODE_START_LEAD_SECONDS = 1;
/** Abertura do AniSkip só é refinada se o título estiver perto dela. */
const TITLE_MAX_DISTANCE_SECONDS = 180;

const QUOTED = /^["“][^"“”]+["”]$/;
const STORY_END = /^(continua|continuará|to be continued)[\s.…!]*$/i;

function plainText(lines: readonly string[]): string {
  return lines.join(" ")
    .replace(/<[^>]*>/g, "")
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Falas da legenda (VTT ou SRT) com início e texto limpo de marcação. */
export function textCues(text: string): readonly TextCue[] {
  const cues: TextCue[] = [];
  let start: number | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (start !== null && lines.length > 0) cues.push({ start, text: plainText(lines) });
    start = null;
    lines = [];
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.includes("-->")) {
      flush();
      start = parseTimestamp(line.split("-->", 1)[0]?.trim().split(/\s+/)[0] ?? "");
      continue;
    }
    if (line === "") flush();
    else if (start !== null) lines.push(line);
  }
  flush();
  return cues;
}

export function subtitleMarkers(text: string, durationSeconds: number): SubtitleMarkers {
  const cues = textCues(text);
  const knownDuration = Number.isFinite(durationSeconds) && durationSeconds > 0;
  const titleWindow = knownDuration
    ? Math.min(TITLE_WINDOW_SECONDS, durationSeconds * TITLE_WINDOW_FRACTION)
    : TITLE_WINDOW_SECONDS;
  const title = cues.find((cue) => cue.start < titleWindow && QUOTED.test(cue.text));
  const end = knownDuration
    ? cues.find((cue) => cue.start >= durationSeconds * STORY_END_MIN_FRACTION && STORY_END.test(cue.text))
    : undefined;
  return {
    episodeStart: title ? Math.max(0, title.start - EPISODE_START_LEAD_SECONDS) : null,
    storyEnd: end?.start ?? null
  };
}

/**
 * Ajusta os trechos da API com as marcas: a abertura (e o resumo) passa a terminar no título,
 * e o encerramento a começar no "Continua…". Sem abertura da API não há onde ela começa, então o
 * título sozinho não cria trecho — evita pular uma cena de abertura que é história.
 */
export function withSubtitleMarkers(
  segments: readonly SkipSegment[],
  markers: SubtitleMarkers | null,
  durationSeconds: number
): readonly SkipSegment[] {
  if (markers === null) return segments;
  let result = [...segments];
  const episodeStart = markers.episodeStart;
  if (episodeStart !== null) {
    const opening = result.filter((segment) => segment.kind !== "outro" && segment.start < episodeStart - 20 &&
      episodeStart - segment.end <= TITLE_MAX_DISTANCE_SECONDS);
    if (opening.length > 0) {
      const start = Math.min(...opening.map((segment) => segment.start));
      result = [
        { kind: "intro", start, end: episodeStart, episodeLength: null },
        ...result.filter((segment) => segment.kind === "outro" || segment.start >= episodeStart)
      ];
    }
  }
  if (markers.storyEnd !== null && Number.isFinite(durationSeconds) && durationSeconds > markers.storyEnd) {
    result = [
      ...result.filter((segment) => segment.kind !== "outro"),
      { kind: "outro", start: markers.storyEnd, end: durationSeconds, episodeLength: null }
    ];
  }
  return result.sort((left, right) => left.start - right.start);
}
