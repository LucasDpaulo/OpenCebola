import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  activateProfileRequestSchema,
  createProfileRequestSchema,
  profileSummarySchema,
  profilesResponseSchema,
  updateProfileRequestSchema
} from "@cebola/contracts";
import {
  AuthenticationError,
  isAuthenticationError,
  readRequestSessionToken,
  type AuthProvider,
  type AuthSession
} from "../auth/index.js";
import {
  DomainValidationError,
  ProfileLimitExceededError,
  ProfileNotFoundError,
  opaqueArgon2idPinHash,
  type HouseholdRepository,
  type HouseholdService,
  type Profile
} from "../households/index.js";
import { requireTrustedOrigin } from "../http-origin.js";
import { PinError } from "./pin-service.js";

export interface ProfilePinService {
  hashPin(pin: string): Promise<string>;
  verifyPin(pin: string, encodedHash: string): Promise<boolean>;
}

export interface ProfileRoutesOptions {
  readonly authProvider: AuthProvider;
  readonly households: HouseholdService;
  readonly repository: HouseholdRepository;
  readonly pinService: ProfilePinService;
  readonly webOrigin: string;
}

interface AuthenticatedRequest {
  readonly token: string;
  readonly session: AuthSession;
}

function summary(profile: Profile) {
  return profileSummarySchema.parse({
    id: profile.id,
    name: profile.name,
    avatarUrl: profile.avatarUrl,
    hasPin: profile.hasPin
  });
}

async function authenticate(
  request: FastifyRequest,
  provider: AuthProvider
): Promise<AuthenticatedRequest> {
  const credential = readRequestSessionToken(request);
  if (credential === null) throw new AuthenticationError();
  return { token: credential.token, session: await provider.verifySession(credential.token) };
}

async function sendKnownError(error: unknown, reply: FastifyReply): Promise<FastifyReply> {
  if (isAuthenticationError(error)) {
    return reply.code(401).send({
      error: { code: "AUTHENTICATION_FAILED", message: "Não foi possível autenticar." }
    });
  }
  if (error instanceof PinError) {
    return reply.code(403).send({
      error: { code: "PROFILE_ACCESS_DENIED", message: "Não foi possível abrir o perfil." }
    });
  }
  if (error instanceof ProfileNotFoundError) {
    return reply.code(404).send({
      error: { code: "PROFILE_NOT_FOUND", message: "Perfil não encontrado." }
    });
  }
  if (error instanceof ProfileLimitExceededError) {
    return reply.code(409).send({
      error: { code: "PROFILE_LIMIT_REACHED", message: "O limite de 8 perfis foi atingido." }
    });
  }
  if (error instanceof DomainValidationError) {
    return reply.code(400).send({
      error: { code: "INVALID_REQUEST", message: "Dados do perfil inválidos." }
    });
  }
  throw error;
}

export async function registerProfileRoutes(
  app: FastifyInstance,
  options: ProfileRoutesOptions
): Promise<void> {
  app.get("/v1/profiles", async (request, reply) => {
    try {
      const { session } = await authenticate(request, options.authProvider);
      const household = await options.households.ensureHouseholdForOwner(session.user.id);
      const profiles = await options.households.listProfiles(household.id);
      return reply.send(profilesResponseSchema.parse({ profiles: profiles.map(summary) }));
    } catch (error) {
      return sendKnownError(error, reply);
    }
  });

  app.post("/v1/profiles", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    // A regra é a das outras rotas autenticadas que mudam estado: cookie exige Origin (o
    // navegador o anexa sozinho, então precisa da defesa contra CSRF), Bearer dispensa. Exigir
    // Origin sem olhar a procedência era o que impedia o app nativo de criar perfil — ele não
    // tem Origin que signifique nada, e recebia 403 numa rota que a fase 0a existe para servir.
    const credential = readRequestSessionToken(request);
    if (!requireTrustedOrigin(request, reply, options.webOrigin, credential?.source ?? null)) {
      return reply;
    }
    const parsed = createProfileRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "INVALID_REQUEST", message: "Dados do perfil inválidos." }
      });
    }

    try {
      const { session } = await authenticate(request, options.authProvider);
      const household = await options.households.ensureHouseholdForOwner(session.user.id);
      const pinHash = parsed.data.pin
        ? opaqueArgon2idPinHash(await options.pinService.hashPin(parsed.data.pin))
        : null;
      const profile = await options.households.createProfile({
        householdId: household.id,
        name: parsed.data.name,
        avatarUrl: parsed.data.avatarUrl,
        pinHash
      });
      return reply.code(201).send(summary(profile));
    } catch (error) {
      return sendKnownError(error, reply);
    }
  });

  app.patch("/v1/profiles/:profileId", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const credential = readRequestSessionToken(request);
    if (!requireTrustedOrigin(request, reply, options.webOrigin, credential?.source ?? null)) {
      return reply;
    }
    const parsedBody = updateProfileRequestSchema.safeParse(request.body);
    const parsedParams = profileSummarySchema.shape.id.safeParse(
      (request.params as { profileId?: unknown }).profileId
    );
    if (!parsedBody.success || !parsedParams.success) {
      return reply.code(400).send({
        error: { code: "INVALID_REQUEST", message: "Dados do perfil inválidos." }
      });
    }

    try {
      const { session } = await authenticate(request, options.authProvider);
      const household = await options.households.ensureHouseholdForOwner(session.user.id);

      let pinHash = undefined;
      let clearPin = false;
      if (parsedBody.data.pin === null) {
        clearPin = true;
      } else if (typeof parsedBody.data.pin === "string") {
        pinHash = opaqueArgon2idPinHash(await options.pinService.hashPin(parsedBody.data.pin));
      }

      const updated = await options.households.updateProfile({
        householdId: household.id,
        profileId: parsedParams.data,
        name: parsedBody.data.name,
        avatarUrl: parsedBody.data.avatarUrl,
        pinHash,
        clearPin
      });
      return reply.send(summary(updated));
    } catch (error) {
      return sendKnownError(error, reply);
    }
  });

  app.delete("/v1/profiles/:profileId", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const credential = readRequestSessionToken(request);
    if (!requireTrustedOrigin(request, reply, options.webOrigin, credential?.source ?? null)) {
      return reply;
    }
    const parsedParams = profileSummarySchema.shape.id.safeParse(
      (request.params as { profileId?: unknown }).profileId
    );
    if (!parsedParams.success) {
      return reply.code(400).send({
        error: { code: "INVALID_REQUEST", message: "Identificador de perfil inválido." }
      });
    }

    try {
      const authenticated = await authenticate(request, options.authProvider);
      const household = await options.households.ensureHouseholdForOwner(
        authenticated.session.user.id
      );
      await options.households.deleteProfile(household.id, parsedParams.data);

      if (authenticated.session.activeProfileId === parsedParams.data) {
        await options.authProvider.setActiveProfile(authenticated.token, null);
      }
      return reply.code(204).send();
    } catch (error) {
      return sendKnownError(error, reply);
    }
  });

  app.post("/v1/profiles/:profileId/activate", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    // Sem esta rota alcançável por Bearer o app entra na conta e trava: nenhum perfil ativo,
    // e /v1/progress responde 409 ACTIVE_PROFILE_REQUIRED sem saída nenhuma.
    const credential = readRequestSessionToken(request);
    if (!requireTrustedOrigin(request, reply, options.webOrigin, credential?.source ?? null)) {
      return reply;
    }
    const parsedBody = activateProfileRequestSchema.safeParse(request.body);
    const parsedParams = profileSummarySchema.shape.id.safeParse(
      (request.params as { profileId?: unknown }).profileId
    );
    if (!parsedBody.success || !parsedParams.success) {
      return reply.code(400).send({
        error: { code: "INVALID_REQUEST", message: "Dados do perfil inválidos." }
      });
    }

    try {
      const authenticated = await authenticate(request, options.authProvider);
      const household = await options.households.ensureHouseholdForOwner(
        authenticated.session.user.id
      );
      const profile = await options.repository.findProfile(household.id, parsedParams.data);
      if (!profile) throw new ProfileNotFoundError(parsedParams.data);
      if (profile.pinHash) {
        const accepted = parsedBody.data.pin
          ? await options.pinService.verifyPin(parsedBody.data.pin, profile.pinHash)
          : false;
        if (!accepted) throw new PinError();
      }

      await options.authProvider.setActiveProfile(authenticated.token, profile.id);
      return reply.code(204).send();
    } catch (error) {
      return sendKnownError(error, reply);
    }
  });
}
