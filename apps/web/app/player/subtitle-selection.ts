import type { TimingVerdict } from "./subtitle-timing";

export interface SubtitleCandidate {
  readonly id: string;
  readonly language: string;
  readonly label: string;
  /** Nome do release que a legenda foi feita para (ex.: SubDL) — usado só para desempate fino. */
  readonly details?: string;
  /** O OpenSubtitles casou esta legenda pelo HASH do arquivo de vídeo — sincronia confirmada. */
  readonly hashMatch?: boolean;
}

/**
 * Veredito da camada 3 (`subtitle-timing.ts`) já conferido NESTE arquivo/sessão, por ID de
 * legenda: só usado para DESEMPATAR dentro do mesmo idioma — uma candidata já flagrada com
 * conteúdo fora da duração do vídeo perde para qualquer outra ainda não testada ("unknown") ou já
 * confirmada ("ok"). Nunca muda a ordem ENTRE idiomas (a pessoa não deve perder PT-BR por causa
 * de timing ruim; `nextSubtitleId` continua oferecendo essa candidata, só por último).
 */
export type SubtitleTimingVerdicts = ReadonlyMap<string, TimingVerdict>;

export interface LanguageTrack {
  readonly language: string | null;
  readonly label: string;
}

export function trackLanguage(track: LanguageTrack): string | null {
  const language = track.language?.trim().toLowerCase() ?? "";
  const label = track.label.toLowerCase();
  if (/^(?:pob|pb|pt[-_]br)(?:[-_].*)?$/.test(language) || /portugu[eê]s.*brasil|brazilian portuguese|pt[-_ ]br/.test(label)) return "pt-BR";
  if (/^(?:pt|por)(?:[-_].*)?$/.test(language) || /portugu[eê]s|portuguese/.test(label)) return "pt";
  if (/^(?:en|eng)(?:[-_].*)?$/.test(language) || /ingl[eê]s|english/.test(label)) return "en";
  return language && !["und", "unknown", "zxx"].includes(language) ? language : null;
}

// Apelidos ISO 639-2 → 639-1 mais comuns: muito arquivo MKV só declara o código de 3 letras.
// Compartilhado entre o áudio original e a continuidade entre episódios — os dois precisam
// reconhecer o MESMO idioma "de verdade", não comparar texto de código igual.
const ISO_639_2_TO_1: Record<string, string> = {
  jpn: "ja", kor: "ko", spa: "es", fra: "fr", fre: "fr", deu: "de", ger: "de", ita: "it"
};

/**
 * Idioma normalizado para COMPARAR trilhas entre sessões/episódios: `trackLanguage` já resolve
 * português (pt-BR/pt) e inglês pelo código OU pelo nome mostrado pelo motor; para os demais
 * idiomas, aplica os apelidos acima sobre a base do código (antes de um eventual "-região").
 */
export function normalizedTrackLanguage(track: LanguageTrack): string | null {
  const resolved = trackLanguage(track);
  if (resolved === null || resolved === "pt-BR" || resolved === "pt" || resolved === "en") return resolved;
  const base = resolved.split(/[-_]/)[0] ?? resolved;
  return ISO_639_2_TO_1[base] ?? base;
}

/** Usa a língua original do título apenas quando o player confirma uma faixa correspondente. */
export function originalAudioTrackId<T extends LanguageTrack & { readonly id: string }>(
  tracks: readonly T[], originalLanguage: string | null, currentId: string | null
): string | null {
  if (!originalLanguage) return null;
  const target = normalizedTrackLanguage({ language: originalLanguage, label: "" });
  const match = tracks.find((track) => {
    const language = normalizedTrackLanguage(track);
    return language !== null && language === target;
  });
  return match && match.id !== currentId ? match.id : null;
}

/** Reavalia a legenda quando a pessoa troca o áudio, sem adivinhar entre duas opções PT. */
export function subtitleForAudio(
  audio: LanguageTrack,
  subtitles: readonly SubtitleCandidate[],
  currentSubtitleId: string | null
): string | null {
  const audioLanguage = trackLanguage(audio);
  if (audioLanguage === "pt" || audioLanguage === "pt-BR") return null;
  if (audioLanguage === null) return currentSubtitleId;

  const current = subtitles.find((subtitle) => subtitle.id === currentSubtitleId);
  if (current && preference(current) <= 1) return current.id;
  return safeAutomaticSubtitleId(subtitles);
}

function preference(candidate: SubtitleCandidate): number {
  const language = candidate.language.trim().toLowerCase();
  const label = candidate.label.toLowerCase();
  if (/^(?:pob|pb)$/.test(language) || /^pt[-_]br(?:-|$)/.test(language) || /brasil|brazil/.test(label)) return 0;
  if (/^(?:pt|por)(?:[-_].*)?$/.test(language) || /portugu/.test(label)) return 1;
  if (/^(?:en|eng)(?:[-_].*)?$/.test(language) || /ingl[êée]s|english/.test(label)) return 2;
  return 3;
}

export function orderSubtitleCandidates<T extends SubtitleCandidate>(candidates: readonly T[]): readonly T[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, preference: preference(candidate) }))
    .sort((left, right) => left.preference - right.preference || left.index - right.index)
    .map(({ candidate }) => candidate);
}

function releaseTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

// O grupo de release é a assinatura mais forte de "é a mesma legenda para o mesmo arquivo": em
// "Movie.2024.1080p.BluRay.x264-CtrlHD" é o token depois do último hífen. Uma legenda cujo
// `details` cita esse grupo quase certamente foi sincronizada para este exato arquivo.
function releaseGroup(value: string): string | null {
  const match = /-([a-z0-9]+)\s*$/i.exec(value.trim());
  return match ? match[1]!.toLowerCase() : null;
}

/** Pontua o quanto `details` (a legenda) combina com `releaseLabel` (a fonte de vídeo escolhida). */
function releaseMatchScore(details: string, releaseLabel: string): number {
  const detailsTokens = releaseTokens(details);
  const labelTokens = releaseTokens(releaseLabel);
  let score = 0;
  for (const token of detailsTokens) if (labelTokens.has(token)) score += 1;
  const group = releaseGroup(details);
  if (group && group.length >= 3 && labelTokens.has(group)) score += 100;
  return score;
}

/**
 * 0 para "ok" ou nunca testada (dá o benefício da dúvida); 1 só quando JÁ sabemos, pelo conteúdo
 * real desta sessão, que ela não bate com a duração do vídeo — sinal mais forte que hash/release,
 * porque aqueles são dedução e este é verificação direta do arquivo.
 */
function timingRank(id: string, timingVerdicts?: SubtitleTimingVerdicts): number {
  const verdict = timingVerdicts?.get(id);
  return verdict !== undefined && verdict !== "ok" ? 1 : 0;
}

/**
 * Ordena candidatas (já do MESMO idioma) da melhor para a pior sincronia: primeiro o veredito de
 * timing já conferido nesta sessão (camada 3, opcional), depois o hash de arquivo do OpenSubtitles
 * — é confirmação, não dedução —, depois a pontuação por nome de release (grupo, resolução,
 * WEB-DL/BluRay…), e por fim a ordem de chegada. Compartilhada entre a escolha automática
 * (`bestReleaseMatch`/`safeAutomaticSubtitleId`) e o ciclo de "testar próxima" (`nextSubtitleId`):
 * todas precisam concordar sobre qual é "a próxima melhor", ou testar próxima pularia direto para
 * uma sincronia pior que a automática já tinha descartado.
 */
function rankByRelease<T extends SubtitleCandidate>(
  candidates: readonly T[],
  releaseLabel?: string | null,
  timingVerdicts?: SubtitleTimingVerdicts
): readonly T[] {
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      timingRank: timingRank(candidate.id, timingVerdicts),
      hashRank: candidate.hashMatch === true ? 0 : 1,
      score: releaseMatchScore(candidate.details ?? "", releaseLabel ?? "")
    }))
    .sort((left, right) =>
      left.timingRank - right.timingRank ||
      left.hashRank - right.hashRank ||
      right.score - left.score ||
      left.index - right.index)
    .map(({ candidate }) => candidate);
}

/**
 * Lista completa na ordem de qualidade: idioma (PT-BR, PT, inglês, demais) e, dentro de cada um,
 * hash > release > chegada. É a ordem entregue aos players nativos: o "testar próxima" deles só
 * conhece a ordem das faixas, então ela precisa já sair ranqueada daqui.
 */
export function rankSubtitleCandidates<T extends SubtitleCandidate>(
  candidates: readonly T[],
  releaseLabel?: string | null,
  timingVerdicts?: SubtitleTimingVerdicts
): readonly T[] {
  return [0, 1, 2, 3].flatMap((tier) =>
    rankByRelease(candidates.filter((candidate) => preference(candidate) === tier), releaseLabel, timingVerdicts));
}

/**
 * Dentre candidatas já filtradas para o MESMO idioma, devolve a que melhor combina com
 * `releaseLabel` pelo nome do release (grupo, resolução, WEB-DL/BluRay…); sem esse dado, ou sem
 * diferença de pontuação, a ordem de chegada decide. Usada tanto para a legenda automática
 * (dentro do português) quanto para herdar a legenda do episódio anterior (em qualquer idioma).
 */
export function bestReleaseMatch<T extends SubtitleCandidate>(
  candidates: readonly T[],
  releaseLabel?: string | null
): T | null {
  if (candidates.length === 0) return null;
  return rankByRelease(candidates, releaseLabel)[0] ?? null;
}

/**
 * Liga a melhor legenda em português ao abrir: PT-BR primeiro, depois PT genérico (muita
 * legenda brasileira é publicada como PT). Dentro do MESMO idioma (nunca entre PT-BR e PT — a
 * pessoa não deve perder uma PT-BR só porque uma PT bateu melhor com o release), a legenda cujo
 * `details` mais combina com o release do vídeo escolhido (`releaseLabel`) vence; sem esse dado,
 * ou sem diferença, a ordem de chegada desempata. "Testar próxima" percorre as demais se a
 * sincronia não bater.
 *
 * `timingVerdicts` (camada 3, opcional): quando esta MESMA sessão já testou o conteúdo de alguma
 * candidata contra a duração real do vídeo e ela não bateu, ela perde para qualquer outra do
 * mesmo idioma ainda não testada ou já confirmada — sem isso, reabrir o popup de fontes escolheria
 * de novo a legenda que a camada 3 acabou de trocar.
 */
export function safeAutomaticSubtitleId(
  candidates: readonly SubtitleCandidate[],
  releaseLabel?: string | null,
  timingVerdicts?: SubtitleTimingVerdicts
): string | null {
  const ordered = orderSubtitleCandidates(candidates).filter((candidate) => preference(candidate) <= 1);
  if (ordered.length === 0) return null;
  const tier = preference(ordered[0]!);
  const sameTier = ordered.filter((candidate) => preference(candidate) === tier);
  return rankByRelease(sameTier, releaseLabel, timingVerdicts)[0]?.id ?? ordered[0]!.id;
}

export function nextSubtitleId(
  candidates: readonly SubtitleCandidate[],
  activeId: string | null,
  releaseLabel?: string | null
): string | null {
  // Este atalho existe para testar outra sincronização em português: PT-BR primeiro e depois
  // PT genérico, que muitas vezes também é brasileiro. Dentro de cada um dos dois, cicla na
  // MESMA ordem de qualidade da escolha automática (hash > pontuação de release > chegada) —
  // senão "testar próxima" pularia direto para uma sincronia pior que a automática já descartou.
  const tierPtBr = rankByRelease(candidates.filter((candidate) => preference(candidate) === 0), releaseLabel);
  const tierPt = rankByRelease(candidates.filter((candidate) => preference(candidate) === 1), releaseLabel);
  const ranked = [...tierPtBr, ...tierPt];
  if (ranked.length === 0) return null;
  const activeIndex = ranked.findIndex((candidate) => candidate.id === activeId);
  return ranked[(activeIndex + 1) % ranked.length]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Legendas de OUTRO filme. A SubDL casa por franquia e devolve a trilogia inteira: em "O Poderoso
// Chefão" (1972) chegam legendas de "Part II 1974" e "Part III 1990". Sincronizadas com outro
// filme elas nunca servem — só poluem a lista. Só filmes: em série o ano/parte do release não
// diz nada sobre o episódio.
const ROMAN_PARTS: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

/** Número da "Part/Parte N" citada no texto (algarismo ou romano I–X), ou null se não houver. */
function partNumber(text: string): number | null {
  const match = /\b(?:part|parte)[\s._-]*(\d{1,2}|[ivx]+)\b/i.exec(text);
  if (!match) return null;
  const raw = match[1]!.toLowerCase();
  const value = /^\d+$/.test(raw) ? Number(raw) : ROMAN_PARTS[raw];
  return value && value >= 1 && value <= 10 ? value : null;
}

/**
 * Remove as legendas cujo release cita outro ano (diferença > 1 do ano do título, usando só o
 * PRIMEIRO ano do texto) ou outra "Parte" do filme. Nunca esvazia a lista: se tudo seria
 * removido, devolve a original — melhor uma legenda possivelmente errada que nenhuma.
 */
export function withoutOtherTitleSubtitles<T extends SubtitleCandidate>(
  subtitles: readonly T[],
  title: { type: string; year: number | null; name: string; originalName?: string | null }
): readonly T[] {
  if (title.type !== "movie") return subtitles;
  const titleParts = [title.name, title.originalName ?? ""].map(partNumber).filter((part): part is number => part !== null);
  // Título sem "Part/Parte" é o primeiro filme.
  const titlePart = titleParts[0] ?? 1;
  const titleNumbers = new Set(`${title.name} ${title.originalName ?? ""}`.match(/\b(?:19|20)\d{2}\b/g) ?? []);
  const kept = subtitles.filter((subtitle) => {
    const text = subtitle.details ?? subtitle.label;
    if (title.year !== null) {
      // Número que faz parte do NOME ("Blade Runner 2049", "1917") não é ano de lançamento.
      const year = text.match(/\b(?:19|20)\d{2}\b/g)?.find((value) => !titleNumbers.has(value));
      if (year && Math.abs(Number(year) - title.year) > 1) return false;
    }
    const part = partNumber(text);
    return part === null || part === titlePart;
  });
  return kept.length === 0 ? subtitles : kept;
}

// Nomes de idioma que o mkvmerge/ffprobe escrevem no título da faixa ("Portuguese(Brazil)",
// "Spanish(Latin_America)"): quando `details` é só isso, repete o idioma que o rótulo já diz.
const LANGUAGE_NAME_ONLY = new RegExp(
  "^(?:portuguese|english|spanish|french|german|italian|russian|arabic|japanese|korean|chinese|" +
  "portugu[eê]s|ingl[eê]s|espanhol|franc[eê]s|alem[aã]o|italiano|russo|[aá]rabe|japon[eê]s|coreano|chin[eê]s)" +
  "(?:\\s*[(\\[][^)\\]]*[)\\]])?$"
);

/**
 * Prepara as faixas de legenda DENTRO do arquivo de vídeo (listadas pela API a partir do MKV) para
 * entrarem na mesma lista das externas. `hashMatch: true` porque a legenda é do próprio arquivo —
 * sincronia garantida, então ganha das externas do mesmo idioma e dispensa a checagem de timing.
 * PT com menção a Brasil vira "pt-BR" para a ordenação tratá-la como a preferida.
 */
export function normalizeEmbeddedSubtitles<T extends SubtitleCandidate & { readonly addonName: string }>(
  items: readonly T[]
): T[] {
  return items.map((item): T => {
    const language = item.language.toLowerCase();
    const portuguese = /^(?:pt|por)(?:[-_].*)?$/.test(language);
    const brazil = portuguese && /brasil|brazil|^pt[-_]br/i.test(`${item.details ?? ""} ${item.label} ${item.language}`);
    const { details, ...rest } = item;
    const keepDetails = details !== undefined && details.trim() !== "" &&
      !LANGUAGE_NAME_ONLY.test(details.trim().toLowerCase()) &&
      details.trim().toLowerCase() !== item.label.trim().toLowerCase();
    return {
      ...rest,
      ...(keepDetails ? { details } : {}),
      ...(portuguese ? { language: brazil ? "pt-BR" : "pt", label: brazil ? "Português (Brasil)" : "Português" } : {}),
      addonName: "Embutida",
      hashMatch: true
    } as T;
  });
}
