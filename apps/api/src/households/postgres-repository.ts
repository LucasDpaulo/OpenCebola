import {
  ActiveDeviceLimitExceededError,
  MAX_ACTIVE_DEVICES_PER_HOUSEHOLD,
  MAX_PROFILES_PER_HOUSEHOLD,
  ProfileLimitExceededError,
  type Device,
  type DeviceStatus,
  type DeviceType,
  type Household,
  type OpaquePinHash,
  type StoredProfile
} from "./domain.js";
import type {
  CreateHouseholdRecord,
  CreateProfileRecord,
  HouseholdRepository,
  RegisterDeviceRecord,
  UpdateProfileRecord
} from "./repository.js";

export type DatabaseScalar = string | number | boolean | null;
export type DatabaseValues = Readonly<Record<string, DatabaseScalar>>;

/**
 * Small port implemented by a Supabase/PostgREST client adapter. Keeping it
 * here makes the repository unit-testable and avoids leaking a vendor SDK into
 * the domain.
 */
export interface PostgresGateway {
  insertOne<Row>(table: string, values: DatabaseValues): Promise<Row>;
  findOne<Row>(table: string, filters: DatabaseValues): Promise<Row | null>;
  findMany<Row>(table: string, filters: DatabaseValues): Promise<readonly Row[]>;
  updateOne<Row>(
    table: string,
    filters: DatabaseValues,
    values: DatabaseValues
  ): Promise<Row | null>;
  deleteOne(table: string, filters: DatabaseValues): Promise<boolean>;
  rpcOne<Row>(functionName: string, parameters: DatabaseValues): Promise<Row>;
  rpcMany<Row>(functionName: string, parameters: DatabaseValues): Promise<readonly Row[]>;
}

interface HouseholdRow {
  id: string;
  owner_user_id: string;
  name: string;
  created_at: string;
}

interface ProfileRow {
  id: string;
  household_id: string;
  name: string;
  avatar_url: string | null;
  pin_hash: string | null;
  created_at: string;
  updated_at: string;
}

interface DeviceRow {
  id: string;
  household_id: string;
  display_name: string;
  type: DeviceType;
  status: DeviceStatus;
  last_seen_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

function householdFromRow(row: HouseholdRow): Household {
  return {
    id: row.id,
    ownerId: row.owner_user_id,
    name: row.name,
    createdAt: new Date(row.created_at)
  };
}

function profileFromRow(row: ProfileRow): StoredProfile {
  return {
    id: row.id,
    householdId: row.household_id,
    name: row.name,
    avatarUrl: row.avatar_url,
    pinHash: row.pin_hash as OpaquePinHash | null,
    hasPin: row.pin_hash !== null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

function deviceFromRow(row: DeviceRow): Device {
  return {
    id: row.id,
    householdId: row.household_id,
    displayName: row.display_name,
    type: row.type,
    status: row.status,
    lastSeenAt: row.last_seen_at === null ? null : new Date(row.last_seen_at),
    createdAt: new Date(row.created_at),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at)
  };
}

function hasMessage(error: unknown, value: string): boolean {
  return error instanceof Error && error.message.includes(value);
}

export class PostgresHouseholdRepository implements HouseholdRepository {
  readonly #gateway: PostgresGateway;

  constructor(gateway: PostgresGateway) {
    this.#gateway = gateway;
  }

  async createHousehold(record: CreateHouseholdRecord): Promise<Household> {
    const row = await this.#gateway.insertOne<HouseholdRow>("households", {
      id: record.id,
      owner_user_id: record.ownerId,
      name: record.name,
      created_at: record.createdAt.toISOString()
    });
    return householdFromRow(row);
  }

  async findHouseholdById(householdId: string): Promise<Household | null> {
    const row = await this.#gateway.findOne<HouseholdRow>("households", { id: householdId });
    return row === null ? null : householdFromRow(row);
  }

  async findHouseholdByOwnerId(ownerId: string): Promise<Household | null> {
    const row = await this.#gateway.findOne<HouseholdRow>("households", {
      owner_user_id: ownerId
    });
    return row === null ? null : householdFromRow(row);
  }

  async createProfileWithinLimit(
    record: CreateProfileRecord,
    maximum: number
  ): Promise<StoredProfile> {
    if (maximum !== MAX_PROFILES_PER_HOUSEHOLD) throw new ProfileLimitExceededError();

    try {
      const row = await this.#gateway.rpcOne<ProfileRow>("cebola_create_profile_within_limit", {
        p_id: record.id,
        p_household_id: record.householdId,
        p_name: record.name,
        p_avatar_url: record.avatarUrl,
        p_pin_hash: record.pinHash,
        p_created_at: record.createdAt.toISOString()
      });
      return profileFromRow(row);
    } catch (error) {
      if (hasMessage(error, "profile_limit_reached")) throw new ProfileLimitExceededError();
      throw error;
    }
  }

  async findProfile(householdId: string, profileId: string): Promise<StoredProfile | null> {
    const row = await this.#gateway.findOne<ProfileRow>("profiles", {
      id: profileId,
      household_id: householdId
    });
    return row === null ? null : profileFromRow(row);
  }

  async listProfiles(householdId: string): Promise<readonly StoredProfile[]> {
    const rows = await this.#gateway.findMany<ProfileRow>("profiles", {
      household_id: householdId
    });
    return rows.map(profileFromRow);
  }

  async updateProfile(
    householdId: string,
    profileId: string,
    record: UpdateProfileRecord
  ): Promise<StoredProfile | null> {
    const values: Record<string, DatabaseScalar> = {
      updated_at: record.updatedAt.toISOString()
    };
    if (record.name !== undefined) values.name = record.name;
    if (record.avatarUrl !== undefined) values.avatar_url = record.avatarUrl;
    if (record.pinHash !== undefined) values.pin_hash = record.pinHash;

    const row = await this.#gateway.updateOne<ProfileRow>(
      "profiles",
      { id: profileId, household_id: householdId },
      values
    );
    return row === null ? null : profileFromRow(row);
  }

  async deleteProfile(householdId: string, profileId: string): Promise<boolean> {
    return this.#gateway.deleteOne("profiles", {
      id: profileId,
      household_id: householdId
    });
  }

  async registerDeviceWithinActiveLimit(
    record: RegisterDeviceRecord,
    maximum: number
  ): Promise<Device> {
    if (maximum !== MAX_ACTIVE_DEVICES_PER_HOUSEHOLD) {
      throw new ActiveDeviceLimitExceededError();
    }

    try {
      const row = await this.#gateway.rpcOne<DeviceRow>("cebola_register_device_within_limit", {
        p_id: record.id,
        p_household_id: record.householdId,
        p_display_name: record.displayName,
        p_type: record.type,
        p_created_at: record.createdAt.toISOString()
      });
      return deviceFromRow(row);
    } catch (error) {
      if (hasMessage(error, "device_limit_reached")) {
        throw new ActiveDeviceLimitExceededError();
      }
      throw error;
    }
  }

  async findDevice(householdId: string, deviceId: string): Promise<Device | null> {
    const row = await this.#gateway.findOne<DeviceRow>("devices", {
      id: deviceId,
      household_id: householdId
    });
    return row === null ? null : deviceFromRow(row);
  }

  async listDevices(householdId: string): Promise<readonly Device[]> {
    const rows = await this.#gateway.findMany<DeviceRow>("devices", {
      household_id: householdId
    });
    return rows.map(deviceFromRow);
  }

  async revokeDevice(
    householdId: string,
    deviceId: string,
    revokedAt: Date
  ): Promise<Device | null> {
    const row = await this.#gateway.updateOne<DeviceRow>(
      "devices",
      { id: deviceId, household_id: householdId, status: "active" },
      { status: "revoked", revoked_at: revokedAt.toISOString() }
    );
    if (row !== null) return deviceFromRow(row);
    return this.findDevice(householdId, deviceId);
  }

  async touchActiveDevice(
    householdId: string,
    deviceId: string,
    seenAt: Date
  ): Promise<Device | null> {
    const row = await this.#gateway.updateOne<DeviceRow>(
      "devices",
      { id: deviceId, household_id: householdId, status: "active" },
      { last_seen_at: seenAt.toISOString() }
    );
    return row === null ? null : deviceFromRow(row);
  }
}
