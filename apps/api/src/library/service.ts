import { randomUUID } from "node:crypto";
import type {
  MediaType,
  UpsertLibraryItemRequest
} from "@cebola/contracts";
import {
  ProfileNotFoundError,
  type HouseholdRepository
} from "../households/index.js";
import {
  InvalidLibraryItemError,
  LibraryItemNotFoundError,
  libraryHttpsUrl,
  libraryOptionalText,
  normalizedLibraryMediaId,
  normalizedLibraryText,
  type LibraryItem
} from "./domain.js";
import type { LibraryRepository } from "./repository.js";

export interface LibraryScope {
  readonly householdId: string;
  readonly profileId: string;
}

export interface LibraryServiceDependencies {
  readonly repository: LibraryRepository;
  readonly households: HouseholdRepository;
  readonly generateId?: () => string;
  readonly now?: () => Date;
}

function normalizedMediaType(value: MediaType): MediaType {
  if (value !== "movie" && value !== "series") {
    throw new InvalidLibraryItemError("mediaType is invalid");
  }
  return value;
}

export class LibraryService {
  readonly #repository: LibraryRepository;
  readonly #households: HouseholdRepository;
  readonly #generateId: () => string;
  readonly #now: () => Date;

  constructor(dependencies: LibraryServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#households = dependencies.households;
    this.#generateId = dependencies.generateId ?? randomUUID;
    this.#now = dependencies.now ?? (() => new Date());
  }

  async list(householdId: string, profileId: string): Promise<readonly LibraryItem[]> {
    await this.#requireProfile(householdId, profileId);
    return this.#repository.list(householdId, profileId);
  }

  async upsert(scope: LibraryScope, input: UpsertLibraryItemRequest): Promise<LibraryItem> {
    await this.#requireProfile(scope.householdId, scope.profileId);
    await this.#requireCapacity(scope, [input]);
    return this.#upsert(scope, input);
  }

  async remove(scope: LibraryScope, mediaType: MediaType, mediaId: string): Promise<void> {
    await this.#requireProfile(scope.householdId, scope.profileId);
    const normalizedType = normalizedMediaType(mediaType);
    const normalizedId = normalizedLibraryMediaId(mediaId);
    const removed = await this.#repository.remove(
      scope.householdId,
      scope.profileId,
      normalizedType,
      normalizedId
    );
    if (!removed) throw new LibraryItemNotFoundError(normalizedType, normalizedId);
  }

  async import(
    scope: LibraryScope,
    items: readonly UpsertLibraryItemRequest[]
  ): Promise<readonly LibraryItem[]> {
    await this.#requireProfile(scope.householdId, scope.profileId);
    if (items.length > 200) {
      throw new InvalidLibraryItemError("library import exceeds 200 items");
    }
    await this.#requireCapacity(scope, items);
    for (const item of items) await this.#upsert(scope, item);
    return this.#repository.list(scope.householdId, scope.profileId);
  }

  async #requireCapacity(scope: LibraryScope, incoming: readonly UpsertLibraryItemRequest[]): Promise<void> {
    const current = await this.#repository.list(scope.householdId, scope.profileId);
    const identities = new Set(current.map((item) => JSON.stringify([item.mediaType, item.mediaId])));
    // Conta a união canônica inteira antes da primeira gravação, incluindo atualizações e
    // duplicados do lote. No teto, atualizar uma identidade existente continua permitido.
    for (const item of incoming) {
      identities.add(JSON.stringify([
        normalizedMediaType(item.mediaType),
        normalizedLibraryMediaId(item.mediaId)
      ]));
    }
    if (identities.size > 500) {
      throw new InvalidLibraryItemError("library exceeds 500 items");
    }
  }

  async #upsert(scope: LibraryScope, input: UpsertLibraryItemRequest): Promise<LibraryItem> {
    const timestamp = this.#now();
    return this.#repository.upsert({
      id: this.#generateId(),
      householdId: scope.householdId,
      profileId: scope.profileId,
      addonId: normalizedLibraryText(input.addonId, "addonId", 200),
      mediaId: normalizedLibraryMediaId(input.mediaId),
      mediaType: normalizedMediaType(input.mediaType),
      name: normalizedLibraryText(input.name, "name", 300),
      posterUrl: libraryHttpsUrl(input.posterUrl, "posterUrl"),
      backgroundUrl: libraryHttpsUrl(input.backgroundUrl, "backgroundUrl"),
      description: libraryOptionalText(input.description, "description", 5_000),
      releaseInfo: libraryOptionalText(input.releaseInfo, "releaseInfo", 100),
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }

  async #requireProfile(householdId: string, profileId: string): Promise<void> {
    const profile = await this.#households.findProfile(householdId, profileId);
    if (profile === null) throw new ProfileNotFoundError(profileId);
  }
}
