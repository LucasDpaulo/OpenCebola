import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import {
  InMemoryAuthProvider,
  type AuthProvider,
  type AuthResult,
  type AuthSession,
  type PasswordCredentials
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
    sessionTtlMs: 60_000
  });
}

async function comSessao(app: Awaited<ReturnType<typeof buildApp>>) {
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/device/login",
    payload: { email: "lucas@example.com", password: "correct-secret" }
  });
  return JSON.parse(login.body).token as string;
}

/** Quem aprova é sempre alguém no navegador; por isso os testes de aprovação usam cookie. */
async function comCookie(app: Awaited<ReturnType<typeof buildApp>>) {
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: { origin: webOrigin },
    payload: { email: "lucas@example.com", password: "correct-secret" }
  });
  return String(login.headers["set-cookie"]).split(";", 1)[0]!;
}

test("a TV pede código, o celular aprova, a TV recebe a sessão", async () => {
  const app = await buildApp(environment, { authProvider: provider() });

  const pedido = await app.inject({ method: "POST", url: "/v1/auth/device/code" });
  assert.equal(pedido.statusCode, 200);
  const { code, deviceId } = JSON.parse(pedido.body);
  assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);

  const antes = await app.inject({
    method: "POST", url: "/v1/auth/device/claim", payload: { code, deviceId }
  });
  assert.equal(antes.statusCode, 202);

  const cookie = await comCookie(app);
  const aprovacao = await app.inject({
    method: "POST",
    url: "/v1/auth/device/approve",
    headers: { cookie, origin: webOrigin },
    payload: { code }
  });
  assert.equal(aprovacao.statusCode, 204);

  const depois = await app.inject({
    method: "POST", url: "/v1/auth/device/claim", payload: { code, deviceId }
  });
  assert.equal(depois.statusCode, 200);
  const corpo = JSON.parse(depois.body);
  assert.equal(corpo.session.user.email, "lucas@example.com");

  const sessao = await app.inject({
    method: "GET",
    url: "/v1/auth/session",
    headers: { authorization: `Bearer ${corpo.token}` }
  });
  assert.equal(sessao.statusCode, 200);

  await app.close();
});

test("aprovar exige estar autenticado", async () => {
  const app = await buildApp(environment, { authProvider: provider() });
  const { code } = JSON.parse((await app.inject({ method: "POST", url: "/v1/auth/device/code" })).body);
  // Origin correta e nenhuma credencial: isola o que este teste quer provar (falta de sessão)
  // da checagem de Origin, que tem teste próprio logo abaixo.
  const resposta = await app.inject({
    method: "POST",
    url: "/v1/auth/device/approve",
    headers: { origin: webOrigin },
    payload: { code }
  });
  assert.equal(resposta.statusCode, 401);
  await app.close();
});

// Rodada de correção 1: a rota é autenticada, muda estado e é alcançável por cookie — sem checar
// Origin, uma página maliciosa faria o navegador da vítima aprovar o código do ATACANTE.
test("aprovar por cookie sem Origin é recusado", async () => {
  const app = await buildApp(environment, { authProvider: provider() });
  const { code } = JSON.parse((await app.inject({ method: "POST", url: "/v1/auth/device/code" })).body);

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: { origin: webOrigin },
    payload: { email: "lucas@example.com", password: "correct-secret" }
  });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];

  const resposta = await app.inject({
    method: "POST",
    url: "/v1/auth/device/approve",
    headers: { cookie },
    payload: { code }
  });
  assert.equal(resposta.statusCode, 403);
  assert.match(resposta.body, /UNTRUSTED_ORIGIN/);
  await app.close();
});

// Quem lê o código na tela da TV não pode virar dono da sessão.
test("reivindicar com deviceId errado não entrega sessão", async () => {
  const app = await buildApp(environment, { authProvider: provider() });
  const { code } = JSON.parse((await app.inject({ method: "POST", url: "/v1/auth/device/code" })).body);
  const cookie = await comCookie(app);
  await app.inject({
    method: "POST",
    url: "/v1/auth/device/approve",
    headers: { cookie, origin: webOrigin },
    payload: { code }
  });

  // Precisa ter o formato plausível de um deviceId real (>=16 caracteres) para chegar até a
  // comparação em `claim`; um palpite curto demais já cairia em 400 por não passar no schema,
  // o que mascararia o que este teste quer provar.
  const resposta = await app.inject({
    method: "POST",
    url: "/v1/auth/device/claim",
    payload: { code, deviceId: "chutado-chutado-chutado-chutado" }
  });
  assert.equal(resposta.statusCode, 404);
  await app.close();
});

// A falha que fechava a cadeia de renovação: com Bearer aceito no approve, uma sessão roubada
// pedia código, aprovava com o próprio token, reivindicava um token novo — e recomeçava, para
// sempre, sem nunca ver a senha e sem deixar rastro para revogar.
test("aprovar por Bearer é recusado: uma sessão não fabrica outra sessão", async () => {
  const app = await buildApp(environment, { authProvider: provider() });
  const { code, deviceId } = JSON.parse(
    (await app.inject({ method: "POST", url: "/v1/auth/device/code" })).body
  );
  const token = await comSessao(app);

  const resposta = await app.inject({
    method: "POST",
    url: "/v1/auth/device/approve",
    headers: { authorization: `Bearer ${token}` },
    payload: { code }
  });
  assert.equal(resposta.statusCode, 403);
  assert.match(resposta.body, /PAIRING_REQUIRES_BROWSER/);

  // 202 com o deviceId certo: o código continua "ainda não aprovado". Consultar com deviceId
  // errado daria 404 de qualquer jeito, e o teste passaria pelo motivo errado.
  const consulta = await app.inject({
    method: "POST",
    url: "/v1/auth/device/claim",
    payload: { code, deviceId }
  });
  assert.equal(consulta.statusCode, 202);

  await app.close();
});

// Sem esta rota o aparelho nativo não tinha como se desligar: /v1/auth/logout exige Origin
// sempre, e um cliente Bearer não tem Origin nenhuma para oferecer.
test("aparelho nativo revoga a própria sessão por Bearer, sem Origin", async () => {
  const app = await buildApp(environment, { authProvider: provider() });
  const token = await comSessao(app);

  const antes = await app.inject({
    method: "GET",
    url: "/v1/auth/session",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(antes.statusCode, 200);

  const saida = await app.inject({
    method: "POST",
    url: "/v1/auth/device/logout",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(saida.statusCode, 204);
  // Não emite cookie: o cliente nativo não tem nenhum para apagar.
  assert.equal(saida.headers["set-cookie"], undefined);

  const depois = await app.inject({
    method: "GET",
    url: "/v1/auth/session",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(depois.statusCode, 401);

  await app.close();
});

test("device/logout sem credencial nenhuma é 401, e por cookie ainda exige Origin", async () => {
  const app = await buildApp(environment, { authProvider: provider() });

  const semCredencial = await app.inject({ method: "POST", url: "/v1/auth/device/logout" });
  assert.equal(semCredencial.statusCode, 401);

  const cookie = await comCookie(app);
  const porCookie = await app.inject({
    method: "POST",
    url: "/v1/auth/device/logout",
    headers: { cookie }
  });
  assert.equal(porCookie.statusCode, 403);
  assert.match(porCookie.body, /UNTRUSTED_ORIGIN/);

  await app.close();
});

/**
 * Emite a sessão certa em toda chamada, menos na primeira: é o Supabase piscando no pior
 * instante possível, logo depois de o bilhete ter sido consumido.
 */
class FalhaNaPrimeiraEmissao implements AuthProvider {
  #jaFalhou = false;

  constructor(private readonly interno: InMemoryAuthProvider) {}

  signInWithPassword(credenciais: PasswordCredentials): Promise<AuthResult> {
    return this.interno.signInWithPassword(credenciais);
  }

  async issueSessionForUser(userId: string): Promise<AuthResult> {
    if (!this.#jaFalhou) {
      this.#jaFalhou = true;
      throw new Error("supabase indisponível");
    }
    return this.interno.issueSessionForUser(userId);
  }

  verifySession(token: string): Promise<AuthSession> {
    return this.interno.verifySession(token);
  }

  setActiveProfile(token: string, profileId: string | null): Promise<AuthSession> {
    return this.interno.setActiveProfile(token, profileId);
  }

  revokeSession(token: string): Promise<void> {
    return this.interno.revokeSession(token);
  }
}

test("emissão que falha não destrói o bilhete: a consulta seguinte ainda funciona", async () => {
  const app = await buildApp(environment, {
    authProvider: new FalhaNaPrimeiraEmissao(provider())
  });
  const { code, deviceId } = JSON.parse(
    (await app.inject({ method: "POST", url: "/v1/auth/device/code" })).body
  );
  const cookie = await comCookie(app);
  await app.inject({
    method: "POST",
    url: "/v1/auth/device/approve",
    headers: { cookie, origin: webOrigin },
    payload: { code }
  });

  const falha = await app.inject({
    method: "POST", url: "/v1/auth/device/claim", payload: { code, deviceId }
  });
  // 503 neutro, e não 500 com a mensagem interna do erro: a rota é pública.
  assert.equal(falha.statusCode, 503);
  assert.match(falha.body, /PAIRING_UNAVAILABLE/);
  assert.doesNotMatch(falha.body, /supabase indisponível/);

  // O laço da TV consulta de novo em segundos. Antes, aqui vinha 404 num código que a pessoa
  // acabou de ver aprovar — o bilhete tinha sido queimado pela tentativa que falhou.
  const sucesso = await app.inject({
    method: "POST", url: "/v1/auth/device/claim", payload: { code, deviceId }
  });
  assert.equal(sucesso.statusCode, 200);
  assert.equal(JSON.parse(sucesso.body).session.user.email, "lucas@example.com");

  await app.close();
});

// Faltava o teste pela rota: o comportamento estava coberto só na loja em memória.
test("código desconhecido e código expirado respondem 404 iguais pela rota", async () => {
  let agora = new Date("2026-08-24T12:00:00.000Z");
  const app = await buildApp(environment, { authProvider: provider(), now: () => agora });

  const desconhecido = await app.inject({
    method: "POST",
    url: "/v1/auth/device/claim",
    payload: { code: "ZZZZZZ", deviceId: "nunca-existiu-nunca-existiu" }
  });
  assert.equal(desconhecido.statusCode, 404);

  const { code, deviceId } = JSON.parse(
    (await app.inject({ method: "POST", url: "/v1/auth/device/code" })).body
  );
  agora = new Date(agora.getTime() + 11 * 60_000);
  const expirado = await app.inject({
    method: "POST", url: "/v1/auth/device/claim", payload: { code, deviceId }
  });
  assert.equal(expirado.statusCode, 404);

  // Idênticos de propósito: a resposta não confirma que um código específico já existiu.
  assert.equal(expirado.body, desconhecido.body);

  await app.close();
});
