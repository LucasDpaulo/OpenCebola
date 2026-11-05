import assert from "node:assert/strict";
import test from "node:test";
import { AuthenticationError } from "../src/auth/errors.js";
import {
  type CreateOpaqueSession,
  type OpaqueSessionRecord,
  type SessionRepository
} from "../src/auth/session-repository.js";
import {
  SupabaseAuthProvider,
  hashOpaqueSessionToken
} from "../src/auth/supabase-auth-provider.js";
import {
  SUPABASE_STATELESS_AUTH_OPTIONS,
  type ExternalAuthenticatedUser,
  type SupabaseAuthGateway
} from "../src/auth/supabase-server-auth-gateway.js";
import type {
  AuthUser,
  Clock,
  PasswordCredentials
} from "../src/auth/types.js";

class MutableClock implements Clock {
  constructor(private current: Date) {}
  now(): Date { return new Date(this.current); }
  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

class FakeGateway implements SupabaseAuthGateway {
  readonly user: AuthUser = Object.freeze({
    id: "9eb62413-f500-4cc7-a628-a0f29153f3f8",
    email: "lucas@example.com"
  });
  enabled = true;
  lastCredentials: PasswordCredentials | null = null;

  async authenticate(credentials: PasswordCredentials): Promise<ExternalAuthenticatedUser> {
    this.lastCredentials = credentials;
    if (credentials.password !== "correct-secret") {
      throw new AuthenticationError();
    }
    return { user: this.user };
  }

  async findUserById(userId: string): Promise<AuthUser | null> {
    return this.enabled && userId === this.user.id ? this.user : null;
  }
}

class FakeSessionRepository implements SessionRepository {
  readonly records = new Map<string, OpaqueSessionRecord>();

  async create(session: CreateOpaqueSession): Promise<void> {
    this.records.set(session.tokenHash, {
      ...session,
      revokedAt: null
    });
  }

  async findByTokenHash(tokenHash: string): Promise<OpaqueSessionRecord | null> {
    return this.records.get(tokenHash) ?? null;
  }

  async setActiveProfile(
    tokenHash: string,
    profileId: string | null,
    now: Date
  ): Promise<OpaqueSessionRecord | null> {
    const record = this.records.get(tokenHash);
    if (!record || record.revokedAt || record.expiresAt.getTime() <= now.getTime()) {
      return null;
    }
    const updated = { ...record, activeProfileId: profileId };
    this.records.set(tokenHash, updated);
    return updated;
  }

  async renew(tokenHash: string, newExpiresAt: Date, now: Date): Promise<void> {
    const record = this.records.get(tokenHash);
    if (record && !record.revokedAt && record.expiresAt.getTime() > now.getTime()) {
      this.records.set(tokenHash, { ...record, expiresAt: newExpiresAt });
    }
  }

  async revokeByTokenHash(tokenHash: string, revokedAt: Date): Promise<void> {
    const record = this.records.get(tokenHash);
    if (record && !record.revokedAt) {
      this.records.set(tokenHash, {
        ...record,
        activeProfileId: null,
        revokedAt
      });
    }
  }
}

function fixture() {
  const gateway = new FakeGateway();
  const sessions = new FakeSessionRepository();
  const clock = new MutableClock(new Date("2026-08-18T15:00:00.000Z"));
  const provider = new SupabaseAuthProvider({
    gateway,
    sessions,
    clock,
    sessionTtlMs: 60_000,
    tokenFactory: () => "opaque-cebola-token"
  });
  return { provider, gateway, sessions, clock };
}

async function expectAuthenticationFailure(action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof AuthenticationError);
}

test("login troca a identidade externa por token Cebola e persiste somente SHA-256", async () => {
  const { provider, sessions } = fixture();
  const result = await provider.signInWithPassword({
    email: "lucas@example.com",
    password: "correct-secret"
  });

  assert.equal(result.sessionToken, "opaque-cebola-token");
  assert.equal(result.session.activeProfileId, null);
  const expectedHash = hashOpaqueSessionToken(result.sessionToken);
  assert.match(expectedHash, /^[0-9a-f]{64}$/);
  assert.equal(sessions.records.has(expectedHash), true);
  assert.equal(sessions.records.has(result.sessionToken), false);
  assert.equal(JSON.stringify([...sessions.records.values()]).includes("correct-secret"), false);
});

test("verificação resolve usuário sem precisar persistir e-mail ou token Supabase", async () => {
  const { provider, sessions } = fixture();
  const login = await provider.signInWithPassword({
    email: "lucas@example.com",
    password: "correct-secret"
  });
  const record = sessions.records.get(hashOpaqueSessionToken(login.sessionToken));

  assert.ok(record);
  assert.deepEqual(Object.keys(record).sort(), [
    "activeProfileId", "expiresAt", "revokedAt", "tokenHash", "userId"
  ]);
  const verified = await provider.verifySession(login.sessionToken);
  assert.equal(verified.user.email, "lucas@example.com");
});

test("expiração e remoção do usuário invalidam a sessão com erro neutro", async () => {
  const expired = fixture();
  const first = await expired.provider.signInWithPassword({
    email: "lucas@example.com", password: "correct-secret"
  });
  expired.clock.advance(60_000);
  await expectAuthenticationFailure(() =>
    expired.provider.verifySession(first.sessionToken)
  );

  const deleted = fixture();
  const second = await deleted.provider.signInWithPassword({
    email: "lucas@example.com", password: "correct-secret"
  });
  deleted.gateway.enabled = false;
  await expectAuthenticationFailure(() =>
    deleted.provider.verifySession(second.sessionToken)
  );
  const stored = deleted.sessions.records.get(hashOpaqueSessionToken(second.sessionToken));
  assert.ok(stored?.revokedAt);
});

test("sessão desliza: usar dentro da janela estende a validade e evita relogar", async () => {
  const { provider, sessions, clock } = fixture();
  const login = await provider.signInWithPassword({
    email: "lucas@example.com", password: "correct-secret"
  });
  const hash = hashOpaqueSessionToken(login.sessionToken);
  const baseExpiry = login.session.expiresAt.getTime(); // login + 60s (TTL da fixture)

  // Antes da metade do TTL (restando > 30s) não há renovação: escrita no banco fica rara.
  clock.advance(20_000);
  await provider.verifySession(login.sessionToken);
  assert.equal(
    sessions.records.get(hash)?.expiresAt.getTime(),
    baseExpiry,
    "não deveria renovar antes da metade do TTL"
  );

  // Passada a metade (restando < 30s), a verificação estende para agora + TTL.
  clock.advance(20_000); // 40s desde o login
  const renewed = await provider.verifySession(login.sessionToken);
  const expectedNewExpiry = baseExpiry + 40_000; // agora(login+40s) + 60s
  assert.equal(renewed.expiresAt.getTime(), expectedNewExpiry, "deveria estender para agora + TTL");
  assert.equal(sessions.records.get(hash)?.expiresAt.getTime(), expectedNewExpiry);

  // Além da expiração ORIGINAL (60s), mas dentro da janela renovada: segue válida.
  clock.advance(50_000); // 90s desde o login; sem a renovação já teria expirado aos 60s
  await provider.verifySession(login.sessionToken); // não deve lançar
});

test("perfil ativo é atualizado, limpo e removido definitivamente na revogação", async () => {
  const { provider, sessions } = fixture();
  const login = await provider.signInWithPassword({
    email: "lucas@example.com", password: "correct-secret"
  });
  const hash = hashOpaqueSessionToken(login.sessionToken);

  assert.equal(
    (await provider.setActiveProfile(login.sessionToken, "profile-1")).activeProfileId,
    "profile-1"
  );
  assert.equal(
    (await provider.setActiveProfile(login.sessionToken, null)).activeProfileId,
    null
  );
  await provider.setActiveProfile(login.sessionToken, "profile-2");
  await provider.revokeSession(login.sessionToken);

  assert.equal(sessions.records.get(hash)?.activeProfileId, null);
  assert.ok(sessions.records.get(hash)?.revokedAt);
  await expectAuthenticationFailure(() =>
    provider.setActiveProfile(login.sessionToken, "profile-3")
  );
});

// issueSessionForUser é o método que o pareamento de aparelho chama por HTTP (claim) para
// emitir sessão sem senha; roda em produção via SupabaseAuthProvider, então precisa de teste
// próprio e não só no InMemoryAuthProvider usado nos demais testes de rota.
test("issueSessionForUser emite sessão sem senha e recusa id desconhecido", async () => {
  const { provider, gateway, sessions } = fixture();

  const resultado = await provider.issueSessionForUser(gateway.user.id);
  assert.ok(resultado.sessionToken.length > 0);
  assert.equal(resultado.session.user.email, "lucas@example.com");
  const expectedHash = hashOpaqueSessionToken(resultado.sessionToken);
  assert.equal(sessions.records.has(expectedHash), true);
  const verificada = await provider.verifySession(resultado.sessionToken);
  assert.equal(verificada.user.email, "lucas@example.com");

  await expectAuthenticationFailure(() => provider.issueSessionForUser("id-desconhecido"));
});

test("configuração Supabase desativa toda persistência e renovação automática", () => {
  assert.deepEqual(SUPABASE_STATELESS_AUTH_OPTIONS, {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false
  });
});
