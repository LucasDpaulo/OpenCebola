export {
  AUTHENTICATION_ERROR_MESSAGE,
  AuthenticationError,
  isAuthenticationError
} from "./errors.js";
export {
  CachingAuthProvider,
  type CachingAuthProviderOptions
} from "./caching-auth-provider.js";
export {
  InMemoryAuthProvider,
  type InMemoryAuthProviderOptions,
  type InMemoryAuthUser
} from "./in-memory-auth-provider.js";
export {
  SESSION_COOKIE_NAME,
  readSessionToken,
  serializeExpiredSessionCookie,
  serializeSessionCookie,
  type SessionCookieOptions
} from "./session-cookie.js";
export {
  readRequestSessionToken,
  type RequestSessionToken,
  type SessionTokenSource
} from "./session-token.js";
export { registerAuthRoutes, type AuthRoutesOptions } from "./routes.js";
export {
  SessionTokenCollisionError,
  type CreateOpaqueSession,
  type OpaqueSessionRecord,
  type SessionRepository
} from "./session-repository.js";
export {
  SupabaseAuthProvider,
  hashOpaqueSessionToken,
  type SupabaseAuthProviderOptions
} from "./supabase-auth-provider.js";
export {
  SUPABASE_STATELESS_AUTH_OPTIONS,
  SupabaseServerAuthGateway,
  type ExternalAuthenticatedUser,
  type SupabaseAuthGateway,
  type SupabaseServerAuthGatewayOptions
} from "./supabase-server-auth-gateway.js";
export {
  SupabaseSessionRepository,
  type SupabaseSessionRepositoryOptions
} from "./supabase-session-repository.js";
export {
  systemClock,
  type AuthProvider,
  type AuthResult,
  type AuthSession,
  type AuthUser,
  type Clock,
  type PasswordCredentials
} from "./types.js";
export {
  DevicePairingStore,
  type DevicePairingClaim,
  type DevicePairingStoreOptions,
  type DevicePairingTicket
} from "./device-pairing.js";
