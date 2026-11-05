import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readRequestSessionToken } from "./auth/session-token.js";

/**
 * Chave segura para rotas públicas. Um cookie não autenticado nunca pode criar um balde novo:
 * caso contrário basta trocar um token falso a cada request para contornar o limite de login.
 */
export function clientIpRateLimitKey(request: FastifyRequest): string {
  const header = request.headers["cf-connecting-ip"];
  const value = Array.isArray(header) ? header[0] : header;
  return value !== undefined && value !== "" ? value : request.ip;
}

/**
 * Usada somente nas rotas autenticadas e caras. A chave é IP **mais** sessão, não sessão
 * sozinha: duas pessoas atrás do mesmo NAT doméstico continuam com baldes separados (era o
 * problema original), mas um cookie forjado não consegue mais escapar da dimensão do IP.
 *
 * Isso ainda não é suficiente sozinho — trocar o token falso a cada request multiplica baldes
 * dentro do mesmo IP, e cada request custa um verifySession antes do 401. Por isso as rotas
 * caras somam um teto por IP (ver ipCeilingHook), que este balde por sessão não substitui.
 *
 * Lê Bearer ou cookie: o app nativo autentica por Bearer, e o balde por sessão precisa valer
 * para ele também, não só para quem chega pelo navegador.
 */
export function sessionRateLimitKey(request: FastifyRequest): string {
  const ip = clientIpRateLimitKey(request);
  const credential = readRequestSessionToken(request);
  if (credential === null) return ip;
  return `${ip}|s:${createHash("sha256").update(credential.token).digest("base64url").slice(0, 22)}`;
}

/**
 * Teto por IP para as rotas caras. O limite por rota já é chaveado por sessão, e o plugin
 * substitui — não soma — a configuração global naquela rota: sem este hook, ninguém conta
 * requisições por IP ali. Como o cookie ainda não foi verificado no onRequest, é este teto que
 * impede alguém de trocar tokens falsos para multiplicar baldes e transformar cada request em
 * uma consulta de sessão no Supabase.
 *
 * O número é generoso de propósito: precisa caber uma casa inteira assistindo, e só existe para
 * cortar abuso automatizado, não para disciplinar uso real.
 */
export function ipCeilingHook(
  app: FastifyInstance,
  ceiling: { readonly max: number; readonly timeWindow: string }
) {
  return sharedRateLimitHook(app, { ...ceiling, keyGenerator: clientIpRateLimitKey });
}

/**
 * Um balde só, dividido por todas as rotas que receberem este hook.
 *
 * `config.rateLimit` por rota NÃO serve para isso, e `groupId` também não: o plugin cria um
 * `store.child()` — um mapa novo — para cada rota que traz configuração própria, então duas
 * rotas com a mesma configuração contam em lugares separados. Só um `createRateLimit` único,
 * pendurado como onRequest nas duas, faz as duas dividirem a mesma contagem.
 *
 * Sem `keyGenerator` a chave é herdada da configuração global, que respeita
 * CEBOLA_TRUST_PROXY: em produção o IP vem do CF-Connecting-IP, em dev vem do socket. Passar
 * um explícito só faz sentido quando a rota precisa de outra dimensão de chave.
 */
export function sharedRateLimitHook(
  app: FastifyInstance,
  limit: {
    readonly max: number;
    readonly timeWindow: string;
    readonly keyGenerator?: (request: FastifyRequest) => string;
  }
) {
  // A chave `keyGenerator` não pode ser passada como `undefined`: o plugin faz Object.assign
  // por cima da configuração global, e um undefined explícito apagaria a chave herdada.
  const check = app.createRateLimit(limit.keyGenerator
    ? { max: limit.max, timeWindow: limit.timeWindow, keyGenerator: limit.keyGenerator }
    : { max: limit.max, timeWindow: limit.timeWindow });
  return async function enforceSharedRateLimit(request: FastifyRequest, reply: FastifyReply) {
    const result = await check(request);
    // `isAllowed` NÃO significa "dentro do limite": o plugin só o marca quando a chave está na
    // allow list e a contagem foi pulada por completo. Quem responde "estourou" é `isExceeded`.
    if (result.isAllowed || !result.isExceeded) return;
    reply.header("retry-after", String(result.ttlInSeconds));
    return reply.code(429).send({
      error: {
        code: "RATE_LIMIT_EXCEEDED",
        message: "Muitas requisições deste endereço. Tente de novo em instantes."
      }
    });
  };
}
