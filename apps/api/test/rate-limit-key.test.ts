import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { clientIpRateLimitKey, ipCeilingHook, sessionRateLimitKey } from "../src/rate-limit-key.js";

function pedido(headers: Record<string, string>) {
  return { headers, ip: "10.0.0.9" } as unknown as Parameters<typeof sessionRateLimitKey>[0];
}

test("a chave junta IP e sessão: mesma casa, pessoas diferentes, baldes diferentes", () => {
  const casa = { "cf-connecting-ip": "203.0.113.7" };
  const lucas = sessionRateLimitKey(pedido({ ...casa, cookie: "__Host-cebola_session=token-do-lucas" }));
  const outra = sessionRateLimitKey(pedido({ ...casa, cookie: "__Host-cebola_session=token-da-outra" }));

  assert.notEqual(lucas, outra);
  // Duas pessoas atrás do mesmo NAT não podem travar uma à outra — era o bug original.
  assert.ok(lucas.startsWith("203.0.113.7|"));
  assert.ok(outra.startsWith("203.0.113.7|"));
  // O token nunca aparece na chave: ela vive em memória e não deve carregar credencial.
  assert.ok(!lucas.includes("token-do-lucas"));
});

test("sem cookie, a chave é só o IP, e nunca a mesma de uma sessão real", () => {
  const semCookie = sessionRateLimitKey(pedido({ "cf-connecting-ip": "203.0.113.7" }));
  assert.equal(semCookie, "203.0.113.7");
  assert.equal(semCookie, clientIpRateLimitKey(pedido({ "cf-connecting-ip": "203.0.113.7" })));
});

test("o teto por IP barra cookies falsos, que criariam um balde novo a cada request", async () => {
  const app = Fastify();
  await app.register(rateLimit, { global: true, max: 1_000, timeWindow: "1 minute", hook: "onRequest" });
  app.get("/caro", {
    onRequest: ipCeilingHook(app, { max: 3, timeWindow: "5 minutes" }),
    config: { rateLimit: { max: 1_000, timeWindow: "5 minutes", keyGenerator: sessionRateLimitKey } }
  }, async () => ({ ok: true }));

  // Cada request traz um token diferente: o limite por sessão sozinho daria balde novo em todas.
  const codigos: number[] = [];
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/caro",
      headers: { cookie: `__Host-cebola_session=falso-${tentativa}` }
    });
    codigos.push(response.statusCode);
  }

  assert.deepEqual(codigos, [200, 200, 200, 429, 429]);
  await app.close();
});
