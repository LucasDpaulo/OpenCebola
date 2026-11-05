import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { InMemoryAuthProvider } from "../src/auth/index.js";

const webOrigin = "http://localhost:3000";
const environment = {
  NODE_ENV: "test" as const,
  CEBOLA_API_HOST: "127.0.0.1",
  CEBOLA_API_PORT: 3001,
  CEBOLA_WEB_ORIGIN: webOrigin,
  CEBOLA_SESSION_TTL_SECONDS: 3_600
};

function provider() {
  return new InMemoryAuthProvider({
    users: [{ id: "user-1", email: "lucas@example.com", password: "correct-secret" }],
    sessionTtlMs: 60_000,
    tokenFactory: () => "opaque-cebola-session"
  });
}

test("a mesma sessão autentica por Bearer e por cookie", async () => {
  const app = await buildApp(environment, { authProvider: provider() });
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: { origin: webOrigin },
    payload: { email: "lucas@example.com", password: "correct-secret" }
  });
  assert.equal(login.statusCode, 200);

  const porBearer = await app.inject({
    method: "GET",
    url: "/v1/auth/session",
    headers: { authorization: "Bearer opaque-cebola-session" }
  });
  assert.equal(porBearer.statusCode, 200);
  assert.equal(JSON.parse(porBearer.body).user.email, "lucas@example.com");

  const porCookie = await app.inject({
    method: "GET",
    url: "/v1/auth/session",
    headers: { cookie: "__Host-cebola_session=opaque-cebola-session" }
  });
  assert.equal(porCookie.statusCode, 200);

  await app.close();
});

test("Bearer inválido é 401, e não cai para o cookie válido", async () => {
  const app = await buildApp(environment, { authProvider: provider() });
  await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: { origin: webOrigin },
    payload: { email: "lucas@example.com", password: "correct-secret" }
  });

  const resposta = await app.inject({
    method: "GET",
    url: "/v1/auth/session",
    headers: {
      authorization: "Bearer nao-existe",
      cookie: "__Host-cebola_session=opaque-cebola-session"
    }
  });
  assert.equal(resposta.statusCode, 401);

  await app.close();
});
