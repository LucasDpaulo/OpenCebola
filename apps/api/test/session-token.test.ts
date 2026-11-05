import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyRequest } from "fastify";
import { readRequestSessionToken } from "../src/auth/session-token.js";

function pedido(headers: Record<string, string>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

test("Bearer vira credencial com origem própria", () => {
  const lido = readRequestSessionToken(pedido({ authorization: "Bearer abc-123_XYZ.~" }));
  assert.deepEqual(lido, { token: "abc-123_XYZ.~", source: "bearer" });
});

test("sem Authorization, o cookie continua valendo", () => {
  const lido = readRequestSessionToken(pedido({ cookie: "__Host-cebola_session=do-cookie" }));
  assert.deepEqual(lido, { token: "do-cookie", source: "cookie" });
});

// Quem mandou Authorization quis autenticar por token. Cair para o cookie faria um app com
// token vencido ser tratado como navegador — e passar pelas defesas que existem só para ele.
test("Authorization malformado NÃO cai para o cookie", () => {
  for (const valor of ["Bearer", "Bearer ", "Basic abc", "Bearer tem espaço", "Bearer com/barra"]) {
    assert.equal(
      readRequestSessionToken(pedido({ authorization: valor, cookie: "__Host-cebola_session=do-cookie" })),
      null,
      valor
    );
  }
});

test("sem credencial nenhuma devolve null", () => {
  assert.equal(readRequestSessionToken(pedido({})), null);
});

test("token acima do teto é recusado", () => {
  assert.equal(readRequestSessionToken(pedido({ authorization: `Bearer ${"a".repeat(4_097)}` })), null);
});
