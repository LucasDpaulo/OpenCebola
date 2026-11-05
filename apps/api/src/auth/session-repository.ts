export interface OpaqueSessionRecord {
  readonly tokenHash: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly activeProfileId: string | null;
  readonly revokedAt: Date | null;
}

export interface CreateOpaqueSession {
  readonly tokenHash: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly activeProfileId: null;
}

/** Persistência exclusiva da API; nunca recebe o token opaco em texto puro. */
export interface SessionRepository {
  create(session: CreateOpaqueSession): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<OpaqueSessionRecord | null>;
  setActiveProfile(
    tokenHash: string,
    profileId: string | null,
    now: Date
  ): Promise<OpaqueSessionRecord | null>;
  /**
   * Estende o prazo de uma sessão viva (não revogada e ainda não expirada). É o que torna a
   * sessão deslizante: quem usa o app dentro da janela nunca precisa relogar. A guarda `now`
   * impede ressuscitar uma sessão que acabou de expirar numa corrida.
   */
  renew(tokenHash: string, newExpiresAt: Date, now: Date): Promise<void>;
  revokeByTokenHash(tokenHash: string, revokedAt: Date): Promise<void>;
}

/** Permite que o provider tente outro token sem confundir colisão com indisponibilidade. */
export class SessionTokenCollisionError extends Error {
  constructor() {
    super("Colisão ao criar sessão opaca.");
    this.name = "SessionTokenCollisionError";
  }
}
