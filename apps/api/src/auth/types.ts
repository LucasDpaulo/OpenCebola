/** Identidade autenticada pelo provedor. */
export interface AuthUser {
  readonly id: string;
  readonly email: string;
}

/** Sessão validada. O token nunca é incluído neste objeto. */
export interface AuthSession {
  readonly user: AuthUser;
  readonly expiresAt: Date;
  readonly activeProfileId: string | null;
}

export interface PasswordCredentials {
  readonly email: string;
  readonly password: string;
}

/**
 * Resultado sensível devolvido somente no momento da autenticação.
 * O chamador deve transportar o token opaco em cookie HttpOnly e nunca logá-lo.
 */
export interface AuthResult {
  readonly session: AuthSession;
  /** Credencial opaca emitida pelo Cebola; nunca um token do provedor. */
  readonly sessionToken: string;
}

/**
 * Fronteira entre a API do Cebola e o serviço de identidade.
 *
 * Uma implementação apoiada pelo Supabase Auth deve permanecer server-side,
 * trocar a sessão do provedor por uma sessão opaca do Cebola, mapear todos os
 * erros de credencial para AuthenticationError e nunca expor service-role keys,
 * senhas ou tokens ao logger ou ao navegador.
 */
export interface AuthProvider {
  signInWithPassword(credentials: PasswordCredentials): Promise<AuthResult>;
  /**
   * Emite sessão para um usuário já identificado, sem senha. Existe para o pareamento de
   * aparelho: quem aprova o código já está autenticado noutro aparelho, e exigir a senha de
   * novo derrotaria o motivo de o fluxo existir.
   */
  issueSessionForUser(userId: string): Promise<AuthResult>;
  verifySession(sessionToken: string): Promise<AuthSession>;
  setActiveProfile(sessionToken: string, profileId: string | null): Promise<AuthSession>;
  revokeSession(sessionToken: string): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date()
};
