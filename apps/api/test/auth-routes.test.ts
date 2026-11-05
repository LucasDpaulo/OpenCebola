import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import {
  InMemoryAuthProvider,
  SESSION_COOKIE_NAME
} from "../src/auth/index.js";

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

test("login emite cookie opaco e sessão pode ser consultada sem expor IDs ou token", async () => {
  const app = await buildApp(environment, { authProvider: provider() });
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: { origin: webOrigin },
    payload: { email: "lucas@example.com", password: "correct-secret" }
  });

  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers["set-cookie"]);
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE_NAME}=opaque-cebola-session;`));
  assert.match(cookie, /HttpOnly/);
  assert.doesNotMatch(login.body, /opaque-cebola-session|user-1|correct-secret/);

  const session = await app.inject({
    method: "GET",
    url: "/v1/auth/session",
    headers: { cookie: cookie.split(";", 1)[0] }
  });
  assert.equal(session.statusCode, 200);
  assert.equal(JSON.parse(session.body).user.email, "lucas@example.com");

  await app.close();
});

test("credenciais desconhecidas e incorretas têm resposta HTTP idêntica", async () => {
  const app = await buildApp(environment, { authProvider: provider() });
  const attempt = (email: string, password: string) => app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: { origin: webOrigin },
    payload: { email, password }
  });

  const unknown = await attempt("nobody@example.com", "wrong");
  const incorrect = await attempt("lucas@example.com", "wrong");
  assert.equal(unknown.statusCode, 401);
  assert.equal(incorrect.statusCode, 401);
  assert.equal(unknown.body, incorrect.body);

  await app.close();
});

test("mutações rejeitam outra origem e logout revoga a sessão", async () => {
  const authProvider = provider();
  const app = await buildApp(environment, { authProvider });
  const blocked = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: { origin: "https://attacker.example" },
    payload: { email: "lucas@example.com", password: "correct-secret" }
  });
  assert.equal(blocked.statusCode, 403);

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: { origin: webOrigin },
    payload: { email: "lucas@example.com", password: "correct-secret" }
  });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
  const logout = await app.inject({
    method: "POST",
    url: "/v1/auth/logout",
    headers: { origin: webOrigin, cookie }
  });
  assert.equal(logout.statusCode, 204);
  assert.match(String(logout.headers["set-cookie"]), /Max-Age=0/);

  const session = await app.inject({
    method: "GET",
    url: "/v1/auth/session",
    headers: { cookie }
  });
  assert.equal(session.statusCode, 401);

  await app.close();
});

// As duas rotas trocam a MESMA senha da MESMA conta. Em baldes separados de 10/min cada, o
// orçamento de força bruta por IP virava 20/min — o dobro do que existia antes de a rota de
// aparelho aparecer, e ela ainda dispensa Origin, o que faz dela a porta mais confortável.
test("as duas portas de senha dividem o mesmo balde de tentativas", async () => {
  const app = await buildApp(environment, { authProvider: provider() });
  const pelaWeb = () => app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: { origin: webOrigin },
    payload: { email: "lucas@example.com", password: "errada" }
  });
  const peloAparelho = () => app.inject({
    method: "POST",
    url: "/v1/auth/device/login",
    payload: { email: "lucas@example.com", password: "errada" }
  });

  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    assert.equal((await pelaWeb()).statusCode, 401);
  }
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    assert.equal((await peloAparelho()).statusCode, 401);
  }

  // Décima primeira tentativa: recusada nas duas portas, porque a contagem é uma só.
  const estouradaNoAparelho = await peloAparelho();
  assert.equal(estouradaNoAparelho.statusCode, 429);
  assert.match(estouradaNoAparelho.body, /RATE_LIMIT_EXCEEDED/);
  assert.equal((await pelaWeb()).statusCode, 429);

  await app.close();
});
