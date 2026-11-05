import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  hideProgressRequestSchema,
  titleProgressRequestSchema,
  updateWatchProgressRequestSchema,
  watchProgressItemSchema,
  watchProgressQuerySchema,
  watchProgressResponseSchema
} from "@cebola/contracts";
import {
  AuthenticationError,
  isAuthenticationError,
  readRequestSessionToken,
  type AuthProvider,
  type AuthSession
} from "../auth/index.js";
import {
  ProfileNotFoundError,
  type HouseholdService
} from "../households/index.js";
import {
  ActiveProfileRequiredError,
  InvalidProgressError,
  type WatchProgress
} from "./domain.js";
import { requireTrustedOrigin } from "../http-origin.js";
import type { WatchProgressService } from "./service.js";

export interface ProgressRoutesOptions {
  readonly authProvider: AuthProvider;
  readonly households: HouseholdService;
  readonly progress: WatchProgressService;
  readonly webOrigin: string;
}

interface AuthenticatedRequest {
  readonly session: AuthSession;
}

async function authenticate(
  request: FastifyRequest,
  provider: AuthProvider
): Promise<AuthenticatedRequest> {
  const credential = readRequestSessionToken(request);
  if (credential === null) throw new AuthenticationError();
  return { session: await provider.verifySession(credential.token) };
}

function publicItem(item: WatchProgress) {
  return watchProgressItemSchema.parse({
    id: item.id,
    addonId: item.addonId,
    playbackAddonId: item.playbackAddonId,
    mediaId: item.mediaId,
    videoId: item.videoId,
    mediaType: item.mediaType,
    title: item.title,
    episodeTitle: item.episodeTitle,
    season: item.season,
    episode: item.episode,
    posterUrl: item.posterUrl,
    positionSeconds: item.positionSeconds,
    durationSeconds: item.durationSeconds,
    completed: item.completed,
    watched: item.watched ?? item.completed,
    hiddenFromContinue: item.hiddenFromContinue ?? false,
    updatedAt: item.updatedAt.toISOString(),
    playbackScenario: item.playbackScenario
  });
}

async function resolveScope(request: FastifyRequest, options: ProgressRoutesOptions) {
  const { session } = await authenticate(request, options.authProvider);
  // A casa é garantida em qualquer rota autenticada — nenhuma depende de
  // /v1/profiles ter sido visitada antes.
  const household = await options.households.ensureHouseholdForOwner(session.user.id);
  if (session.activeProfileId === null) throw new ActiveProfileRequiredError();
  return { householdId: household.id, profileId: session.activeProfileId };
}

function sendKnownError(error: unknown, reply: FastifyReply): FastifyReply {
  if (isAuthenticationError(error)) {
    return reply.code(401).send({
      error: { code: "AUTHENTICATION_FAILED", message: "Não foi possível autenticar." }
    });
  }
  if (error instanceof ActiveProfileRequiredError) {
    return reply.code(409).send({
      error: { code: "ACTIVE_PROFILE_REQUIRED", message: "Selecione um perfil para continuar." }
    });
  }
  if (error instanceof ProfileNotFoundError) {
    return reply.code(404).send({
      error: { code: "PROFILE_NOT_FOUND", message: "Perfil não encontrado." }
    });
  }
  if (error instanceof InvalidProgressError) {
    return reply.code(400).send({
      error: { code: "INVALID_REQUEST", message: "Dados de progresso inválidos." }
    });
  }
  throw error;
}

export async function registerProgressRoutes(
  app: FastifyInstance,
  options: ProgressRoutesOptions
): Promise<void> {
  app.post("/v1/progress/title", async (request, reply) => {
    const body = titleProgressRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "Consulta inválida." } });
    try {
      const scope = await resolveScope(request, options);
      const items = await options.progress.listForTitle(scope.householdId, scope.profileId, body.data, body.data.offset);
      return reply.send(watchProgressResponseSchema.parse({ items: items.map(publicItem) }));
    } catch (error) { return sendKnownError(error, reply); }
  });

  app.put("/v1/progress/hidden", async (request, reply) => {
    const credential = readRequestSessionToken(request);
    if (!requireTrustedOrigin(request, reply, options.webOrigin, credential?.source ?? null)) return reply;
    const body = hideProgressRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "Dados inválidos." } });
    try {
      const scope = await resolveScope(request, options);
      await options.progress.hideTitle(scope.householdId, scope.profileId, {
        ...body.data, videoIds: [body.data.videoId]
      });
      return reply.code(204).send();
    } catch (error) { return sendKnownError(error, reply); }
  });

  app.get("/v1/progress", async (request, reply) => {
    const query = watchProgressQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({
        error: { code: "INVALID_REQUEST", message: "Consulta de progresso inválida." }
      });
    }

    try {
      const scope = await resolveScope(request, options);
      const items = await options.progress.listRecent(
        scope.householdId,
        scope.profileId,
        query.data.limit,
        query.data.includeCompleted
      );
      return reply.send(watchProgressResponseSchema.parse({ items: items.map(publicItem) }));
    } catch (error) {
      return sendKnownError(error, reply);
    }
  });

  app.put("/v1/progress", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    // Mesma regra das outras rotas autenticadas que mudam estado: cookie exige Origin, Bearer
    // dispensa. Sem isso o app toca o vídeo e não consegue gravar onde parou.
    const credential = readRequestSessionToken(request);
    if (!requireTrustedOrigin(request, reply, options.webOrigin, credential?.source ?? null)) {
      return reply;
    }
    const body = updateWatchProgressRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: { code: "INVALID_REQUEST", message: "Dados de progresso inválidos." }
      });
    }

    try {
      const scope = await resolveScope(request, options);
      if (body.data.expectedProfileId !== undefined && body.data.expectedProfileId !== scope.profileId) {
        return reply.code(409).send({ error: { code: "PROFILE_CHANGED", message: "O perfil ativo mudou." } });
      }
      const item = await options.progress.update({ ...scope, ...body.data });
      return reply.send(publicItem(item));
    } catch (error) {
      return sendKnownError(error, reply);
    }
  });
}
