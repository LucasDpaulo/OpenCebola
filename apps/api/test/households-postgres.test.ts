import assert from "node:assert/strict";
import test from "node:test";
import {
  ActiveDeviceLimitExceededError,
  PostgresHouseholdRepository,
  ProfileLimitExceededError,
  type DatabaseValues,
  type PostgresGateway
} from "../src/households/index.js";

interface RecordedCall {
  method: string;
  target: string;
  first: DatabaseValues;
  second?: DatabaseValues;
}

class RecordingGateway implements PostgresGateway {
  readonly calls: RecordedCall[] = [];
  readonly #results: unknown[];

  constructor(...results: unknown[]) {
    this.#results = [...results];
  }

  #next<Row>(): Row {
    const result = this.#results.shift();
    if (result instanceof Error) throw result;
    return result as Row;
  }

  async insertOne<Row>(table: string, values: DatabaseValues): Promise<Row> {
    this.calls.push({ method: "insertOne", target: table, first: values });
    return this.#next<Row>();
  }

  async findOne<Row>(table: string, filters: DatabaseValues): Promise<Row | null> {
    this.calls.push({ method: "findOne", target: table, first: filters });
    return this.#next<Row | null>();
  }

  async findMany<Row>(table: string, filters: DatabaseValues): Promise<readonly Row[]> {
    this.calls.push({ method: "findMany", target: table, first: filters });
    return this.#next<readonly Row[]>();
  }

  async updateOne<Row>(
    table: string,
    filters: DatabaseValues,
    values: DatabaseValues
  ): Promise<Row | null> {
    this.calls.push({ method: "updateOne", target: table, first: filters, second: values });
    return this.#next<Row | null>();
  }

  async deleteOne(table: string, filters: DatabaseValues): Promise<boolean> {
    this.calls.push({ method: "deleteOne", target: table, first: filters });
    return this.#next<boolean>();
  }

  async rpcOne<Row>(functionName: string, parameters: DatabaseValues): Promise<Row> {
    this.calls.push({ method: "rpcOne", target: functionName, first: parameters });
    return this.#next<Row>();
  }

  async rpcMany<Row>(functionName: string, parameters: DatabaseValues): Promise<readonly Row[]> {
    this.calls.push({ method: "rpcMany", target: functionName, first: parameters });
    return this.#next<readonly Row[]>();
  }
}

const householdRow = {
  id: "house-1",
  owner_user_id: "owner-1",
  name: "Casa",
  created_at: "2026-08-18T20:00:00.000Z"
};

const profileRow = {
  id: "profile-1",
  household_id: "house-1",
  name: "Lucas",
  avatar_url: null,
  pin_hash: null,
  created_at: "2026-08-18T20:00:00.000Z",
  updated_at: "2026-08-18T20:00:00.000Z"
};

const activeDeviceRow = {
  id: "device-1",
  household_id: "house-1",
  display_name: "TV",
  type: "tv" as const,
  status: "active" as const,
  last_seen_at: null,
  created_at: "2026-08-18T20:00:00.000Z",
  revoked_at: null
};

test("findHouseholdByOwnerId scopes lookup to owner_user_id and maps dates", async () => {
  const gateway = new RecordingGateway(householdRow);
  const repository = new PostgresHouseholdRepository(gateway);

  const household = await repository.findHouseholdByOwnerId("owner-1");

  assert.equal(household?.ownerId, "owner-1");
  assert.ok(household?.createdAt instanceof Date);
  assert.deepEqual(gateway.calls[0], {
    method: "findOne",
    target: "households",
    first: { owner_user_id: "owner-1" }
  });
});

test("profile creation uses the atomic RPC and translates its limit error", async () => {
  const gateway = new RecordingGateway(profileRow, new Error("profile_limit_reached"));
  const repository = new PostgresHouseholdRepository(gateway);
  const record = {
    id: "profile-1",
    householdId: "house-1",
    name: "Lucas",
    avatarUrl: null,
    pinHash: null,
    createdAt: new Date("2026-08-18T20:00:00.000Z"),
    updatedAt: new Date("2026-08-18T20:00:00.000Z")
  };

  const profile = await repository.createProfileWithinLimit(record, 8);
  assert.equal(profile.householdId, "house-1");
  assert.equal(gateway.calls[0]?.target, "cebola_create_profile_within_limit");
  assert.equal(gateway.calls[0]?.first.p_household_id, "house-1");
  await assert.rejects(
    repository.createProfileWithinLimit({ ...record, id: "profile-2" }, 8),
    ProfileLimitExceededError
  );
});

test("device registration uses the atomic RPC and translates its limit error", async () => {
  const gateway = new RecordingGateway(activeDeviceRow, new Error("device_limit_reached"));
  const repository = new PostgresHouseholdRepository(gateway);
  const record = {
    id: "device-1",
    householdId: "house-1",
    displayName: "TV",
    type: "tv" as const,
    createdAt: new Date("2026-08-18T20:00:00.000Z")
  };

  assert.equal((await repository.registerDeviceWithinActiveLimit(record, 20)).status, "active");
  assert.equal(gateway.calls[0]?.target, "cebola_register_device_within_limit");
  await assert.rejects(
    repository.registerDeviceWithinActiveLimit({ ...record, id: "device-2" }, 20),
    ActiveDeviceLimitExceededError
  );
});

test("touchActiveDevice is one household-scoped update restricted to active status", async () => {
  const touchedRow = { ...activeDeviceRow, last_seen_at: "2026-08-18T21:00:00.000Z" };
  const gateway = new RecordingGateway(touchedRow);
  const repository = new PostgresHouseholdRepository(gateway);

  const device = await repository.touchActiveDevice(
    "house-1",
    "device-1",
    new Date("2026-08-18T21:00:00.000Z")
  );

  assert.ok(device?.lastSeenAt instanceof Date);
  assert.deepEqual(gateway.calls[0], {
    method: "updateOne",
    target: "devices",
    first: { id: "device-1", household_id: "house-1", status: "active" },
    second: { last_seen_at: "2026-08-18T21:00:00.000Z" }
  });
});

test("all resource reads include household_id isolation", async () => {
  const gateway = new RecordingGateway(profileRow, activeDeviceRow, [profileRow], [activeDeviceRow]);
  const repository = new PostgresHouseholdRepository(gateway);

  await repository.findProfile("house-1", "profile-1");
  await repository.findDevice("house-1", "device-1");
  await repository.listProfiles("house-1");
  await repository.listDevices("house-1");

  for (const call of gateway.calls) {
    assert.equal(call.first.household_id, "house-1");
  }
});
