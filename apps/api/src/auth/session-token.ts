import type { FastifyRequest } from "fastify";
import { readSessionToken } from "./session-cookie.js";

/**
 * De onde veio a credencial. Não é detalhe de transporte: é o que decide quais defesas se
 * aplicam. Cookie é anexado pelo navegador sozinho, então precisa de proteção contra CSRF;
 * `Authorization` só existe quando o cliente o escreveu, então não precisa.
 */
export type SessionTokenSource = "bearer" | "cookie";

export interface RequestSessionToken {
  readonly token: string;
  readonly source: SessionTokenSource;
}

/** Mesmo alfabeto e mesmo teto do cookie: o token é o mesmo, só muda o transporte. */
const BEARER_PATTERN = /^Bearer ([A-Za-z0-9._~-]{1,4096})$/;

export function readRequestSessionToken(request: FastifyRequest): RequestSessionToken | null {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === "string") {
    // Presente e malformado NÃO cai para o cookie: ver o teste que cobre isso.
    const match = BEARER_PATTERN.exec(value);
    return match ? { token: match[1]!, source: "bearer" } : null;
  }
  const cookie = readSessionToken(request.headers.cookie);
  return cookie === null ? null : { token: cookie, source: "cookie" };
}
