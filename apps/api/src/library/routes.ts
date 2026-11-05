import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  importLibraryRequestSchema,
  libraryItemSchema,
  libraryResponseSchema,
  upsertLibraryItemRequestSchema
} from "@cebola/contracts";
import {
  AuthenticationError,
  isAuthenticationError,
  readRequestSessionToken,
  type AuthProvider
} from "../auth/index.js";
import { ProfileNotFoundError, type HouseholdService } from "../households/index.js";
import { requireTrustedOrigin } from "../http-origin.js";
import { ActiveProfileRequiredError } from "../progress/domain.js";
import { InvalidLibraryItemError, LibraryItemNotFoundError, type LibraryItem } from "./domain.js";
import type { LibraryService } from "./service.js";

export interface LibraryRoutesOptions {
  readonly authProvider: AuthProvider;
  readonly households: HouseholdService;
  readonly library: LibraryService;
  readonly webOrigin: string;
}

const libraryQuerySchema = z.object({}).strict();
const removeLibraryParamsSchema = upsertLibraryItemRequestSchema.pick({
  mediaType: true,
  mediaId: true
});

async function resolveScope(request: FastifyRequest, options: LibraryRoutesOptions) {
  const credential = readRequestSessionToken(request);
  if (credential === null) throw new AuthenticationError();
  const session = await options.authProvider.verifySession(credential.token);
  const household = await options.households.ensureHouseholdForOwner(session.user.id);
  if (session.activeProfileId === null) throw new ActiveProfileRequiredError();
  return { householdId: household.id, profileId: session.activeProfileId };
}

function publicItem(item: LibraryItem) {
  return libraryItemSchema.parse({
    id: item.id,
    addonId: item.addonId,
    mediaId: item.mediaId,
    mediaType: item.mediaType,
    name: item.name,
    posterUrl: item.posterUrl,
    backgroundUrl: item.backgroundUrl,
    description: item.description,
    releaseInfo: item.releaseInfo,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString()
  });
}

function invalidRequest(reply: FastifyReply) {
  return reply.code(400).send({
    error: { code: "INVALID_REQUEST", message: "Dados de biblioteca inválidos." }
  });
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
  if (error instanceof LibraryItemNotFoundError) {
    return reply.code(404).send({
      error: { code: "LIBRARY_ITEM_NOT_FOUND", message: "Item não encontrado na biblioteca." }
    });
  }
  if (error instanceof InvalidLibraryItemError) return invalidRequest(reply);
  throw error;
}

export async function registerLibraryRoutes(
  app: FastifyInstance,
  options: LibraryRoutesOptions
): Promise<void> {
  app.get("/v1/library", async (request, reply) => {
    if (!libraryQuerySchema.safeParse(request.query).success) return invalidRequest(reply);
    try {
      const scope = await resolveScope(request, options);
      const items = await options.library.list(scope.householdId, scope.profileId);
      return reply.send(libraryResponseSchema.parse({ items: items.map(publicItem) }));
    } catch (error) {
      return sendKnownError(error, reply);
    }
  });

  app.put("/v1/library", async (request, reply) => {
    const credential = readRequestSessionToken(request);
    if (!requireTrustedOrigin(request, reply, options.webOrigin, credential?.source ?? null)) return reply;
    const body = upsertLibraryItemRequestSchema.safeParse(request.body);
    if (!body.success) return invalidRequest(reply);
    try {
      const scope = await resolveScope(request, options);
      return reply.send(publicItem(await options.library.upsert(scope, body.data)));
    } catch (error) {
      return sendKnownError(error, reply);
    }
  });

  app.post("/v1/library/import", async (request, reply) => {
    const credential = readRequestSessionToken(request);
    if (!requireTrustedOrigin(request, reply, options.webOrigin, credential?.source ?? null)) return reply;
    const body = importLibraryRequestSchema.safeParse(request.body);
    if (!body.success) return invalidRequest(reply);
    try {
      const scope = await resolveScope(request, options);
      const items = await options.library.import(scope, body.data.items);
      return reply.send(libraryResponseSchema.parse({ items: items.map(publicItem) }));
    } catch (error) {
      return sendKnownError(error, reply);
    }
  });

  app.delete("/v1/library/:mediaType/:mediaId", async (request, reply) => {
    const credential = readRequestSessionToken(request);
    if (!requireTrustedOrigin(request, reply, options.webOrigin, credential?.source ?? null)) return reply;
    const params = removeLibraryParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply);
    try {
      const scope = await resolveScope(request, options);
      await options.library.remove(scope, params.data.mediaType, params.data.mediaId);
      return reply.code(204).send();
    } catch (error) {
      return sendKnownError(error, reply);
    }
  });
}
