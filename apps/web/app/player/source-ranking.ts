import { normalizedTrackLanguage } from "./subtitle-selection";

export interface RankedSource {
  readonly addonId: string;
  readonly kind: "direct" | "torrent";
  readonly readyNow?: boolean | null;
  readonly quality?: string | null;
  readonly label: string;
  readonly audioLanguages?: readonly string[];
  readonly subtitleLanguages?: readonly string[];
  readonly dubbed?: boolean;
  readonly sizeLabel?: string | null;
  readonly seeders?: number | null;
}

export interface RankingContext<T extends RankedSource> {
  readonly originalLanguage: string | null;
  readonly compactScreen: boolean;
  readonly lowPower?: boolean;
  readonly compatible: (source: T) => boolean;
  /** Add-on usado da última vez que a pessoa assistiu a este título. Só desempata, nunca filtra. */
  readonly preferredAddonId?: string | null;
  /**
   * Motor de torrent no aparelho: o torrent vira a fonte principal. Link direto aqui não é mais
   * um RD pronto, é um servidor desconhecido de addon (já houve um que parava de enviar no meio).
   */
  readonly preferTorrents?: boolean;
  /**
   * Idiomas do áudio e da legenda que a pessoa vinha usando (cenário salvo, de qualquer aparelho):
   * quem começou no celular continua na TV com os mesmos idiomas, mesmo trocando de arquivo. Sem
   * cenário, valem o áudio original e a legenda em português.
   */
  readonly audioLanguage?: string | null;
  readonly subtitleLanguage?: string | null;
  /** Tela 4K com decodificação no hardware (TV Samsung): 4K saudável vem antes do 1080p. */
  readonly prefer4k?: boolean;
}

// "jpn" e "ja", "pob" e "pt-BR" são o mesmo idioma para escolher a fonte.
function baseLanguage(code: string | null | undefined): string | null {
  if (!code) return null;
  return normalizedTrackLanguage({ language: code.toLowerCase(), label: "" })?.split("-")[0] ?? null;
}

function audioRank(source: RankedSource, wantedLanguage: string | null): number {
  const languages = source.audioLanguages ?? [];
  const wanted = baseLanguage(wantedLanguage);
  if (!wanted) return source.dubbed ? 0 : 1;
  if (languages.some((language) => baseLanguage(language) === wanted)) return 2;
  if (languages.length > 0 || source.dubbed) return 0;
  return 1;
}

// A meta é abrir com a legenda já ligada (português, ou a do cenário salvo) — uma fonte que anuncia
// essa legenda entrega isso sem depender do que o SubDL/OpenSubtitles encontrarem depois, então
// pesa na escolha da fonte, não só na escolha da legenda.
function subtitleRank(source: RankedSource, wantedLanguage: string | null): number {
  const wanted = baseLanguage(wantedLanguage) ?? "pt";
  return (source.subtitleLanguages ?? []).some((code) => baseLanguage(code) === wanted) ? 1 : 0;
}

// BluRay/Remux e WEB-DL são a mesma aposta de qualidade de imagem; só WEBRip e "sem indicação"
// ficam abaixo. Um Remux não vence um WEB-DL só pelo nome — os dois já são "release confiável".
function releaseRank(label: string): number {
  if (/\b(?:remux|blu[ .-]?ray|web[ .-]?dl)\b/i.test(label)) return 2;
  if (/\bweb[ .-]?rip\b/i.test(label)) return 1;
  return 0;
}

// 4K e 1080p contam como o MESMO patamar: um 2160p sem nenhuma outra pista (release, tamanho)
// não pode vencer um 1080p BluRay conhecido só pelo número da resolução — muito 2160p por aí é
// upscale ou reencode ruim. Compacto (celular) continua penalizando 4K de verdade, abaixo até de
// 480p, porque o aparelho não aproveita e o arquivo tende a ser maior e mais pesado de abrir.
function resolutionTier(source: RankedSource, compactScreen: boolean, prefer4k = false): number {
  if (source.quality === "4K" && compactScreen) return -1;
  if (source.quality === "4K" && prefer4k) return 5;
  return ({ "4K": 4, "1080p": 4, "720p": 3, "480p": 2, SD: 1 } as Record<string, number>)[source.quality ?? ""] ?? 0;
}

// Extrai o tamanho de `sizeLabel` ("1.38 GB", "943.72 MB") em gigabytes. Formato desconhecido ou
// ausente devolve `null` — tratado como neutro, nunca como penalidade.
function sizeInGb(sizeLabel: string | null | undefined): number | null {
  if (!sizeLabel) return null;
  const match = /([\d.,]+)\s*(GB|MB)/i.exec(sizeLabel);
  if (!match) return null;
  const value = Number.parseFloat(match[1]!.replace(",", "."));
  if (!Number.isFinite(value)) return null;
  return match[2]!.toUpperCase() === "GB" ? value : value / 1024;
}

// Arquivo enorme não é uma fonte "melhor": é uma fonte mais lenta para baixar/streamar e mais
// fácil de estourar armazenamento no celular. Compacto é mais rigoroso (20 GB) porque o aparelho
// e a conexão costumam ser mais limitados; qualquer aparelho recusa acima de 40 GB.
function sizeRank(source: RankedSource, compactScreen: boolean): number {
  const gb = sizeInGb(source.sizeLabel);
  if (gb === null) return 1;
  return gb > (compactScreen ? 20 : 40) ? 0 : 1;
}

// Preferência conservadora, não uma declaração de suporte do decodificador.
function lowPowerRank(source: RankedSource): number {
  if (source.quality === "4K" || /\b(?:2160p|4k|remux|hi10p|10[ .-]?bit|av1)\b/i.test(source.label)) return 0;
  if (/\b(?:x264|h[ .-]?264|avc)\b/i.test(source.label)) return 2;
  return 1;
}

// Add-ons que a escolha automática nunca usa (pedido do Lucas, 23/10/2026). Continuam na lista
// manual. Fenixflix: links diretos de um servidor gratuito que responde em 10 s, entrega ~0,25 MB/s
// e derruba a conexão no meio do episódio.
const FORA_DO_AUTOMATICO = [/fenixflix/i];

export function entraNoAutomatico(source: { readonly addonId: string; readonly addonName?: string }): boolean {
  return !FORA_DO_AUTOMATICO.some((pattern) => pattern.test(source.addonId) || pattern.test(source.addonName ?? ""));
}

// Com o motor local, torrent sem gente compartilhando não toca: a saúde vem antes de qualidade e
// release. 0 conta como "não informado" (o Brazuca manda 0 em tudo) e fica junto dos fracos, sem
// ser descartado; quem decide de verdade é o teste de velocidade do motor.
function swarmRank(source: RankedSource): number {
  return (source.seeders ?? 0) >= 10 ? 1 : 0;
}

/** Só usa pistas declaradas pelo add-on; seeders desempata disponibilidade, não imagem. */
export function rankAutomaticSources<T extends RankedSource>(
  sources: readonly T[], context: RankingContext<T>
): readonly T[] {
  const wantedAudio = context.audioLanguage ?? context.originalLanguage;
  const compare = (left: T, right: T): number =>
    (context.preferTorrents
      ? Number(right.kind === "torrent") - Number(left.kind === "torrent")
      : Number(right.kind === "direct" && right.readyNow === true) - Number(left.kind === "direct" && left.readyNow === true) ||
        Number(right.kind === "direct") - Number(left.kind === "direct")) ||
    Number(context.compatible(right)) - Number(context.compatible(left)) ||
    (context.preferTorrents ? swarmRank(right) - swarmRank(left) : 0) ||
    audioRank(right, wantedAudio) - audioRank(left, wantedAudio) ||
    subtitleRank(right, context.subtitleLanguage ?? null) - subtitleRank(left, context.subtitleLanguage ?? null) ||
    (context.lowPower && !context.prefer4k ? lowPowerRank(right) - lowPowerRank(left) : 0) ||
    resolutionTier(right, context.compactScreen, context.prefer4k) - resolutionTier(left, context.compactScreen, context.prefer4k) ||
    sizeRank(right, context.compactScreen) - sizeRank(left, context.compactScreen) ||
    releaseRank(right.label) - releaseRank(left.label) ||
    Number(right.addonId === context.preferredAddonId) - Number(left.addonId === context.preferredAddonId) ||
    (right.seeders ?? 0) - (left.seeders ?? 0);
  return sources.filter(entraNoAutomatico).sort(compare);
}
