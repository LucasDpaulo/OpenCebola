import {
  createHash,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { AuthenticationError } from "./errors.js";
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
// Sessão deslizante: renova quando resta menos da metade do TTL. Espelha o provider do Supabase.
const RENEW_WHEN_REMAINING_BELOW = 0.5;
const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 1_024;

export interface InMemoryAuthUser {
  readonly id: string;
  readonly email: string;
  /** Exclusivo para testes locais; nunca usar esta implementação em produção. */
  readonly password: string;
}

export interface InMemoryAuthProviderOptions {
  readonly users?: readonly InMemoryAuthUser[];
  readonly sessionTtlMs?: number;
  readonly clock?: Clock;
  readonly tokenFactory?: () => string;
}

interface StoredUser {
  readonly user: AuthUser;
  readonly password: string;
}

interface StoredSession {
  session: AuthSession;
  revoked: boolean;
}

function normalizeEmail(email: string): string {
  return email.trim().toLocaleLowerCase("en-US");
}

function digestToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Compara sem saída antecipada mesmo quando os comprimentos diferem. */
function constantTimeTextEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

/**
 * Fake determinístico/in-memory para testes e desenvolvimento isolado.
 * Senhas em texto puro são aceitas somente como fixtures. Produção deve usar
 * uma implementação server-side de AuthProvider baseada no Supabase Auth.
 */
export class InMemoryAuthProvider implements AuthProvider {
  private readonly usersByEmail = new Map<string, StoredUser>();
  private readonly sessionsByTokenDigest = new Map<string, StoredSession>();
  private readonly sessionTtlMs: number;
  private readonly clock: Clock;
  private readonly tokenFactory: () => string;

  constructor(options: InMemoryAuthProviderOptions = {}) {
    const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs <= 0) {
      throw new TypeError("Duração da sessão inválida.");
    }

    this.sessionTtlMs = sessionTtlMs;
    this.clock = options.clock ?? systemClock;
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));

    for (const fixture of options.users ?? []) {
      const email = normalizeEmail(fixture.email);
      if (this.usersByEmail.has(email)) {
        throw new TypeError("Fixture de autenticação duplicada.");
      }

      this.usersByEmail.set(email, {
        user: Object.freeze({ id: fixture.id, email }),
        password: fixture.password
      });
    }
  }

  async signInWithPassword(credentials: PasswordCredentials): Promise<AuthResult> {
    const email = normalizeEmail(credentials.email);
    const password = credentials.password;
    const storedUser = this.usersByEmail.get(email);

    const inputWithinLimits =
      email.length > 0 &&
      email.length <= MAX_EMAIL_LENGTH &&
      password.length > 0 &&
      password.length <= MAX_PASSWORD_LENGTH;

    // A comparação também ocorre quando o usuário não existe para reduzir a
    // diferença observável entre e-mail desconhecido e senha incorreta.
    const expectedPassword = storedUser?.password ?? "invalid-credential-placeholder";
    const passwordMatches = constantTimeTextEqual(password, expectedPassword);

    if (!inputWithinLimits || !storedUser || !passwordMatches) {
      throw new AuthenticationError();
    }

    return this.#issueSession(storedUser.user);
  }

  /**
   * Emite sessão para um usuário já identificado pelo pareamento de aparelho,
   * sem senha: quem aprova o código já está autenticado noutro aparelho.
   */
  async issueSessionForUser(userId: string): Promise<AuthResult> {
    const stored = [...this.usersByEmail.values()]
      .find((candidate) => candidate.user.id === userId);
    if (!stored) {
      throw new AuthenticationError();
    }
    return this.#issueSession(stored.user);
  }

  // Miolo de criação da sessão, extraído de signInWithPassword para ser
  // reaproveitado pelo pareamento de aparelho (issueSessionForUser), que
  // chega com o usuário já identificado, sem senha para conferir.
  async #issueSession(user: AuthUser): Promise<AuthResult> {
    const sessionToken = this.tokenFactory();
    if (!sessionToken || sessionToken.length > 4_096) {
      throw new TypeError("A fábrica de tokens devolveu um token inválido.");
    }

    const now = this.clock.now();
    const session: AuthSession = Object.freeze({
      user,
      expiresAt: new Date(now.getTime() + this.sessionTtlMs),
      activeProfileId: null
    });

    this.sessionsByTokenDigest.set(digestToken(sessionToken), {
      session,
      revoked: false
    });

    return { session, sessionToken };
  }

  async verifySession(sessionToken: string): Promise<AuthSession> {
    const tokenDigest = digestToken(sessionToken);
    const storedSession = this.sessionsByTokenDigest.get(tokenDigest);
    const now = this.clock.now();
    const isExpired = storedSession
      ? storedSession.session.expiresAt.getTime() <= now.getTime()
      : false;

    if (!storedSession || storedSession.revoked || isExpired) {
      if (isExpired) {
        this.sessionsByTokenDigest.delete(tokenDigest);
      }
      throw new AuthenticationError();
    }

    // Sessão deslizante: quem usa dentro da janela nunca desloga.
    const remaining = storedSession.session.expiresAt.getTime() - now.getTime();
    if (remaining < this.sessionTtlMs * RENEW_WHEN_REMAINING_BELOW) {
      storedSession.session = Object.freeze({
        ...storedSession.session,
        expiresAt: new Date(now.getTime() + this.sessionTtlMs)
      });
    }

    return storedSession.session;
  }

  async revokeSession(sessionToken: string): Promise<void> {
    const storedSession = this.sessionsByTokenDigest.get(digestToken(sessionToken));
    if (storedSession) {
      storedSession.session = Object.freeze({
        ...storedSession.session,
        activeProfileId: null
      });
      storedSession.revoked = true;
    }
  }

  async setActiveProfile(
    sessionToken: string,
    profileId: string | null
  ): Promise<AuthSession> {
    const session = await this.verifySession(sessionToken);
    const storedSession = this.sessionsByTokenDigest.get(digestToken(sessionToken));
    if (!storedSession) {
      throw new AuthenticationError();
    }

    storedSession.session = Object.freeze({ ...session, activeProfileId: profileId });
    return storedSession.session;
  }
}
