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

const SEGREDO = "coluna household_secrets nao existe; senha=hunter2";

test("exceção não tratada não devolve a mensagem interna", async () => {
  const app = await buildApp(environment);
  app.get("/__boom", async () => { throw new Error(SEGREDO); });
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/__boom" });

  assert.equal(response.statusCode, 500);
  // O corpo INTEIRO não pode conter a mensagem — não basta trocar de campo.
  assert.equal(response.body.includes(SEGREDO), false, response.body);
  assert.equal(response.body.includes("hunter2"), false, response.body);
  assert.deepEqual(JSON.parse(response.body), {
    error: { code: "INTERNAL_ERROR", message: "Erro interno." }
  });

  await app.close();
});

// Um erro com statusCode próprio é deliberado: alguém escolheu aquele status e aquele texto.
// O tratador global existe para o que NINGUÉM tratou, e passar por cima disso apagaria a
// explicação que o cliente precisa (o "tente de novo em 1 minuto" do rate limit, por exemplo).
test("erro deliberado abaixo de 500 continua com status e texto próprios", async () => {
  const app = await buildApp(environment);

  for (let attempt = 0; attempt < 31; attempt += 1) {
    await app.inject({ method: "GET", url: "/v1/health" });
  }
  const limited = await app.inject({ method: "GET", url: "/v1/health" });

  assert.equal(limited.statusCode, 429);
  const body = JSON.parse(limited.body) as { message?: unknown };
  assert.equal(typeof body.message, "string");
  assert.match(String(body.message), /rate limit/i);

  await app.close();
});

test("rota inexistente continua respondendo 404, e não 500", async () => {
  const app = await buildApp(environment);

  const response = await app.inject({ method: "GET", url: "/__nao_existe" });

  assert.equal(response.statusCode, 404);

  await app.close();
});
