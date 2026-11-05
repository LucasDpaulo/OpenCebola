import { createHash, randomBytes } from "node:crypto";
import { AuthenticationError } from "./errors.js";
import {
  SessionTokenCollisionError,
  type OpaqueSessionRecord,
  type SessionRepository
} from "./session-repository.js";
import type { SupabaseAuthGateway } from "./supabase-server-auth-gateway.js";
import {
  systemClock,
  type AuthProvider,
  type AuthResult,
  type AuthSession,
  type AuthUser,
  type Clock,
  type PasswordCredentials
} from "./types.js";

const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1_000;
// Sessão deslizante: renova quando resta menos da metade do TTL. Assim um aparelho em uso nunca
// desloga (só relogam aparelhos parados além da janela), e a escrita no banco acontece no máximo
// uma vez por meia-janela por sessão ativa — não a cada requisição.
const RENEW_WHEN_REMAINING_BELOW = 0.5;
const TOKEN_BYTES = 32;
const MAX_CREATE_ATTEMPTS = 3;
const MAX_OPAQUE_TOKEN_LENGTH = 256;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface SupabaseAuthProviderOptions {
  readonly gateway: SupabaseAuthGateway;
  readonly sessions: SessionRepository;
  readonly sessionTtlMs?: number;
  readonly clock?: Clock;
  readonly tokenFactory?: () => string;
}

export function hashOpaqueSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function validToken(token: string): boolean {
  return token.length > 0 &&
    token.length <= MAX_OPAQUE_TOKEN_LENGTH &&
    OPAQUE_TOKEN_PATTERN.test(token);
}

function toAuthSession(record: OpaqueSessionRecord, user: AuthUser): AuthSession {
  return Object.freeze({
    user,
    expiresAt: new Date(record.expiresAt),
    activeProfileId: record.activeProfileId
  });
}

/** Troca a identidade Supabase por uma credencial própria, opaca e revogável. */
export class SupabaseAuthProvider implements AuthProvider {
  private readonly gateway: SupabaseAuthGateway;
  private readonly sessions: SessionRepository;
  private readonly sessionTtlMs: number;
  private readonly clock: Clock;
  private readonly tokenFactory: () => string;

  constructor(options: SupabaseAuthProviderOptions) {
    const ttl = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl <= 0) {
      throw new TypeError("Duração da sessão inválida.");
    }
    this.gateway = options.gateway;
    this.sessions = options.sessions;
    this.sessionTtlMs = ttl;
    this.clock = options.clock ?? systemClock;
    this.tokenFactory = options.tokenFactory ??
      (() => randomBytes(TOKEN_BYTES).toString("base64url"));
  }

  async signInWithPassword(credentials: PasswordCredentials): Promise<AuthResult> {
    const authenticated = await this.gateway.authenticate(credentials);
    return this.#issueOpaqueSession(authenticated.user);
  }

  /**
   * Emite sessão para um usuário já identificado pelo pareamento de aparelho,
   * sem passar por senha: o outro aparelho já provou a identidade.
   */
  async issueSessionForUser(userId: string): Promise<AuthResult> {
    const user = await this.gateway.findUserById(userId);
    if (!user) {
      throw new AuthenticationError();
    }
    return this.#issueOpaqueSession(user);
  }

  // Miolo de criação da sessão opaca, extraído de signInWithPassword para ser
  // reaproveitado pelo pareamento de aparelho (issueSessionForUser), que não
  // tem credencial de senha para autenticar contra o Supabase.
  async #issueOpaqueSession(user: AuthUser): Promise<AuthResult> {
    const now = this.clock.now();
    // A sessão do Cebola é opaca, fica armazenada no servidor e é validada
    // novamente contra o usuário do Supabase a cada uso. Por isso, sua
    // duração não deve ser limitada pelo access token temporário usado apenas
    // durante a autenticação inicial.
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs);

    if (expiresAt.getTime() <= now.getTime()) {
      throw new AuthenticationError();
    }

    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      const sessionToken = this.tokenFactory();
      if (!validToken(sessionToken)) {
        throw new TypeError("A fábrica de tokens devolveu um token inválido.");
      }

      try {
        await this.sessions.create({
          tokenHash: hashOpaqueSessionToken(sessionToken),
          userId: user.id,
          expiresAt,
          activeProfileId: null
        });

        return {
          session: Object.freeze({
            user,
            expiresAt,
            activeProfileId: null
          }),
          sessionToken
        };
      } catch (error) {
        if (!(error instanceof SessionTokenCollisionError)) {
          throw error;
        }
      }
    }

    throw new Error("Não foi possível emitir uma sessão Cebola única.");
  }

  async verifySession(sessionToken: string): Promise<AuthSession> {
    if (!validToken(sessionToken)) {
      throw new AuthenticationError();
    }

    const now = this.clock.now();
    const record = await this.sessions.findByTokenHash(
      hashOpaqueSessionToken(sessionToken)
    );
    if (
      !record ||
      record.revokedAt ||
      record.expiresAt.getTime() <= now.getTime()
    ) {
      throw new AuthenticationError();
    }

    const user = await this.gateway.findUserById(record.userId);
    if (!user) {
      await this.sessions.revokeByTokenHash(record.tokenHash, now);
      throw new AuthenticationError();
    }

    return toAuthSession(await this.#slideExpiry(record, now), user);
  }

  /**
   * Renova o prazo da sessão quando resta menos da metade do TTL. A renovação é oportunista: se a
   * escrita no banco falhar, a sessão segue valendo com o prazo atual — um soluço do Supabase não
   * pode virar um 401 no meio do uso.
   */
  async #slideExpiry(record: OpaqueSessionRecord, now: Date): Promise<OpaqueSessionRecord> {
    const remaining = record.expiresAt.getTime() - now.getTime();
    if (remaining >= this.sessionTtlMs * RENEW_WHEN_REMAINING_BELOW) {
      return record;
    }
    const newExpiresAt = new Date(now.getTime() + this.sessionTtlMs);
    try {
      await this.sessions.renew(record.tokenHash, newExpiresAt, now);
    } catch {
      return record;
    }
    return { ...record, expiresAt: newExpiresAt };
  }

  async setActiveProfile(
    sessionToken: string,
    profileId: string | null
  ): Promise<AuthSession> {
    if (!validToken(sessionToken)) {
      throw new AuthenticationError();
    }
    const now = this.clock.now();
    const record = await this.sessions.setActiveProfile(
      hashOpaqueSessionToken(sessionToken),
      profileId,
      now
    );
    if (!record) {
      throw new AuthenticationError();
    }

    const user = await this.gateway.findUserById(record.userId);
    if (!user) {
      await this.sessions.revokeByTokenHash(record.tokenHash, now);
      throw new AuthenticationError();
    }
    return toAuthSession(record, user);
  }

  async revokeSession(sessionToken: string): Promise<void> {
    if (!validToken(sessionToken)) {
      return;
    }
    await this.sessions.revokeByTokenHash(
      hashOpaqueSessionToken(sessionToken),
      this.clock.now()
    );
  }
}
