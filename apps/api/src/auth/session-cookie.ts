export const SESSION_COOKIE_NAME = "__Host-cebola_session";

const MAX_TOKEN_LENGTH = 4_096;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9._~-]+$/;

export interface SessionCookieOptions {
  /** Duração do cookie em segundos. Deve acompanhar a duração da sessão. */
  readonly maxAgeSeconds: number;
  readonly sameSite?: "Strict" | "Lax";
}

function assertValidToken(token: string): void {
  if (
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH ||
    !SAFE_TOKEN_PATTERN.test(token)
  ) {
    throw new TypeError("Token de sessão inválido.");
  }
}

/**
 * Cookie host-only, inacessível a JavaScript e enviado somente por HTTPS.
 * O prefixo __Host- exige Secure, Path=/ e ausência de Domain.
 */
export function serializeSessionCookie(
  sessionToken: string,
  options: SessionCookieOptions
): string {
  assertValidToken(sessionToken);

  if (!Number.isSafeInteger(options.maxAgeSeconds) || options.maxAgeSeconds <= 0) {
    throw new TypeError("Duração do cookie inválida.");
  }

  const sameSite = options.sameSite ?? "Lax";

  return [
    `${SESSION_COOKIE_NAME}=${sessionToken}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    `SameSite=${sameSite}`,
    `Max-Age=${options.maxAgeSeconds}`
  ].join("; ");
}

export function serializeExpiredSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0"
  ].join("; ");
}

/**
 * Extrai o token sem aceitar cookies duplicados. Duplicidade é tratada como
 * sessão ausente para evitar interpretações divergentes entre proxies/API.
 */
export function readSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) {
    return null;
  }

  let matchedToken: string | null = null;

  for (const part of cookieHeader.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }

    const name = part.slice(0, separatorIndex).trim();
    if (name !== SESSION_COOKIE_NAME) {
      continue;
    }

    if (matchedToken !== null) {
      return null;
    }

    const value = part.slice(separatorIndex + 1).trim();
    if (
      value.length === 0 ||
      value.length > MAX_TOKEN_LENGTH ||
      !SAFE_TOKEN_PATTERN.test(value)
    ) {
      return null;
    }

    matchedToken = value;
  }

  return matchedToken;
}
