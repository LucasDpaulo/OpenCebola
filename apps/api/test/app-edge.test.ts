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

// Captura as linhas do logger num array, no lugar do stdout.
function logCapture() {
  const lines: string[] = [];
  return {
    lines,
    loggerOptions: {
      level: "info",
      stream: {
        write(line: string) {
          lines.push(line);
        }
      }
    }
  };
}

test("com trustProxy ligado o rate limit separa clientes pelo CF-Connecting-IP", async () => {
  const app = await buildApp({ ...environment, CEBOLA_TRUST_PROXY: true });
  const clientA = { "cf-connecting-ip": "203.0.113.10" };

  // Todos os injects saem do mesmo socket (o "Caddy"); só o header distingue.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await app.inject({ method: "GET", url: "/v1/health", headers: clientA });
    assert.equal(response.statusCode, 200);
  }

  const blocked = await app.inject({ method: "GET", url: "/v1/health", headers: clientA });
  assert.equal(blocked.statusCode, 429);

  // Forjar X-Forwarded-For não muda o balde: a chave vem do CF-Connecting-IP,
  // que o edge sobrescreve (aqui, mesmo cliente A tentando escapar).
  const spoofed = await app.inject({
    method: "GET",
    url: "/v1/health",
    headers: { ...clientA, "x-forwarded-for": "198.51.100.99" }
  });
  assert.equal(spoofed.statusCode, 429);

  // Outro cliente real segue atendido: um cliente não esgota o balde da casa.
  const clientB = await app.inject({
    method: "GET",
    url: "/v1/health",
    headers: { "cf-connecting-ip": "203.0.113.20" }
  });
  assert.equal(clientB.statusCode, 200);

  await app.close();
});

test("com trustProxy desligado a chave é o IP do socket e o header é ignorado", async () => {
  const app = await buildApp(environment);

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await app.inject({ method: "GET", url: "/v1/health" });
    assert.equal(response.statusCode, 200);
  }

  // Em dev não há proxy confiável: CF-Connecting-IP não abre um balde novo.
  const withHeader = await app.inject({
    method: "GET",
    url: "/v1/health",
    headers: { "cf-connecting-ip": "203.0.113.20" }
  });
  assert.equal(withHeader.statusCode, 429);

  await app.close();
});

test("log de request registra o padrão da rota, nunca o conteúdo assistido", async () => {
  const { lines, loggerOptions } = logCapture();
  const app = await buildApp(environment, { loggerOptions });

  // Rota com o mesmo formato das rotas de conteúdo do Stremio, registrada no
  // mesmo contexto raiz: exercita o hook de log com params e query string.
  app.get("/v1/stremio/meta/:addonId/:type/:mediaId", async () => ({ ok: true }));

  const response = await app.inject({
    method: "GET",
    url: "/v1/stremio/meta/org.exemplo/movie/tt4574334?extra=vazamento"
  });
  assert.equal(response.statusCode, 200);
  await app.close();

  const logged = lines.join("");
  assert.match(logged, /\/v1\/stremio\/meta\/:addonId\/:type\/:mediaId/);
  assert.match(logged, /"method":"GET"/);
  assert.match(logged, /"statusCode":200/);
  assert.match(logged, /"responseTime":/);
  assert.doesNotMatch(logged, /tt4574334/);
  assert.doesNotMatch(logged, /org\.exemplo/);
  assert.doesNotMatch(logged, /vazamento/);
});

test("404 não vaza a URL pedida e erro inesperado segue logado sem URL", async () => {
  const { lines, loggerOptions } = logCapture();
  const app = await buildApp(environment, { loggerOptions });
  app.get("/v1/explosao/:segredo", async () => {
    throw new Error("falha proposital");
  });

  const missing = await app.inject({ method: "GET", url: "/v1/stremio/streams/movie/tt0111161" });
  assert.equal(missing.statusCode, 404);

  const errored = await app.inject({ method: "GET", url: "/v1/explosao/tt0111161" });
  assert.equal(errored.statusCode, 500);
  await app.close();

  const logged = lines.join("");
  assert.doesNotMatch(logged, /tt0111161/);
  assert.match(logged, /rota não registrada/);
  assert.match(logged, /"statusCode":404/);
  // O log de erro continua existindo, agora com o padrão da rota.
  assert.match(logged, /falha proposital/);
  assert.match(logged, /\/v1\/explosao\/:segredo/);
  assert.match(logged, /"statusCode":500/);
});
