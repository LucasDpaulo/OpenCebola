import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { AuthenticationError } from "./errors.js";
import type { AuthUser, PasswordCredentials } from "./types.js";

export interface ExternalAuthenticatedUser {
  readonly user: AuthUser;
}

/** O contrato não permite que access/refresh tokens do Supabase escapem. */
export interface SupabaseAuthGateway {
  authenticate(credentials: PasswordCredentials): Promise<ExternalAuthenticatedUser>;
  findUserById(userId: string): Promise<AuthUser | null>;
}

export interface SupabaseServerAuthGatewayOptions {
  readonly url: string;
  readonly publishableKey: string;
  readonly serviceRoleKey: string;
}

export const SUPABASE_STATELESS_AUTH_OPTIONS = Object.freeze({
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false
});

function newStatelessClient(url: string, key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { ...SUPABASE_STATELESS_AUTH_OPTIONS }
  });
}

/**
 * Gateway server-side. Cada tentativa de login recebe seu próprio cliente para
 * que sessões concorrentes nunca compartilhem estado em memória.
 */
export class SupabaseServerAuthGateway implements SupabaseAuthGateway {
  constructor(private readonly options: SupabaseServerAuthGatewayOptions) {}

  async authenticate(
    credentials: PasswordCredentials
  ): Promise<ExternalAuthenticatedUser> {
    const loginClient = newStatelessClient(
      this.options.url,
      this.options.publishableKey
    );
    const { data, error } = await loginClient.auth.signInWithPassword(credentials);
    const email = data.user?.email;

    if (error || !data.user || !email) {
      throw new AuthenticationError();
    }

    // data.session pode conter tokens Supabase, mas não atravessa esta fronteira.
    return {
      user: Object.freeze({ id: data.user.id, email })
    };
  }

  async findUserById(userId: string): Promise<AuthUser | null> {
    const adminClient = newStatelessClient(
      this.options.url,
      this.options.serviceRoleKey
    );
    const { data, error } = await adminClient.auth.admin.getUserById(userId);
    const email = data.user?.email;

    if (error || !data.user || !email) {
      return null;
    }

    return Object.freeze({ id: data.user.id, email });
  }
}
