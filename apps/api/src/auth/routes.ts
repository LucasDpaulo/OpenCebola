import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  authSessionResponseSchema,
  deviceSessionResponseSchema,
  devicePairingApproveRequestSchema,
  devicePairingClaimRequestSchema,
  devicePairingTicketResponseSchema,
  loginRequestSchema
} from "@cebola/contracts";
import { requireTrustedOrigin, requireWebOrigin } from "../http-origin.js";
import { sharedRateLimitHook } from "../rate-limit-key.js";
import { AuthenticationError, isAuthenticationError } from "./errors.js";
import type { DevicePairingStore } from "./device-pairing.js";
import {
  serializeExpiredSessionCookie,
  serializeSessionCookie
} from "./session-cookie.js";
import { readRequestSessionToken } from "./session-token.js";
import type { AuthProvider, AuthSession } from "./types.js";

const authenticationFailure = {
  error: {
    code: "AUTHENTICATION_FAILED",
    message: "Não foi possível autenticar."
  }
} as const;

export interface AuthRoutesOptions {
  readonly provider: AuthProvider;
  readonly webOrigin: string;
  readonly now?: () => Date;
  readonly devicePairing?: DevicePairingStore;
}

function publicSession(session: AuthSession) {
  return authSessionResponseSchema.parse({
    user: { email: session.user.email },
    expiresAt: session.expiresAt.toISOString(),
    activeProfileId: session.activeProfileId
  });
}

function sessionTokenFrom(request: FastifyRequest): string {
  const credential = readRequestSessionToken(request);
  if (credential === null) throw new AuthenticationError();
  return credential.token;
}

/**
 * Registra somente a borda HTTP. O provider continua responsável por trocar a
 * identidade externa por uma sessão opaca e revogável do Cebola.
 */
export async function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRoutesOptions
): Promise<void> {
  const now = options.now ?? (() => new Date());

  // As duas portas de senha dividem UM balde. Em baldes separados de 10/min cada, o orçamento
  // de força bruta por IP contra a mesma conta era 20/min — o dobro do que existia antes de a
  // rota de aparelho aparecer — e a de aparelho ainda dispensa Origin, o que faz dela a porta
  // mais confortável para um script.
  // Escolha entre as duas saídas: balde compartilhado em 10/min, e não 5/min em cada porta.
  // 10/min é o número que já estava calibrado e rodando para a web; cortar pela metade
  // apertaria quem digita a senha errada em casa (numa casa inteira atrás do mesmo IP) para
  // resolver um problema que é de contagem, não de generosidade.
  const tentativasDeSenha = sharedRateLimitHook(app, { max: 10, timeWindow: "1 minute" });

  app.post("/v1/auth/login", {
    onRequest: tentativasDeSenha
  }, async (request, reply) => {
    // Login não tem procedência para consultar: ainda não existe sessão. É porta de navegador,
    // e continua exigindo Origin sempre. Cliente nativo entra por /v1/auth/device/login.
    if (!requireWebOrigin(request, reply, options.webOrigin)) return reply;

    const parsed = loginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "INVALID_REQUEST", message: "Dados de acesso inválidos." }
      });
    }

    try {
      const result = await options.provider.signInWithPassword(parsed.data);
      const remainingSeconds = Math.floor(
        (result.session.expiresAt.getTime() - now().getTime()) / 1_000
      );
      if (remainingSeconds <= 0) throw new AuthenticationError();

      reply.header("Set-Cookie", serializeSessionCookie(result.sessionToken, {
        maxAgeSeconds: remainingSeconds
      }));
      return reply.send(publicSession(result.session));
    } catch (error) {
      if (isAuthenticationError(error)) {
        return reply.code(401).send(authenticationFailure);
      }
      throw error;
    }
  });

  // Cliente nativo não tem Origin que signifique alguma coisa, e não recebe cookie. Esta rota
  // existe para ele: mesmo provider, mesma sessão opaca, entregue no corpo. A web nunca a chama.
  app.post("/v1/auth/device/login", {
    onRequest: tentativasDeSenha
  }, async (request, reply) => {
    const parsed = loginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "INVALID_REQUEST", message: "Dados de acesso inválidos." }
      });
    }

    try {
      const result = await options.provider.signInWithPassword(parsed.data);
      if (result.session.expiresAt.getTime() <= now().getTime()) throw new AuthenticationError();
      return reply.send(deviceSessionResponseSchema.parse({
        token: result.sessionToken,
        expiresAt: result.session.expiresAt.toISOString(),
        session: publicSession(result.session)
      }));
    } catch (error) {
      if (isAuthenticationError(error)) {
        return reply.code(401).send(authenticationFailure);
      }
      throw error;
    }
  });

  // Sem esta rota o aparelho nativo não consegue nem se desligar: /v1/auth/logout exige Origin
  // SEMPRE (é a porta do cookie do navegador) e um cliente Bearer não tem Origin que signifique
  // coisa alguma. Uma sessão que ninguém consegue revogar é uma sessão de 30 dias viva na TV
  // que ficou para trás. Não emite cookie: quem chega aqui não tem nenhum para apagar.
  app.post("/v1/auth/device/logout", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const credential = readRequestSessionToken(request);
    if (credential === null) return reply.code(401).send(authenticationFailure);
    // Cookie que caia aqui continua sob a regra de Origin. Revogar por CSRF seria só incômodo,
    // não roubo de conta, mas não há motivo para abrir a porta: o navegador tem /v1/auth/logout.
    if (!requireTrustedOrigin(request, reply, options.webOrigin, credential.source)) return reply;

    await options.provider.revokeSession(credential.token);
    return reply.code(204).send();
  });

  const pairing = options.devicePairing;
  if (pairing) {
    // Pública e limitada por IP: quem pede o código é uma TV que ainda não tem sessão nenhuma.
    app.post("/v1/auth/device/code", {
      config: { rateLimit: { max: 10, timeWindow: "5 minutes" } }
    }, async (_request, reply) => {
      try {
        const ticket = pairing.create(now());
        return reply.send(devicePairingTicketResponseSchema.parse({
          code: ticket.code,
          deviceId: ticket.deviceId,
          expiresInSeconds: Math.floor((ticket.expiresAt.getTime() - now().getTime()) / 1_000)
        }));
      } catch {
        return reply.code(503).send({
          error: { code: "PAIRING_UNAVAILABLE", message: "Tente novamente em alguns minutos." }
        });
      }
    });

    // Autenticada: só quem já entrou pode liberar um aparelho para a própria conta.
    app.post("/v1/auth/device/approve", {
      config: { rateLimit: { max: 20, timeWindow: "5 minutes" } }
    }, async (request, reply) => {
      const credential = readRequestSessionToken(request);
      // Aprovar é escalada de privilégio: a chamada EMITE uma sessão nova, com o TTL inteiro,
      // sem ninguém digitar senha. Aceitando Bearer aqui, uma sessão roubada virava máquina de
      // fabricar sessões — pede código, aprova com o próprio token, reivindica um token novo, e
      // repete indefinidamente, sem nunca passar pela senha e sem deixar nada para revogar.
      // Na fase 0a quem aprova é sempre alguém num navegador com teclado (a web é a única
      // interface que existe), então exigir cookie mata a cadeia de renovação sem custar nada
      // de usabilidade.
      // Fase 1: quando o app de celular existir e precisar aprovar, isto tem que virar
      // procedência de sessão gravada no banco — "esta sessão nasceu de senha ou de
      // pareamento?" —, e não a forma como a credencial chegou nesta requisição.
      if (credential !== null && credential.source !== "cookie") {
        return reply.code(403).send({
          error: {
            code: "PAIRING_REQUIRES_BROWSER",
            message: "A aprovação precisa ser feita pelo site, num navegador."
          }
        });
      }
      // Sem credencial nenhuma a requisição segue e morre em 401 no verifySession abaixo: "não
      // autenticado" continua sendo 401, não 403.
      // Rota autenticada, que muda estado e é alcançável por cookie: sem esta checagem, uma
      // página maliciosa faria o navegador da vítima aprovar o código do ATACANTE, e ele
      // ficaria com uma sessão dela.
      if (!requireWebOrigin(request, reply, options.webOrigin)) return reply;

      const parsed = devicePairingApproveRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "Código inválido." } });
      }
      try {
        const session = await options.provider.verifySession(sessionTokenFrom(request));
        // Código desconhecido e código expirado respondem igual: não confirmamos existência.
        if (!pairing.approve(parsed.data.code, session.user.id, now())) {
          return reply.code(404).send({ error: { code: "PAIRING_NOT_FOUND", message: "Código não encontrado." } });
        }
        return reply.code(204).send();
      } catch (error) {
        if (isAuthenticationError(error)) return reply.code(401).send(authenticationFailure);
        throw error;
      }
    });

    // A TV consulta em laço até aprovarem. 202 significa "ainda não", e não é erro.
    app.post("/v1/auth/device/claim", {
      config: { rateLimit: { max: 240, timeWindow: "5 minutes" } }
    }, async (request, reply) => {
      const parsed = devicePairingClaimRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "Dados inválidos." } });
      }
      const resultado = pairing.claim(parsed.data.code, parsed.data.deviceId, now());
      if (resultado.status === "pending") return reply.code(202).send();
      if (resultado.status === "unknown") {
        return reply.code(404).send({ error: { code: "PAIRING_NOT_FOUND", message: "Código não encontrado." } });
      }

      // A emissão fica dentro de try/catch, como nas outras rotas do arquivo. Antes ela era a
      // única chamada solta: o bilhete já tinha sido consumido, e qualquer falha aqui deixava a
      // TV com 500 e um código morto que a pessoa acabou de ver aprovar. (O vazamento de
      // err.message que este comentário citava foi fechado depois, pelo setErrorHandler em
      // buildApp; o try/catch continua valendo pelo bilhete, que é o motivo principal.)
      //
      // Escolha entre as duas saídas possíveis: reinserir no catch, e não emitir antes de
      // consumir. Emitir antes exigiria uma consulta que não consome, e aí duas requisições
      // simultâneas com o mesmo bilhete emitiriam duas sessões — o uso único do bilhete é
      // justamente o que impede isso, e não vale trocá-lo por conveniência de ordem.
      try {
        const result = await options.provider.issueSessionForUser(resultado.userId);
        return reply.send(deviceSessionResponseSchema.parse({
          token: result.sessionToken,
          expiresAt: result.session.expiresAt.toISOString(),
          session: publicSession(result.session)
        }));
      } catch (error) {
        // Usuário apagado no Supabase: 401, como nas outras rotas. O bilhete NÃO volta — não há
        // sessão para emitir, e devolvê-lo só faria a TV insistir num caminho sem saída.
        if (isAuthenticationError(error)) return reply.code(401).send(authenticationFailure);

        // Qualquer outra falha é infraestrutura piscando: o bilhete volta e a próxima consulta
        // do laço, que chega em segundos, funciona.
        resultado.restore(now());
        request.log.warn(
          { err: error, rota: request.routeOptions.url },
          "não foi possível emitir a sessão do pareamento"
        );
        // 503 neutro, e não relançar. O motivo original era que o Fastify entregava a mensagem
        // interna no corpo — hoje o setErrorHandler de buildApp já impede isso. O que sustenta
        // a escolha agora é outro: 503 com "tente de novo em instantes" diz à TV que insista,
        // e um 500 genérico não diz nada. É a mesma resposta que /v1/auth/device/code já dá.
        return reply.code(503).send({
          error: { code: "PAIRING_UNAVAILABLE", message: "Tente novamente em alguns instantes." }
        });
      }
    });
  }

  app.get("/v1/auth/session", async (request, reply) => {
    const credential = readRequestSessionToken(request);
    if (credential === null) return reply.code(401).send(authenticationFailure);
    try {
      const session = await options.provider.verifySession(credential.token);
      // Sessão deslizante no navegador: o servidor já estendeu a validade; aqui o cookie ganha um
      // Max-Age novo para acompanhar. Só para quem chegou por cookie — o app (Bearer) não tem um.
      if (credential.source === "cookie") {
        const remainingSeconds = Math.floor((session.expiresAt.getTime() - now().getTime()) / 1_000);
        if (remainingSeconds > 0) {
          reply.header("Set-Cookie", serializeSessionCookie(credential.token, { maxAgeSeconds: remainingSeconds }));
        }
      }
      return reply.send(publicSession(session));
    } catch (error) {
      if (isAuthenticationError(error)) {
        return reply.code(401).send(authenticationFailure);
      }
      throw error;
    }
  });

  app.post("/v1/auth/logout", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    // Porta de cookie: exige Origin mesmo de quem chegou por Bearer. É de propósito — quem
    // não tem cookie para apagar usa /v1/auth/device/logout, que não pede Origin nenhuma.
    if (!requireWebOrigin(request, reply, options.webOrigin)) return reply;

    const credential = readRequestSessionToken(request);
    if (credential !== null) await options.provider.revokeSession(credential.token);

    reply.header("Set-Cookie", serializeExpiredSessionCookie());
    return reply.code(204).send();
  });
}
