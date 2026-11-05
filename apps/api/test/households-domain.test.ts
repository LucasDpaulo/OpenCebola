import assert from "node:assert/strict";
import test from "node:test";
import {
  ActiveDeviceLimitExceededError,
  DeviceNotFoundError,
  DeviceRevokedError,
  DomainValidationError,
  HouseholdService,
  InMemoryHouseholdRepository,
  ProfileLimitExceededError,
  ProfileNotFoundError,
  opaqueArgon2idPinHash,
  type CreateHouseholdRecord
} from "../src/households/index.js";

const validPinHash =
  "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$YW5vcGFxdWVkaWdlc3Rmb3J0ZXN0cw";

function createFixture() {
  let sequence = 0;
  let clock = 0;
  const repository = new InMemoryHouseholdRepository();
  const service = new HouseholdService({
    repository,
    generateId: () => `id-${++sequence}`,
    now: () => new Date(1_700_000_000_000 + clock++ * 1_000)
  });
  return { repository, service };
}

test("creates a profile with an optional opaque PIN hash without exposing it", async () => {
  const { repository, service } = createFixture();
  const household = await service.createHousehold({ ownerId: "owner-1", name: "Casa" });
  const profile = await service.createProfile({
    householdId: household.id,
    name: " Lucas ",
    pinHash: opaqueArgon2idPinHash(validPinHash)
  });

  assert.equal(profile.name, "Lucas");
  assert.equal(profile.hasPin, true);
  assert.equal("pinHash" in profile, false);

  const stored = await repository.findProfile(household.id, profile.id);
  assert.equal(stored?.pinHash, validPinHash);
});

test("finds the household from the authenticated owner id", async () => {
  const { service } = createFixture();
  const household = await service.createHousehold({ ownerId: "auth-user-1", name: "Casa" });

  assert.deepEqual(await service.findHouseholdByOwnerId("auth-user-1"), household);
  assert.equal(await service.findHouseholdByOwnerId("other-user"), null);
});

test("ensureHouseholdForOwner provisiona a casa padrão uma única vez por dono", async () => {
  const { service } = createFixture();

  const created = await service.ensureHouseholdForOwner("auth-user-1");
  assert.equal(created.ownerId, "auth-user-1");
  assert.equal(created.name, "Minha casa");

  const reused = await service.ensureHouseholdForOwner("auth-user-1");
  assert.deepEqual(reused, created);
});

test("dois ensure concorrentes convergem para uma única casa", async () => {
  const { repository, service } = createFixture();
  const originalCreate = repository.createHousehold.bind(repository);
  const owners = new Set<string>();

  // O adapter em memória não impõe UNIQUE(owner_user_id); este patch simula a
  // restrição do banco: o segundo insert do mesmo dono falha como no Postgres.
  Object.defineProperty(repository, "createHousehold", {
    configurable: true,
    value: async (record: CreateHouseholdRecord) => {
      if (owners.has(record.ownerId)) {
        throw new Error("duplicate key value violates unique constraint");
      }
      owners.add(record.ownerId);
      return originalCreate(record);
    }
  });

  const [first, second] = await Promise.all([
    service.ensureHouseholdForOwner("auth-user-1"),
    service.ensureHouseholdForOwner("auth-user-1")
  ]);

  // A perdedora da corrida reutiliza o registro da vencedora: uma casa só.
  assert.deepEqual(first, second);
  assert.deepEqual(await service.findHouseholdByOwnerId("auth-user-1"), first);
});

test("ensureHouseholdForOwner propaga a falha original sem criação concorrente", async () => {
  const { repository, service } = createFixture();
  const failure = new Error("banco indisponível");
  Object.defineProperty(repository, "createHousehold", {
    configurable: true,
    value: async () => {
      throw failure;
    }
  });

  await assert.rejects(
    service.ensureHouseholdForOwner("auth-user-1"),
    (error: unknown) => error === failure
  );
  assert.equal(await service.findHouseholdByOwnerId("auth-user-1"), null);
});

test("rejects a plain PIN where an Argon2id hash is required", () => {
  assert.throws(() => opaqueArgon2idPinHash("1234"), DomainValidationError);
});

test("enforces eight profiles atomically under concurrent requests", async () => {
  const { service } = createFixture();
  const household = await service.createHousehold({ ownerId: "owner-1", name: "Casa" });

  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, index) =>
      service.createProfile({ householdId: household.id, name: `Perfil ${index}` })
    )
  );

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 8);
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  assert.equal(rejected.length, 4);
  assert.ok(rejected.every((result) => result.reason instanceof ProfileLimitExceededError));
});

test("enforces twenty active devices and frees a slot after revocation", async () => {
  const { service } = createFixture();
  const household = await service.createHousehold({ ownerId: "owner-1", name: "Casa" });

  const results = await Promise.allSettled(
    Array.from({ length: 24 }, (_, index) =>
      service.registerDevice({
        householdId: household.id,
        displayName: `TV ${index}`,
        type: "tv"
      })
    )
  );

  const devices = results
    .filter((result): result is PromiseFulfilledResult<Awaited<typeof result.value>> =>
      result.status === "fulfilled"
    )
    .map((result) => result.value);
  assert.equal(devices.length, 20);
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  assert.ok(rejected.every((result) => result.reason instanceof ActiveDeviceLimitExceededError));

  await service.revokeDevice(household.id, devices[0]!.id);
  const replacement = await service.registerDevice({
    householdId: household.id,
    displayName: "TV substituta",
    type: "tv"
  });
  assert.equal(replacement.status, "active");
});

test("isolates profile and device access between households", async () => {
  const { service } = createFixture();
  const first = await service.createHousehold({ ownerId: "owner-1", name: "Casa 1" });
  const second = await service.createHousehold({ ownerId: "owner-2", name: "Casa 2" });
  const profile = await service.createProfile({ householdId: first.id, name: "Lucas" });
  const device = await service.registerDevice({
    householdId: first.id,
    displayName: "Notebook",
    type: "desktop"
  });

  await assert.rejects(service.getProfile(second.id, profile.id), ProfileNotFoundError);
  await assert.rejects(service.authorizeDevice(second.id, device.id), DeviceNotFoundError);
  await assert.rejects(service.revokeDevice(second.id, device.id), DeviceNotFoundError);
});

test("revoked devices can no longer authorize", async () => {
  const { service } = createFixture();
  const household = await service.createHousehold({ ownerId: "owner-1", name: "Casa" });
  const device = await service.registerDevice({
    householdId: household.id,
    displayName: "Celular",
    type: "mobile"
  });

  const authorized = await service.authorizeDevice(household.id, device.id);
  assert.ok(authorized.lastSeenAt instanceof Date);

  const revoked = await service.revokeDevice(household.id, device.id);
  assert.equal(revoked.status, "revoked");
  assert.ok(revoked.revokedAt instanceof Date);
  await assert.rejects(service.authorizeDevice(household.id, device.id), DeviceRevokedError);
});

test("a revocation racing with authorization wins before lastSeen is touched", async () => {
  const { repository, service } = createFixture();
  const household = await service.createHousehold({ ownerId: "owner-1", name: "Casa" });
  const device = await service.registerDevice({
    householdId: household.id,
    displayName: "TV",
    type: "tv"
  });
  const originalTouch = repository.touchActiveDevice.bind(repository);

  Object.defineProperty(repository, "touchActiveDevice", {
    configurable: true,
    value: async (householdId: string, deviceId: string, seenAt: Date) => {
      await repository.revokeDevice(householdId, deviceId, new Date(seenAt.getTime() - 1));
      return originalTouch(householdId, deviceId, seenAt);
    }
  });

  await assert.rejects(service.authorizeDevice(household.id, device.id), DeviceRevokedError);
  const stored = await repository.findDevice(household.id, device.id);
  assert.equal(stored?.status, "revoked");
  assert.equal(stored?.lastSeenAt, null);
});
