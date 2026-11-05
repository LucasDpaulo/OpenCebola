import type {
  ProgressTitleTarget,
  UpsertWatchProgressRecord,
  WatchProgressRepository
} from "./repository.js";
import type { WatchProgress } from "./domain.js";

function key(profileId: string, mediaId: string, videoId: string): string {
  return `${profileId}\u0000${mediaId}\u0000${videoId}`;
}

function copy(value: WatchProgress): WatchProgress {
  return { ...value, updatedAt: new Date(value.updatedAt) };
}

export class InMemoryWatchProgressRepository implements WatchProgressRepository {
  readonly #hiddenAt = new Map<string, Date>();
  readonly #items = new Map<string, WatchProgress>();

  async upsert(record: UpsertWatchProgressRecord): Promise<WatchProgress> {
    const itemKey = key(record.profileId, record.mediaId, record.videoId);
    const existing = this.#items.get(itemKey);
    if (existing && existing.updatedAt > record.updatedAt) {
      const historical = { ...existing, watched: existing.watched === true || existing.completed || record.completed };
      this.#items.set(itemKey, historical);
      return copy(historical);
    }

    const item: WatchProgress = {
      ...record,
      id: existing?.id ?? record.id,
      watched: record.completed || existing?.watched === true || existing?.completed === true,
      hiddenFromContinue: existing?.hiddenFromContinue === true && record.updatedAt < (this.#hiddenAt.get(itemKey) ?? new Date(0)),
      updatedAt: new Date(record.updatedAt)
    };
    this.#items.set(itemKey, item);
    return copy(item);
  }

  async listForTitle(householdId: string, profileId: string, target: ProgressTitleTarget, offset: number): Promise<readonly WatchProgress[]> {
    return [...this.#items.values()].filter((item) =>
      item.householdId === householdId && item.profileId === profileId &&
      item.mediaType === target.mediaType &&
      (item.mediaId === target.mediaId || target.videoIds.includes(item.videoId) ||
        (target.mediaType === "movie" && target.videoIds.includes(item.mediaId)))
    ).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id))
      .slice(offset, offset + 100).map(copy);
  }

  async hideTitle(householdId: string, profileId: string, target: ProgressTitleTarget, at: Date): Promise<void> {
    const seriesId = target.mediaType === "series" ? /^tt\d{7,10}(?=:)/.exec(target.videoIds[0] ?? "")?.[0] : undefined;
    for (const [itemKey, item] of this.#items) {
      if (item.householdId === householdId && item.profileId === profileId && item.mediaType === target.mediaType &&
        (item.mediaId === target.mediaId || target.videoIds.includes(item.videoId) ||
          (seriesId !== undefined && item.videoId.startsWith(`${seriesId}:`)))) {
        this.#hiddenAt.set(itemKey, at);
        this.#items.set(itemKey, { ...item, hiddenFromContinue: true });
      }
    }
  }

  async listRecent(
    householdId: string,
    profileId: string,
    limit: number,
    includeCompleted: boolean
  ): Promise<readonly WatchProgress[]> {
    return [...this.#items.values()]
      .filter((item) =>
        item.householdId === householdId &&
        item.profileId === profileId &&
        !item.hiddenFromContinue && (includeCompleted || !item.completed)
      )
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
      .slice(0, limit)
      .map(copy);
  }
}

