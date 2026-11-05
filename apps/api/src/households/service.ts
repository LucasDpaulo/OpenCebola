import { randomUUID } from "node:crypto";
import {
  DEFAULT_HOUSEHOLD_NAME,
  DeviceNotFoundError,
  DeviceRevokedError,
  HouseholdNotFoundError,
  MAX_ACTIVE_DEVICES_PER_HOUSEHOLD,
  MAX_PROFILES_PER_HOUSEHOLD,
  ProfileNotFoundError,
  assertNonEmptyName,
  type Device,
  type DeviceType,
  type Household,
  type OpaquePinHash,
  type Profile,
  type StoredProfile
} from "./domain.js";
import type { HouseholdRepository } from "./repository.js";

export interface HouseholdServiceDependencies {
  readonly repository: HouseholdRepository;
  readonly generateId?: () => string;
  readonly now?: () => Date;
  /**
   * Por quanto tempo a casa de um dono fica lembrada em memória. Ver `ensureHouseholdForOwner`.
   * Zero desliga o cache.
   */
  readonly ownerCacheTtlMs?: number;
  /** Teto de entradas do cache de casas. Ver `MAX_OWNER_CACHE_ENTRIES`. */
  readonly ownerCacheMaxEntries?: number;
}

export interface CreateHouseholdInput {
  readonly ownerId: string;
  readonly name: string;
}

export interface CreateProfileInput {
  readonly householdId: string;
  readonly name: string;
  readonly avatarUrl?: string | null;
  readonly pinHash?: OpaquePinHash | null;
}

export interface UpdateProfileInput {
  readonly householdId: string;
  readonly profileId: string;
  readonly name?: string;
  readonly avatarUrl?: string | null;
  readonly pinHash?: OpaquePinHash | null;
  readonly clearPin?: boolean;
}

export interface RegisterDeviceInput {
  readonly householdId: string;
  readonly displayName: string;
  readonly type: DeviceType;
}

function publicProfile(profile: StoredProfile): Profile {
  const { pinHash: _secret, ...safe } = profile;
  return safe;
}

/** Uma casa por dono, e ela não muda de identidade depois de criada. Ver o cache abaixo. */
const DEFAULT_OWNER_CACHE_TTL_MS = 60_000;
/**
 * Teto de memória. Sem ele o Map só crescia: uma entrada por dono autenticado, nunca removida
 * — nada apagava as vencidas, só as substituía. Um processo longo servindo muitas casas segurava
 * todas elas para sempre.
 */
const MAX_OWNER_CACHE_ENTRIES = 5_000;

export class HouseholdService {
  readonly #repository: HouseholdRepository;
  readonly #generateId: () => string;
  readonly #now: () => Date;
  readonly #ownerCacheTtlMs: number;
  readonly #ownerCacheMaxEntries: number;
  readonly #ownerCache = new Map<string, { expiresAt: number; household: Household }>();

  constructor(dependencies: HouseholdServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#generateId = dependencies.generateId ?? randomUUID;
    this.#now = dependencies.now ?? (() => new Date());
    this.#ownerCacheTtlMs = dependencies.ownerCacheTtlMs ?? DEFAULT_OWNER_CACHE_TTL_MS;
    this.#ownerCacheMaxEntries = dependencies.ownerCacheMaxEntries ?? MAX_OWNER_CACHE_ENTRIES;
  }

  async createHousehold(input: CreateHouseholdInput): Promise<Household> {
    return this.#repository.createHousehold({
      id: this.#generateId(),
      ownerId: assertNonEmptyName(input.ownerId, "ownerId", 200),
      name: assertNonEmptyName(input.name, "household name", 100),
      createdAt: this.#now()
    });
  }

  async findHouseholdByOwnerId(ownerId: string): Promise<Household | null> {
    return this.#repository.findHouseholdByOwnerId(
      assertNonEmptyName(ownerId, "ownerId", 200)
    );
  }

  /**
   * Todo usuário autenticado tem exatamente uma casa: devolve a existente ou
   * provisiona uma com o nome padrão no primeiro acesso, qualquer que seja a
   * rota que chegue primeiro.
   *
   * Praticamente toda rota autenticada começa por aqui, e cada chamada era uma ida ao
   * Postgres para reler uma linha que não muda: uma casa é criada uma vez e mantém id e dono
   * para sempre. O cache é curto mesmo assim — ele existe para colapsar a rajada de uma tela,
   * e um TTL curto significa que nada precisa saber invalidá-lo.
   */
  async ensureHouseholdForOwner(ownerId: string): Promise<Household> {
    const remembered = this.#ownerCache.get(ownerId);
    if (remembered && remembered.expiresAt > this.#now().getTime()) return remembered.household;

    const current = await this.findHouseholdByOwnerId(ownerId);
    if (current) return this.#rememberHousehold(ownerId, current);

    try {
      return this.#rememberHousehold(
        ownerId,
        await this.createHousehold({ ownerId, name: DEFAULT_HOUSEHOLD_NAME })
      );
    } catch (error) {
      // Duas primeiras requisições podem tentar provisionar a mesma casa. A
      // restrição UNIQUE do banco decide; a perdedora reutiliza o registro.
      const createdConcurrently = await this.findHouseholdByOwnerId(ownerId);
      if (createdConcurrently) return this.#rememberHousehold(ownerId, createdConcurrently);
      throw error;
    }
  }

  #rememberHousehold(ownerId: string, household: Household): Household {
    if (this.#ownerCacheTtlMs <= 0) return household;
    if (!this.#ownerCache.has(ownerId) && this.#ownerCache.size >= this.#ownerCacheMaxEntries) {
      this.#evictOneOwner();
    }
    this.#ownerCache.set(ownerId, {
      expiresAt: this.#now().getTime() + this.#ownerCacheTtlMs,
      household
    });
    return household;
  }

  /** Vencidas primeiro: despejar a mais antiga por inserção descarta entrada quente à toa. */
  #evictOneOwner(): void {
    const now = this.#now().getTime();
    for (const [ownerId, entry] of this.#ownerCache) {
      if (entry.expiresAt <= now) {
        this.#ownerCache.delete(ownerId);
        return;
      }
    }
    const oldest = this.#ownerCache.keys().next().value;
    if (oldest !== undefined) this.#ownerCache.delete(oldest);
  }

  async createProfile(input: CreateProfileInput): Promise<Profile> {
    await this.#requireHousehold(input.householdId);
    const timestamp = this.#now();
    const stored = await this.#repository.createProfileWithinLimit(
      {
        id: this.#generateId(),
        householdId: input.householdId,
        name: assertNonEmptyName(input.name, "profile name", 80),
        avatarUrl: input.avatarUrl ?? null,
        pinHash: input.pinHash ?? null,
        createdAt: timestamp,
        updatedAt: timestamp
      },
      MAX_PROFILES_PER_HOUSEHOLD
    );
    return publicProfile(stored);
  }

  async listProfiles(householdId: string): Promise<readonly Profile[]> {
    await this.#requireHousehold(householdId);
    return (await this.#repository.listProfiles(householdId)).map(publicProfile);
  }

  async getProfile(householdId: string, profileId: string): Promise<Profile> {
    await this.#requireHousehold(householdId);
    const profile = await this.#repository.findProfile(householdId, profileId);
    if (profile === null) throw new ProfileNotFoundError(profileId);
    return publicProfile(profile);
  }

  async updateProfile(input: UpdateProfileInput): Promise<Profile> {
    await this.#requireHousehold(input.householdId);
    const existing = await this.#repository.findProfile(input.householdId, input.profileId);
    if (existing === null) throw new ProfileNotFoundError(input.profileId);

    const updateRecord = {
      name: input.name !== undefined ? assertNonEmptyName(input.name, "profile name", 80) : undefined,
      avatarUrl: input.avatarUrl,
      pinHash: input.clearPin ? null : input.pinHash,
      updatedAt: this.#now()
    };

    const updated = await this.#repository.updateProfile(
      input.householdId,
      input.profileId,
      updateRecord
    );
    if (updated === null) throw new ProfileNotFoundError(input.profileId);
    return publicProfile(updated);
  }

  async deleteProfile(householdId: string, profileId: string): Promise<void> {
    await this.#requireHousehold(householdId);
    const existing = await this.#repository.findProfile(householdId, profileId);
    if (existing === null) throw new ProfileNotFoundError(profileId);

    const deleted = await this.#repository.deleteProfile(householdId, profileId);
    if (!deleted) throw new ProfileNotFoundError(profileId);
  }

  async registerDevice(input: RegisterDeviceInput): Promise<Device> {
    await this.#requireHousehold(input.householdId);
    return this.#repository.registerDeviceWithinActiveLimit(
      {
        id: this.#generateId(),
        householdId: input.householdId,
        displayName: assertNonEmptyName(input.displayName, "device display name", 100),
        type: input.type,
        createdAt: this.#now()
      },
      MAX_ACTIVE_DEVICES_PER_HOUSEHOLD
    );
  }

  async listDevices(householdId: string): Promise<readonly Device[]> {
    await this.#requireHousehold(householdId);
    return this.#repository.listDevices(householdId);
  }

  async revokeDevice(householdId: string, deviceId: string): Promise<Device> {
    await this.#requireHousehold(householdId);
    const device = await this.#repository.revokeDevice(householdId, deviceId, this.#now());
    if (device === null) throw new DeviceNotFoundError(deviceId);
    return device;
  }

  async authorizeDevice(householdId: string, deviceId: string): Promise<Device> {
    await this.#requireHousehold(householdId);
    const touched = await this.#repository.touchActiveDevice(householdId, deviceId, this.#now());
    if (touched === null) {
      const device = await this.#repository.findDevice(householdId, deviceId);
      if (device === null) throw new DeviceNotFoundError(deviceId);
      if (device.status === "revoked") throw new DeviceRevokedError(deviceId);
      throw new DeviceNotFoundError(deviceId);
    }
    return touched;
  }

  async #requireHousehold(householdId: string): Promise<Household> {
    const household = await this.#repository.findHouseholdById(householdId);
    if (household === null) throw new HouseholdNotFoundError(householdId);
    return household;
  }
}
