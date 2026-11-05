import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTHENTICATION_ERROR_MESSAGE,
  AuthenticationError,
  InMemoryAuthProvider,
  type Clock
} from "../src/auth/index.js";

class MutableClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

function makeProvider(clock = new MutableClock(new Date("2026-08-18T12:00:00.000Z"))) {
  return {
    clock,
    provider: new InMemoryAuthProvider({
      clock,
      sessionTtlMs: 60_000,
      tokenFactory: () => "test-token-123",
      users: [{ id: "user-1", email: "lucas@example.com", password: "correct-secret" }]
    })
  };
}

async function captureAuthenticationError(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof AuthenticationError);
    return error;
  }
  assert.fail("Era esperado um erro de autenticação.");
}

test("login válido cria uma sessão verificável sem devolver a senha", async () => {
  const { provider } = makeProvider();

  const result = await provider.signInWithPassword({
    email: "  LUCAS@example.com ",
    password: "correct-secret"
  });

  assert.equal(result.sessionToken, "test-token-123");
  assert.equal(result.session.user.id, "user-1");
  assert.equal(result.session.user.email, "lucas@example.com");
  assert.equal(result.session.activeProfileId, null);
  assert.equal("password" in result.session.user, false);
  assert.deepEqual(await provider.verifySession(result.sessionToken), result.session);
});

test("e-mail inexistente e senha incorreta devolvem exatamente o mesmo erro neutro", async () => {
  const { provider } = makeProvider();

  const unknownEmailError = await captureAuthenticationError(() =>
    provider.signInWithPassword({ email: "unknown@example.com", password: "anything" })
  );
  const wrongPasswordError = await captureAuthenticationError(() =>
    provider.signInWithPassword({ email: "lucas@example.com", password: "wrong" })
  );

  assert.equal(unknownEmailError.message, AUTHENTICATION_ERROR_MESSAGE);
  assert.equal(wrongPasswordError.message, AUTHENTICATION_ERROR_MESSAGE);
  assert.equal(unknownEmailError.message, wrongPasswordError.message);
});

test("sessão expirada deixa de ser aceita", async () => {
  const { provider, clock } = makeProvider();
  const result = await provider.signInWithPassword({
    email: "lucas@example.com",
    password: "correct-secret"
  });

  clock.advance(60_000);

  const error = await captureAuthenticationError(() =>
    provider.verifySession(result.sessionToken)
  );
  assert.equal(error.message, AUTHENTICATION_ERROR_MESSAGE);
});

test("revogação é imediata e idempotente", async () => {
  const { provider } = makeProvider();
  const result = await provider.signInWithPassword({
    email: "lucas@example.com",
    password: "correct-secret"
  });

  await provider.revokeSession(result.sessionToken);
  await provider.revokeSession(result.sessionToken);

  const error = await captureAuthenticationError(() =>
    provider.verifySession(result.sessionToken)
  );
  assert.equal(error.message, AUTHENTICATION_ERROR_MESSAGE);
});

test("perfil ativo pode ser atualizado e limpo enquanto a sessão está válida", async () => {
  const { provider } = makeProvider();
  const result = await provider.signInWithPassword({
    email: "lucas@example.com",
    password: "correct-secret"
  });

  const selected = await provider.setActiveProfile(result.sessionToken, "profile-1");
  assert.equal(selected.activeProfileId, "profile-1");
  assert.equal(
    (await provider.verifySession(result.sessionToken)).activeProfileId,
    "profile-1"
  );

  const cleared = await provider.setActiveProfile(result.sessionToken, null);
  assert.equal(cleared.activeProfileId, null);

  await provider.revokeSession(result.sessionToken);
  await captureAuthenticationError(() =>
    provider.setActiveProfile(result.sessionToken, "profile-2")
  );
});
