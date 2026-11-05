export interface SourceCandidate {
  readonly id: string;
  readonly addonId: string;
  readonly addonName: string;
  readonly label: string;
  readonly quality?: string | null;
  readonly audioLanguages?: readonly string[];
  readonly subtitleLanguages?: readonly string[];
  readonly readyNow?: boolean | null;
  readonly sizeLabel?: string | null;
  readonly seeders?: number | null;
  readonly source?: string | null;
  // Identidade da fonte (hash/índice do torrent). Opcionais para não quebrar quem já constrói
  // `SourceCandidate` sem esses dados — usados por `playback-scenario.ts` para achar/retomar a
  // fonte exata sem depender de `url`, que é sempre temporária.
  readonly kind?: "direct" | "torrent";
  readonly infoHash?: string | null;
  readonly fileIdx?: number | null;
}

export interface PlayerSourceOption {
  readonly id: string;
  readonly addon: string;
  readonly label: string;
  readonly quality: string;
  readonly audioLanguages: readonly string[];
  readonly subtitleLanguages: readonly string[];
  readonly readyNow: boolean;
  readonly details: string;
}

export function buildPlayerSourceOptions(candidates: readonly SourceCandidate[]): readonly PlayerSourceOption[] {
  return candidates.map((candidate) => ({
    id: candidate.id,
    addon: candidate.addonName,
    label: candidate.label,
    quality: candidate.quality ?? "Qualidade não informada",
    audioLanguages: candidate.audioLanguages ?? [],
    subtitleLanguages: candidate.subtitleLanguages ?? [],
    readyNow: candidate.readyNow === true,
    details: [
      candidate.sizeLabel ?? null,
      typeof candidate.seeders === "number" ? `${candidate.seeders} seeders` : null,
      candidate.source ?? null
    ].filter((part): part is string => Boolean(part)).join(" · ")
  }));
}

export function filterSourceOptionsBySubtitle(
  options: readonly PlayerSourceOption[], language: "all" | "pt" | "en"
): readonly PlayerSourceOption[] {
  if (language === "all") return options;
  return options.filter((option) => option.subtitleLanguages.some((code) =>
    language === "pt" ? /^(?:pt|por|pob)(?:[-_].*)?$/i.test(code) : /^(?:en|eng)(?:[-_].*)?$/i.test(code)
  ));
}
