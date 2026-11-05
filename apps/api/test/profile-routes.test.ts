import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { InMemoryAuthProvider } from "../src/auth/index.js";
import {
  HouseholdService,
  InMemoryHouseholdRepository
} from "../src/households/index.js";
import type { ProfilePinService } from "../src/profiles/index.js";

const webOrigin = "http://localhost:3000";
const environment = {
  NODE_ENV: "test" as const,
  CEBOLA_API_HOST: "127.0.0.1",
  CEBOLA_API_PORT: 3001,
  CEBOLA_WEB_ORIGIN: webOrigin,
  CEBOLA_SESSION_TTL_SECONDS: 3_600
};
const userId = "26bd6155-a16d-445c-84de-20db3b0cd65f";
const encodedPinHash =
  "$argon2id$v=19$m=19456,t=2,p=1$c2FsdC1mb3ItdGVzdA$ZGlnZXN0LWZvci10ZXN0LXB1cnBvc2Vz";

class FakePinService implements ProfilePinService {
  async hashPin(pin: string): Promise<string> {
    if (pin !== "1234") throw new Error("unexpected fixture PIN");
    return encodedPinHash;
  }

  async verifyPin(pin: string, hash: string): Promise<boolean> {
    return pin === "1234" && hash === encodedPinHash;
  }
}

function fixture() {
  const authProvider = new InMemoryAuthProvider({
    users: [{ id: userId, email: "lucas@example.com", password: "correct-secret" }],
    tokenFactory: () => "profile-route-session"
  });
  const householdRepository = new InMemoryHouseholdRepository();
  const householdService = new HouseholdService({ repository: householdRepository });
  return {
    authProvider,
    householdRepository,
    householdService,
    pinService: new FakePinService()
  };
}

async function login(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: { origin: webOrigin },
    payload: { email: "lucas@example.com", password: "correct-secret" }
  });
  assert.equal(response.statusCode, 200);
  return String(response.headers["set-cookie"]).split(";", 1)[0]!;
}

test("lista vazia, cria casa/perfil com PIN e nunca expõe hash ou household", async () => {
  const dependencies = fixture();
  const app = await buildApp(environment, dependencies);
  const cookie = await login(app);

  const empty = await app.inject({ method: "GET", url: "/v1/profiles", headers: { cookie } });
  assert.deepEqual(JSON.parse(empty.body), { profiles: [] });

  const created = await app.inject({
    method: "POST",
    url: "/v1/profiles",
    headers: { cookie, origin: webOrigin },
    payload: { name: "Lucas", pin: "1234" }
  });
  assert.equal(created.statusCode, 201);
  const body = JSON.parse(created.body);
  assert.equal(body.name, "Lucas");
  assert.equal(body.hasPin, true);
  assert.equal("pinHash" in body, false);
  assert.equal("householdId" in body, false);

  const listed = await app.inject({ method: "GET", url: "/v1/profiles", headers: { cookie } });
  assert.equal(JSON.parse(listed.body).profiles.length, 1);
  assert.doesNotMatch(listed.body, /argon2|householdId/);

  await app.close();
});

test("PIN incorreto é neutro e perfil só fica ativo depois da verificação", async () => {
  const dependencies = fixture();
  const app = await buildApp(environment, dependencies);
  const cookie = await login(app);
  const created = await app.inject({
    method: "POST",
    url: "/v1/profiles",
    headers: { cookie, origin: webOrigin },
    payload: { name: "Protegido", pin: "1234" }
  });
  const profileId = JSON.parse(created.body).id as string;

  const denied = await app.inject({
    method: "POST",
    url: `/v1/profiles/${profileId}/activate`,
    headers: { cookie, origin: webOrigin },
    payload: { pin: "9999" }
  });
  assert.equal(denied.statusCode, 403);
  assert.doesNotMatch(denied.body, /9999|Argon|hash/i);

  const token = cookie.split("=", 2)[1]!;
  assert.equal((await dependencies.authProvider.verifySession(token)).activeProfileId, null);

  const accepted = await app.inject({
    method: "POST",
    url: `/v1/profiles/${profileId}/activate`,
    headers: { cookie, origin: webOrigin },
    payload: { pin: "1234" }
  });
  assert.equal(accepted.statusCode, 204);
  assert.equal((await dependencies.authProvider.verifySession(token)).activeProfileId, profileId);

  await app.close();
});

test("ID de perfil de outra casa não pode ser ativado e mutações exigem origem", async () => {
  const dependencies = fixture();
  const otherHouse = await dependencies.householdService.createHousehold({
    ownerId: "b7ffab62-678e-488e-aa80-ab1d7a5ddc6a",
    name: "Outra casa"
  });
  const otherProfile = await dependencies.householdService.createProfile({
    householdId: otherHouse.id,
    name: "Intruso"
  });
  const app = await buildApp(environment, dependencies);
  const cookie = await login(app);

  const crossHouse = await app.inject({
    method: "POST",
    url: `/v1/profiles/${otherProfile.id}/activate`,
    headers: { cookie, origin: webOrigin },
    payload: {}
  });
  assert.equal(crossHouse.statusCode, 404);

  const foreignOrigin = await app.inject({
    method: "POST",
    url: "/v1/profiles",
    headers: { cookie, origin: "https://attacker.example" },
    payload: { name: "Não criar" }
  });
  assert.equal(foreignOrigin.statusCode, 403);

  await app.close();
});

test("permite editar nome, avatar e pin do perfil, e permite deletar perfil", async () => {
  const dependencies = fixture();
  const app = await buildApp(environment, dependencies);
  const cookie = await login(app);

  const created = await app.inject({
    method: "POST",
    url: "/v1/profiles",
    headers: { cookie, origin: webOrigin },
    payload: { name: "Original", avatarUrl: "preset:popcorn" }
  });
  assert.equal(created.statusCode, 201);
  const profileId = JSON.parse(created.body).id as string;

  // Atualizar nome e avatar
  const updated = await app.inject({
    method: "PATCH",
    url: `/v1/profiles/${profileId}`,
    headers: { cookie, origin: webOrigin },
    payload: { name: "Nome Atualizado", avatarUrl: "preset:rocket", pin: "1234" }
  });
  assert.equal(updated.statusCode, 200);
  const updatedBody = JSON.parse(updated.body);
  assert.equal(updatedBody.name, "Nome Atualizado");
  assert.equal(updatedBody.avatarUrl, "preset:rocket");
  assert.equal(updatedBody.hasPin, true);

  // Remover PIN
  const removedPin = await app.inject({
    method: "PATCH",
    url: `/v1/profiles/${profileId}`,
    headers: { cookie, origin: webOrigin },
    payload: { pin: null }
  });
  assert.equal(removedPin.statusCode, 200);
  assert.equal(JSON.parse(removedPin.body).hasPin, false);

  // Deletar perfil
  const deleted = await app.inject({
    method: "DELETE",
    url: `/v1/profiles/${profileId}`,
    headers: { cookie, origin: webOrigin }
  });
  assert.equal(deleted.statusCode, 204);

  // Verificar que não existe mais
  const listed = await app.inject({ method: "GET", url: "/v1/profiles", headers: { cookie } });
  assert.deepEqual(JSON.parse(listed.body), { profiles: [] });

  await app.close();
});
