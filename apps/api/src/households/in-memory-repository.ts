import {
  ActiveDeviceLimitExceededError,
  ProfileLimitExceededError,
  type Device,
  type Household,
  type StoredProfile
} from "./domain.js";
import type {
  CreateHouseholdRecord,
  CreateProfileRecord,
  HouseholdRepository,
  RegisterDeviceRecord,
  UpdateProfileRecord
} from "./repository.js";

function copyDate(value: Date | null): Date | null {
  return value === null ? null : new Date(value);
}

function copyHousehold(value: Household): Household {
  return { ...value, createdAt: new Date(value.createdAt) };
}

function copyProfile(value: StoredProfile): StoredProfile {
  return {
    ...value,
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.updatedAt)
  };
}

function copyDevice(value: Device): Device {
  return {
    ...value,
    createdAt: new Date(value.createdAt),
    lastSeenAt: copyDate(value.lastSeenAt),
    revokedAt: copyDate(value.revokedAt)
  };
}

/**
 * Development/test adapter. Limit checks and writes intentionally happen in
 * one synchronous critical section before the promise resolves.
 */
export class InMemoryHouseholdRepository implements HouseholdRepository {
  readonly #households = new Map<string, Household>();
  readonly #profiles = new Map<string, StoredProfile>();
  readonly #devices = new Map<string, Device>();

  async createHousehold(record: CreateHouseholdRecord): Promise<Household> {
    const household: Household = { ...record, createdAt: new Date(record.createdAt) };
    this.#households.set(household.id, household);
    return copyHousehold(household);
  }

  async findHouseholdById(householdId: string): Promise<Household | null> {
    const household = this.#households.get(householdId);
    return household === undefined ? null : copyHousehold(household);
  }

  async findHouseholdByOwnerId(ownerId: string): Promise<Household | null> {
    const household = [...this.#households.values()].find((item) => item.ownerId === ownerId);
    return household === undefined ? null : copyHousehold(household);
  }

  async createProfileWithinLimit(
    record: CreateProfileRecord,
    maximum: number
  ): Promise<StoredProfile> {
    const currentCount = [...this.#profiles.values()].filter(
      (profile) => profile.householdId === record.householdId
    ).length;

    if (currentCount >= maximum) {
      throw new ProfileLimitExceededError();
    }

    const profile: StoredProfile = {
      ...record,
      hasPin: record.pinHash !== null,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt)
    };
    this.#profiles.set(profile.id, profile);
    return copyProfile(profile);
  }

  async findProfile(householdId: string, profileId: string): Promise<StoredProfile | null> {
    const profile = this.#profiles.get(profileId);
    if (profile === undefined || profile.householdId !== householdId) return null;
    return copyProfile(profile);
  }

  async listProfiles(householdId: string): Promise<readonly StoredProfile[]> {
    return [...this.#profiles.values()]
      .filter((profile) => profile.householdId === householdId)
      .map(copyProfile);
  }

  async updateProfile(
    householdId: string,
    profileId: string,
    record: UpdateProfileRecord
  ): Promise<StoredProfile | null> {
    const existing = this.#profiles.get(profileId);
    if (existing === undefined || existing.householdId !== householdId) return null;

    const updated: StoredProfile = {
      ...existing,
      name: record.name ?? existing.name,
      avatarUrl: record.avatarUrl !== undefined ? record.avatarUrl : existing.avatarUrl,
      pinHash: record.pinHash !== undefined ? record.pinHash : existing.pinHash,
      hasPin: record.pinHash !== undefined ? record.pinHash !== null : existing.hasPin,
      updatedAt: new Date(record.updatedAt)
    };
    this.#profiles.set(profileId, updated);
    return copyProfile(updated);
  }

  async deleteProfile(householdId: string, profileId: string): Promise<boolean> {
    const existing = this.#profiles.get(profileId);
    if (existing === undefined || existing.householdId !== householdId) return false;
    this.#profiles.delete(profileId);
    return true;
  }

  async registerDeviceWithinActiveLimit(
    record: RegisterDeviceRecord,
    maximum: number
  ): Promise<Device> {
    const activeCount = [...this.#devices.values()].filter(
      (device) => device.householdId === record.householdId && device.status === "active"
    ).length;

    if (activeCount >= maximum) {
      throw new ActiveDeviceLimitExceededError();
    }

    const device: Device = {
      ...record,
      status: "active",
      lastSeenAt: null,
      revokedAt: null,
      createdAt: new Date(record.createdAt)
    };
    this.#devices.set(device.id, device);
    return copyDevice(device);
  }

  async findDevice(householdId: string, deviceId: string): Promise<Device | null> {
    const device = this.#devices.get(deviceId);
    if (device === undefined || device.householdId !== householdId) return null;
    return copyDevice(device);
  }

  async listDevices(householdId: string): Promise<readonly Device[]> {
    return [...this.#devices.values()]
      .filter((device) => device.householdId === householdId)
      .map(copyDevice);
  }

  async revokeDevice(
    householdId: string,
    deviceId: string,
    revokedAt: Date
  ): Promise<Device | null> {
    const current = this.#devices.get(deviceId);
    if (current === undefined || current.householdId !== householdId) return null;
    if (current.status === "revoked") return copyDevice(current);

    const revoked: Device = {
      ...current,
      status: "revoked",
      revokedAt: new Date(revokedAt)
    };
    this.#devices.set(deviceId, revoked);
    return copyDevice(revoked);
  }

  async touchActiveDevice(
    householdId: string,
    deviceId: string,
    seenAt: Date
  ): Promise<Device | null> {
    const current = this.#devices.get(deviceId);
    if (
      current === undefined ||
      current.householdId !== householdId ||
      current.status !== "active"
    ) {
      return null;
    }

    const touched: Device = { ...current, lastSeenAt: new Date(seenAt) };
    this.#devices.set(deviceId, touched);
    return copyDevice(touched);
  }
}
