import type { MediaType, PlaybackScenario } from "@cebola/contracts";

export interface WatchProgress {
  readonly id: string;
  readonly householdId: string;
  readonly profileId: string;
  readonly addonId: string | null;
  readonly playbackAddonId: string | null;
  readonly mediaId: string;
  readonly videoId: string;
  readonly mediaType: MediaType;
  readonly title: string;
  readonly episodeTitle: string | null;
  readonly season: number | null;
  readonly episode: number | null;
  readonly posterUrl: string | null;
  readonly positionSeconds: number;
  readonly durationSeconds: number;
  readonly completed: boolean;
  readonly watched?: boolean;
  readonly hiddenFromContinue?: boolean;
  readonly updatedAt: Date;
  // Fonte, trilhas e ajustes exatos da última reprodução válida. Progresso legado (gravado antes
  // deste campo existir) nunca teve esses dados: mapeado como `null`, nunca inventado.
  readonly playbackScenario: PlaybackScenario | null;
}

export class ProgressDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ActiveProfileRequiredError extends ProgressDomainError {
  constructor() {
    super("An active profile is required");
  }
}

export class InvalidProgressError extends ProgressDomainError {}

export function normalizedMediaIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new InvalidProgressError(`${field} is invalid`);
  }
  return normalized;
}
