import type { FastifyReply, FastifyRequest } from "fastify";
import type { SessionTokenSource } from "./auth/session-token.js";

/**
 * Módulo próprio, e não um apêndice de `rate-limit-key.ts`: aquele arquivo responde "quanto
 * este cliente pode pedir", este responde "esta requisição pode mudar estado". São decisões
 * diferentes, com motivos diferentes para mudar. O que justifica ser um arquivo no topo de
 * `src/` é quem o usa: auth, profiles, progress e stremio, todos os quatro. Pendurar a regra
 * em qualquer um deles obrigaria os outros três a importar de um módulo de domínio alheio.
 *
 * Existia uma cópia desta checagem em cada um dos quatro, e elas divergiram: duas eram cientes
 * da procedência da credencial, duas não. A divergência não era estética — deixou o cliente
 * nativo sem como criar perfil, ativar perfil ou gravar progresso, porque essas três rotas
 * exigiam `Origin` de quem nunca terá uma. Uma decisão de segurança copiada quatro vezes vira
 * quatro decisões; por isso agora é uma função só.
 */

/**
 * A regra normal das rotas autenticadas que mudam estado.
 *
 * CSRF é ataque de navegador: ele anexa o cookie sozinho numa requisição disparada por outro
 * site, mas nunca anexa `Authorization`. Por isso a checagem vale para cookie e não para
 * Bearer — exigi-la do app só o recusaria, sem proteger ninguém.
 *
 * Sem credencial nenhuma (`null`) a checagem continua valendo: quem chega anônimo não provou
 * que escreveu o cabeçalho, e deixar passar abriria a porta que o cookie fecha.
 */
export function requireTrustedOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
  expectedOrigin: string,
  source: SessionTokenSource | null
): boolean {
  if (source === "bearer") return true;
  return requireWebOrigin(request, reply, expectedOrigin);
}

/**
 * Exigência incondicional, para as portas que só existem para o navegador: `POST
 * /v1/auth/login` (que ainda não tem sessão nenhuma para ter procedência), `POST
 * /v1/auth/logout` (a porta de cookie; cliente nativo usa `/v1/auth/device/logout`) e `POST
 * /v1/auth/device/approve` (ver o comentário na rota: aprovar emite sessão nova).
 *
 * É uma função separada de propósito. Passar `null` como procedência daria o mesmo resultado,
 * mas leria como esquecimento; aqui o nome diz que a exigência é a decisão, não um descuido.
 */
export function requireWebOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
  expectedOrigin: string
): boolean {
  if (request.headers.origin === expectedOrigin) return true;
  void reply.code(403).send({
    error: { code: "UNTRUSTED_ORIGIN", message: "Origem não autorizada." }
  });
  return false;
}
