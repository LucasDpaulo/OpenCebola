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

test("login de aparelho devolve o token no corpo e NÃO emite cookie", async () => {
  const app = await buildApp(environment, { authProvider: provider() });
  const resposta = await app.inject({
    method: "POST",
    url: "/v1/auth/device/login",
    payload: { email: "lucas@example.com", password: "correct-secret" }
  });

  assert.equal(resposta.statusCode, 200);
  const corpo = JSON.parse(resposta.body);
  assert.equal(corpo.token, "opaque-cebola-session");
  assert.equal(corpo.session.user.email, "lucas@example.com");
  // O app guarda o token por conta própria; cookie aqui só criaria uma segunda via de sessão.
  assert.equal(resposta.headers["set-cookie"], undefined);

  await app.close();
});

test("login de aparelho não exige Origin, mas recusa credencial errada", async () => {
  const app = await buildApp(environment, { authProvider: provider() });
  const resposta = await app.inject({
    method: "POST",
    url: "/v1/auth/device/login",
    payload: { email: "lucas@example.com", password: "errada" }
  });
  assert.equal(resposta.statusCode, 401);
  assert.doesNotMatch(resposta.body, /opaque-cebola-session/);
  await app.close();
});
