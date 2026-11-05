import { randomUUID } from "node:crypto";
import type { MediaType, PlaybackScenario } from "@cebola/contracts";
import { ProfileNotFoundError, type HouseholdRepository } from "../households/index.js";
import {
  InvalidProgressError,
  normalizedMediaIdentifier,
  type WatchProgress
} from "./domain.js";
import type { ProgressTitleTarget, WatchProgressRepository } from "./repository.js";

export interface WatchProgressServiceDependencies {
  readonly repository: WatchProgressRepository;
  readonly households: HouseholdRepository;
  readonly generateId?: () => string;
  readonly now?: () => Date;
}

export interface UpdateWatchProgressInput {
  readonly householdId: string;
  readonly profileId: string;
  readonly addonId: string;
  readonly playbackAddonId?: string | null;
  readonly mediaId: string;
  readonly videoId: string;
  readonly mediaType: MediaType;
  readonly title: string;
  readonly episodeTitle?: string | null;
  readonly season?: number | null;
  readonly episode?: number | null;
  readonly posterUrl?: string | null;
  readonly positionSeconds: number;
  readonly durationSeconds: number;
  readonly completed?: boolean;
  readonly observedAt?: string;
  readonly playbackScenario?: PlaybackScenario | null;
}

function normalizedTitle(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 300) {
    throw new InvalidProgressError(`${field} is invalid`);
  }
  return normalized;
}

function normalizedOptionalTitle(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : normalizedTitle(value, "episodeTitle");
}

// Ausência significa "ainda não identificado"; null é uma escolha explícita (legenda desligada).
// Não transformar uma gravação só da fonte numa ordem para desligar a legenda na próxima leitura.
function normalizedPlaybackScenario(
  value: PlaybackScenario | null | undefined
): PlaybackScenario | null {
  if (value === null || value === undefined) return null;
  return {
    ...(value.source !== undefined ? { source: value.source } : {}),
    ...(value.audio !== undefined ? { audio: value.audio } : {}),
    ...(value.subtitle !== undefined ? { subtitle: value.subtitle } : {}),
    ...(value.subtitleSettings !== undefined ? { subtitleSettings: value.subtitleSettings } : {})
  };
}

export class WatchProgressService {
  readonly #repository: WatchProgressRepository;
  readonly #households: HouseholdRepository;
  readonly #generateId: () => string;
  readonly #now: () => Date;

  constructor(dependencies: WatchProgressServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#households = dependencies.households;
    this.#generateId = dependencies.generateId ?? randomUUID;
    this.#now = dependencies.now ?? (() => new Date());
  }

  async update(input: UpdateWatchProgressInput): Promise<WatchProgress> {
    await this.#requireProfile(input.householdId, input.profileId);
    if (
      !Number.isInteger(input.positionSeconds) ||
      !Number.isInteger(input.durationSeconds) ||
      input.positionSeconds < 0 ||
      input.durationSeconds <= 0 ||
      input.positionSeconds > input.durationSeconds ||
      input.durationSeconds > 604_800
    ) {
      throw new InvalidProgressError("watch position is invalid");
    }

    // Os players enviam false enquanto não recebem `ended`. Isso não deve impedir a
    // conclusão por progresso quando a pessoa sai ou troca de episódio após atingir 90%.
    const completed = input.completed === true || input.positionSeconds / input.durationSeconds >= 0.9;
    const now = this.#now();
    const observedAt = input.observedAt === undefined ? now : new Date(input.observedAt);
    if (!Number.isFinite(observedAt.getTime())) throw new InvalidProgressError("observedAt is invalid");
    return this.#repository.upsert({
      id: this.#generateId(),
      householdId: input.householdId,
      profileId: input.profileId,
      addonId: normalizedMediaIdentifier(input.addonId, "addonId"),
      playbackAddonId: input.playbackAddonId === null || input.playbackAddonId === undefined
        ? null : normalizedMediaIdentifier(input.playbackAddonId, "playbackAddonId"),
      mediaId: normalizedMediaIdentifier(input.mediaId, "mediaId"),
      videoId: normalizedMediaIdentifier(input.videoId, "videoId"),
      mediaType: input.mediaType,
      title: normalizedTitle(input.title, "title"),
      episodeTitle: normalizedOptionalTitle(input.episodeTitle),
      season: input.season ?? null,
      episode: input.episode ?? null,
      posterUrl: input.posterUrl ?? null,
      positionSeconds: input.positionSeconds,
      durationSeconds: input.durationSeconds,
      completed,
      // Uma entrega offline antiga não pode substituir uma reprodução mais recente.
      // Nunca aceitar datas futuras como trava para todas as gravações seguintes.
      updatedAt: observedAt > now ? now : observedAt,
      playbackScenario: normalizedPlaybackScenario(input.playbackScenario)
    });
  }

  async listForTitle(householdId: string, profileId: string, target: ProgressTitleTarget, offset: number): Promise<readonly WatchProgress[]> {
    await this.#requireProfile(householdId, profileId);
    return this.#repository.listForTitle(householdId, profileId, target, offset);
  }

  async hideTitle(householdId: string, profileId: string, target: ProgressTitleTarget): Promise<void> {
    await this.#requireProfile(householdId, profileId);
    return this.#repository.hideTitle(householdId, profileId, target, this.#now());
  }

  async listRecent(
    householdId: string,
    profileId: string,
    limit: number,
    includeCompleted: boolean
  ): Promise<readonly WatchProgress[]> {
    await this.#requireProfile(householdId, profileId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new InvalidProgressError("limit is invalid");
    }
    return this.#repository.listRecent(householdId, profileId, limit, includeCompleted);
  }

  async #requireProfile(householdId: string, profileId: string): Promise<void> {
    const profile = await this.#households.findProfile(householdId, profileId);
    if (profile === null) throw new ProfileNotFoundError(profileId);
  }
}
