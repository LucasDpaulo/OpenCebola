import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAuthProvider, isAuthenticationError } from "../src/auth/index.js";

function provider() {
  return new InMemoryAuthProvider({
    users: [{ id: "user-1", email: "lucas@example.com", password: "correct-secret" }],
    sessionTtlMs: 60_000
  });
}

// O pareamento aprova uma pessoa que JÁ está autenticada noutro aparelho; pedir a senha de novo
// derrotaria o motivo de existir do fluxo.
test("emite sessão válida a partir do id do usuário, sem senha", async () => {
  const auth = provider();
  const resultado = await auth.issueSessionForUser("user-1");

  assert.ok(resultado.sessionToken.length > 0);
  assert.equal(resultado.session.user.email, "lucas@example.com");
  const verificada = await auth.verifySession(resultado.sessionToken);
  assert.equal(verificada.user.email, "lucas@example.com");
});

test("usuário inexistente não emite sessão", async () => {
  await assert.rejects(() => provider().issueSessionForUser("nao-existe"), isAuthenticationError);
});
