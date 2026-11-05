import type { MediaType } from "@cebola/contracts";
import type { LibraryItem } from "./domain.js";

export interface UpsertLibraryItemRecord {
  readonly id: string;
  readonly householdId: string;
  readonly profileId: string;
  readonly addonId: string;
  readonly mediaId: string;
  readonly mediaType: MediaType;
  readonly name: string;
  readonly posterUrl: string | null;
  readonly backgroundUrl: string | null;
  readonly description: string | null;
  readonly releaseInfo: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LibraryRepository {
  list(householdId: string, profileId: string): Promise<readonly LibraryItem[]>;
  upsert(record: UpsertLibraryItemRecord): Promise<LibraryItem>;
  remove(
    householdId: string,
    profileId: string,
    mediaType: MediaType,
    mediaId: string
  ): Promise<boolean>;
}
