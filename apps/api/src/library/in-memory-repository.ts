import type { MediaType } from "@cebola/contracts";
import type { LibraryItem } from "./domain.js";
import type {
  LibraryRepository,
  UpsertLibraryItemRecord
} from "./repository.js";

function itemKey(profileId: string, mediaType: MediaType, mediaId: string): string {
  return JSON.stringify([profileId, mediaType, mediaId]);
}

function copy(item: LibraryItem): LibraryItem {
  return {
    ...item,
    createdAt: new Date(item.createdAt),
    updatedAt: new Date(item.updatedAt)
  };
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareItems(left: LibraryItem, right: LibraryItem): number {
  const timestampDifference = right.updatedAt.getTime() - left.updatedAt.getTime();
  if (timestampDifference !== 0) return timestampDifference;
  const typeDifference = compareText(left.mediaType, right.mediaType);
  return typeDifference !== 0 ? typeDifference : compareText(left.mediaId, right.mediaId);
}

export class InMemoryLibraryRepository implements LibraryRepository {
  readonly #items = new Map<string, LibraryItem>();

  async list(householdId: string, profileId: string): Promise<readonly LibraryItem[]> {
    return [...this.#items.values()]
      .filter((item) => item.householdId === householdId && item.profileId === profileId)
      .sort(compareItems)
      .map(copy);
  }

  async upsert(record: UpsertLibraryItemRecord): Promise<LibraryItem> {
    const key = itemKey(record.profileId, record.mediaType, record.mediaId);
    const existing = this.#items.get(key);
    const item: LibraryItem = {
      ...record,
      id: existing?.id ?? record.id,
      createdAt: new Date(existing?.createdAt ?? record.createdAt),
      updatedAt: new Date(record.updatedAt)
    };
    this.#items.set(key, item);
    return copy(item);
  }

  async remove(
    householdId: string,
    profileId: string,
    mediaType: MediaType,
    mediaId: string
  ): Promise<boolean> {
    const key = itemKey(profileId, mediaType, mediaId);
    const existing = this.#items.get(key);
    if (existing === undefined || existing.householdId !== householdId) return false;
    return this.#items.delete(key);
  }
}
