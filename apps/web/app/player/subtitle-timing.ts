// Camada 3 da sincronia de legenda: as duas primeiras (`subtitle-selection.ts`) ranqueiam
// candidatas por metadado (idioma, hash, nome de release) ANTES de qualquer uma tocar. Esta aqui
// olha o CONTEÚDO da legenda depois que o player já sabe a duração real do vídeo — só assim dá
// para saber se a legenda escolhida realmente cobre o arquivo, e não só se ela "parece" a certa
// pelo nome. Puro e sem I/O: quem busca o texto e decide trocar é `title-experience.tsx`.

export interface SubtitleCueTime {
  readonly start: number;
  readonly end: number;
}

/**
 * Timestamp tolerante a WebVTT (`00:01:02.345`) e SRT (`00:01:02,345`), com ou sem a hora
 * (`01:02.345`). O primeiro grupo não tem limite de dígitos de propósito: filme longo passa de
 * 9h59 e um "10:00:00,000" continua sendo hora, não minuto.
 */
export function parseTimestamp(raw: string): number | null {
  const match = /^(\d+):(\d{2})(?::(\d{2}))?[.,](\d{1,3})$/.exec(raw.trim());
  if (!match) return null;
  const [, first, second, third, msRaw] = match;
  const ms = Number(msRaw!.padEnd(3, "0"));
  if (third !== undefined) {
    const minutes = Number(second);
    const seconds = Number(third);
    if (minutes > 59 || seconds > 59) return null;
    return Number(first) * 3600 + minutes * 60 + seconds + ms / 1000;
  }
  const seconds = Number(second);
  if (seconds > 59) return null;
  return Number(first) * 60 + seconds + ms / 1000;
}

/**
 * Extrai só os tempos de início/fim de cada cue, ignorando cabeçalho (`WEBVTT`), índice numérico
 * (SRT), `NOTE`/comentário e qualquer linha malformada — o objetivo é a duração coberta, não
 * validar o arquivo inteiro. Configurações de cue depois do timestamp (`align:middle line:90%`,
 * comuns em VTT) são descartadas pegando só o primeiro token de cada lado da seta.
 */
export function vttCueTimes(text: string): readonly SubtitleCueTime[] {
  const cues: SubtitleCueTime[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.includes("-->")) continue;
    const [left, right] = line.split("-->", 2);
    if (left === undefined || right === undefined) continue;
    const start = parseTimestamp(left.trim().split(/\s+/)[0] ?? "");
    const end = parseTimestamp(right.trim().split(/\s+/)[0] ?? "");
    if (start === null || end === null || end <= start) continue;
    cues.push({ start, end });
  }
  return cues;
}

export type TimingVerdict = "ok" | "too-long" | "too-short" | "fps-drift";

export interface TimingFit {
  readonly verdict: TimingVerdict;
  /** Fim da última cue, em segundos — 0 quando não há nenhuma. */
  readonly lastEnd: number;
  /** Quão longe `lastEnd` está do fim plausível (a própria duração); menor é melhor. Só serve
   *  para desempatar candidatas "ok" entre si — nunca decide o veredito sozinho. */
  readonly score: number;
}

// PAL (25 fps) vs filme (23.976 fps): a conversão errada entre os dois estica ou encolhe o tempo
// de cada frame por esse fator — é a causa mais comum de uma legenda "quase certa" mas fora do
// lugar em arquivos remuxados. 1.5% de tolerância absorve arredondamento do próprio encoder.
const FPS_LONG_RATIO = 25 / 23.976;
const FPS_SHORT_RATIO = 23.976 / 25;
const FPS_TOLERANCE = 0.015;

function withinFpsBand(ratio: number, target: number): boolean {
  return Math.abs(ratio - target) / target <= FPS_TOLERANCE;
}

/**
 * Compara a legenda com a duração real do vídeo (já conhecida pelo player). Sem cue nenhuma é
 * sempre "too-short" — não há o que sincronizar. Fora da faixa plausível, primeiro tenta explicar
 * pelo desvio de fps (25/23.976, nas duas direções) antes de rotular como "longa"/"curta" demais.
 *
 * NOTA: com os fatores 25/23.976 acima, a banda de "fps-drift" da direção curta (≈0.944–0.974)
 * nunca cai abaixo do limiar de 80% que abre este ramo — ou seja, um desvio de fps nessa direção
 * sozinho não é grande o bastante para ser considerado "curto demais". Na prática, isso não muda
 * a decisão de trocar de legenda (qualquer veredito != "ok" é tratado igual por quem chama), só o
 * rótulo do diagnóstico: um caso assim sai como "too-short", nunca como "fps-drift".
 */
export function timingFit(cues: readonly SubtitleCueTime[], durationSeconds: number): TimingFit {
  if (cues.length === 0) return { verdict: "too-short", lastEnd: 0, score: Math.max(durationSeconds, 0) };

  const lastEnd = cues.reduce((max, cue) => Math.max(max, cue.end), 0);
  const score = Math.abs(lastEnd - durationSeconds);

  if (durationSeconds <= 0) return { verdict: "too-short", lastEnd, score: Number.POSITIVE_INFINITY };

  if (lastEnd > durationSeconds + 30) {
    const verdict = withinFpsBand(lastEnd / durationSeconds, FPS_LONG_RATIO) ? "fps-drift" : "too-long";
    return { verdict, lastEnd, score };
  }

  if (lastEnd < durationSeconds * 0.80) {
    const verdict = withinFpsBand(lastEnd / durationSeconds, FPS_SHORT_RATIO) ? "fps-drift" : "too-short";
    return { verdict, lastEnd, score };
  }

  return { verdict: "ok", lastEnd, score };
}
