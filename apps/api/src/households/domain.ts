export const MAX_PROFILES_PER_HOUSEHOLD = 8;
export const MAX_ACTIVE_DEVICES_PER_HOUSEHOLD = 20;

/** Nome da casa provisionada automaticamente no primeiro acesso autenticado. */
export const DEFAULT_HOUSEHOLD_NAME = "Minha casa";

export type DeviceType = "web" | "mobile" | "tv" | "desktop";
export type DeviceStatus = "active" | "revoked";

declare const pinHashBrand: unique symbol;

/**
 * A PIN hash is deliberately opaque to the household domain. Hashing and
 * verification belong to the authentication adapter; this domain never
 * accepts or returns a plain PIN.
 */
export type OpaquePinHash = string & { readonly [pinHashBrand]: true };

export function opaqueArgon2idPinHash(encodedHash: string): OpaquePinHash {
  if (!encodedHash.startsWith("$argon2id$") || encodedHash.length < 40) {
    throw new DomainValidationError(
      "pinHash must be an encoded Argon2id hash; a plain PIN is not accepted"
    );
  }

  return encodedHash as OpaquePinHash;
}

export interface Household {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly createdAt: Date;
}

export interface Profile {
  readonly id: string;
  readonly householdId: string;
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly hasPin: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface StoredProfile extends Profile {
  /** Repository-only secret. Do not expose this object through transports. */
  readonly pinHash: OpaquePinHash | null;
}

export interface Device {
  readonly id: string;
  readonly householdId: string;
  readonly displayName: string;
  readonly type: DeviceType;
  readonly status: DeviceStatus;
  readonly lastSeenAt: Date | null;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
}

export class HouseholdDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class DomainValidationError extends HouseholdDomainError {}

export class HouseholdNotFoundError extends HouseholdDomainError {
  constructor(householdId: string) {
    super(`Household ${householdId} was not found`);
  }
}

export class ProfileNotFoundError extends HouseholdDomainError {
  constructor(profileId: string) {
    super(`Profile ${profileId} was not found in this household`);
  }
}

export class DeviceNotFoundError extends HouseholdDomainError {
  constructor(deviceId: string) {
    super(`Device ${deviceId} was not found in this household`);
  }
}

export class ProfileLimitExceededError extends HouseholdDomainError {
  constructor() {
    super(`A household can have at most ${MAX_PROFILES_PER_HOUSEHOLD} profiles`);
  }
}

export class ActiveDeviceLimitExceededError extends HouseholdDomainError {
  constructor() {
    super(
      `A household can have at most ${MAX_ACTIVE_DEVICES_PER_HOUSEHOLD} active devices`
    );
  }
}

export class DeviceRevokedError extends HouseholdDomainError {
  constructor(deviceId: string) {
    super(`Device ${deviceId} has been revoked`);
  }
}

export function assertNonEmptyName(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();

  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new DomainValidationError(`${field} must contain between 1 and ${maxLength} characters`);
  }

  return normalized;
}
