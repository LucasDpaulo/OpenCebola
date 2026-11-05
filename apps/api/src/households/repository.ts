import type {
  Device,
  DeviceType,
  Household,
  OpaquePinHash,
  StoredProfile
} from "./domain.js";

export interface CreateHouseholdRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly createdAt: Date;
}

export interface CreateProfileRecord {
  readonly id: string;
  readonly householdId: string;
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly pinHash: OpaquePinHash | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UpdateProfileRecord {
  readonly name?: string;
  readonly avatarUrl?: string | null;
  readonly pinHash?: OpaquePinHash | null;
  readonly updatedAt: Date;
}

export interface RegisterDeviceRecord {
  readonly id: string;
  readonly householdId: string;
  readonly displayName: string;
  readonly type: DeviceType;
  readonly createdAt: Date;
}

/**
 * The limit-bearing operations must be atomic in every implementation.
 * A PostgreSQL adapter should use a transaction plus a household-scoped lock.
 */
export interface HouseholdRepository {
  createHousehold(record: CreateHouseholdRecord): Promise<Household>;
  findHouseholdById(householdId: string): Promise<Household | null>;
  findHouseholdByOwnerId(ownerId: string): Promise<Household | null>;

  createProfileWithinLimit(record: CreateProfileRecord, maximum: number): Promise<StoredProfile>;
  findProfile(householdId: string, profileId: string): Promise<StoredProfile | null>;
  listProfiles(householdId: string): Promise<readonly StoredProfile[]>;
  updateProfile(
    householdId: string,
    profileId: string,
    record: UpdateProfileRecord
  ): Promise<StoredProfile | null>;
  deleteProfile(householdId: string, profileId: string): Promise<boolean>;

  registerDeviceWithinActiveLimit(
    record: RegisterDeviceRecord,
    maximum: number
  ): Promise<Device>;
  findDevice(householdId: string, deviceId: string): Promise<Device | null>;
  listDevices(householdId: string): Promise<readonly Device[]>;
  revokeDevice(householdId: string, deviceId: string, revokedAt: Date): Promise<Device | null>;
  /** Updates lastSeenAt only if the device is still active, in one atomic operation. */
  touchActiveDevice(householdId: string, deviceId: string, seenAt: Date): Promise<Device | null>;
}
