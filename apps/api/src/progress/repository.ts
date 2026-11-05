import type { MediaType, PlaybackScenario } from "@cebola/contracts";
import type { WatchProgress } from "./domain.js";

export interface UpsertWatchProgressRecord {
  readonly id: string;
  readonly householdId: string;
  readonly profileId: string;
  readonly addonId: string;
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
  readonly updatedAt: Date;
  readonly playbackScenario: PlaybackScenario | null;
}

export interface ProgressTitleTarget {
  readonly mediaId: string;
  readonly mediaType: MediaType;
  readonly videoIds: readonly string[];
}

export interface WatchProgressRepository {
  listForTitle(householdId: string, profileId: string, target: ProgressTitleTarget, offset: number): Promise<readonly WatchProgress[]>;
  hideTitle(householdId: string, profileId: string, target: ProgressTitleTarget, at: Date): Promise<void>;
  upsert(record: UpsertWatchProgressRecord): Promise<WatchProgress>;
  listRecent(
    householdId: string,
    profileId: string,
    limit: number,
    includeCompleted: boolean
  ): Promise<readonly WatchProgress[]>;
}
