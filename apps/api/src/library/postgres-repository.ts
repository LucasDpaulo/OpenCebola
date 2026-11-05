import type { MediaType } from "@cebola/contracts";
import type { PostgresGateway } from "../households/index.js";
import type { LibraryItem } from "./domain.js";
import type {
  LibraryRepository,
  UpsertLibraryItemRecord
} from "./repository.js";

interface LibraryItemRow {
  id: string;
  household_id: string;
  profile_id: string;
  addon_id: string;
  media_id: string;
  media_type: MediaType;
  name: string;
  poster_url: string | null;
  background_url: string | null;
  description: string | null;
  release_info: string | null;
  created_at: string;
  updated_at: string;
}

function fromRow(row: LibraryItemRow): LibraryItem {
  return {
    id: row.id,
    householdId: row.household_id,
    profileId: row.profile_id,
    addonId: row.addon_id,
    mediaId: row.media_id,
    mediaType: row.media_type,
    name: row.name,
    posterUrl: row.poster_url,
    backgroundUrl: row.background_url,
    description: row.description,
    releaseInfo: row.release_info,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

export class PostgresLibraryRepository implements LibraryRepository {
  readonly #gateway: PostgresGateway;

  constructor(gateway: PostgresGateway) {
    this.#gateway = gateway;
  }

  async list(householdId: string, profileId: string): Promise<readonly LibraryItem[]> {
    const rows = await this.#gateway.rpcMany<LibraryItemRow>("cebola_list_library", {
      p_household_id: householdId,
      p_profile_id: profileId
    });
    return rows.map(fromRow);
  }

  async upsert(record: UpsertLibraryItemRecord): Promise<LibraryItem> {
    const row = await this.#gateway.rpcOne<LibraryItemRow>("cebola_upsert_library_item", {
      p_id: record.id,
      p_household_id: record.householdId,
      p_profile_id: record.profileId,
      p_addon_id: record.addonId,
      p_media_id: record.mediaId,
      p_media_type: record.mediaType,
      p_name: record.name,
      p_poster_url: record.posterUrl,
      p_background_url: record.backgroundUrl,
      p_description: record.description,
      p_release_info: record.releaseInfo,
      p_created_at: record.createdAt.toISOString(),
      p_updated_at: record.updatedAt.toISOString()
    });
    return fromRow(row);
  }

  async remove(
    householdId: string,
    profileId: string,
    mediaType: MediaType,
    mediaId: string
  ): Promise<boolean> {
    return this.#gateway.rpcOne<boolean>("cebola_remove_library_item", {
      p_household_id: householdId,
      p_profile_id: profileId,
      p_media_type: mediaType,
      p_media_id: mediaId
    });
  }
}
