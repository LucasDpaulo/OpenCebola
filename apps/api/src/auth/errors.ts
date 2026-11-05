/** Mensagem deliberadamente neutra para impedir enumeração de contas. */
export const AUTHENTICATION_ERROR_MESSAGE = "Não foi possível autenticar.";

/**
 * Único erro público para credencial incorreta, token ausente, inválido,
 * expirado ou revogado. A API não deve diferenciar esses casos na resposta.
 */
export class AuthenticationError extends Error {
  readonly code = "AUTHENTICATION_FAILED" as const;

  constructor() {
    super(AUTHENTICATION_ERROR_MESSAGE);
    this.name = "AuthenticationError";
  }
}

export function isAuthenticationError(error: unknown): error is AuthenticationError {
  return error instanceof AuthenticationError;
}
