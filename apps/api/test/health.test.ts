import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";

const environment = {
  NODE_ENV: "test" as const,
  CEBOLA_API_HOST: "127.0.0.1",
  CEBOLA_API_PORT: 3001,
  CEBOLA_WEB_ORIGIN: "http://localhost:3000",
  CEBOLA_SESSION_TTL_SECONDS: 3_600
};

test("GET /v1/health responde sem cache", async () => {
  const app = await buildApp(environment);

  const response = await app.inject({ method: "GET", url: "/v1/health" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(response.body).status, "ok");

  await app.close();
});

test("GET /v1/health tem rate limit próprio em vez de isenção", async () => {
  const app = await buildApp(environment);

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await app.inject({ method: "GET", url: "/v1/health" });
    assert.equal(response.statusCode, 200);
  }

  const blocked = await app.inject({ method: "GET", url: "/v1/health" });
  assert.equal(blocked.statusCode, 429);

  await app.close();
});

// Cookie ainda não foi autenticado no onRequest. Se ele criasse um balde novo, um atacante
// poderia trocar um token falso por request e contornar inclusive o limite da rota de login.
test("cookie de sessão falso não contorna o rate limit das rotas públicas", async () => {
  const app = await buildApp({ ...environment, CEBOLA_TRUST_PROXY: true });
  const sessao = (token: string) => ({ cookie: `__Host-cebola_session=${token}` });

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: sessao(`token-falso-${attempt}`)
    });
    assert.equal(response.statusCode, 200);
  }
  const bloqueada = await app.inject({
    method: "GET",
    url: "/v1/health",
    headers: sessao("mais-um-token-falso")
  });
  assert.equal(bloqueada.statusCode, 429);

  await app.close();
});
