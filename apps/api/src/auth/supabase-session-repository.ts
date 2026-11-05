import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  SessionTokenCollisionError,
  type CreateOpaqueSession,
  type OpaqueSessionRecord,
  type SessionRepository
} from "./session-repository.js";
import { SUPABASE_STATELESS_AUTH_OPTIONS } from "./supabase-server-auth-gateway.js";

interface SessionRow {
  token_hash: string;
  user_id: string;
  expires_at: string;
  active_profile_id: string | null;
  revoked_at: string | null;
}

export interface SupabaseSessionRepositoryOptions {
  readonly url: string;
  readonly serviceRoleKey: string;
}

function toRecord(row: SessionRow): OpaqueSessionRecord {
  return {
    tokenHash: row.token_hash,
    userId: row.user_id,
    expiresAt: new Date(row.expires_at),
    activeProfileId: row.active_profile_id,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null
  };
}

/** Repositório acessível somente com a credencial server-side. */
export class SupabaseSessionRepository implements SessionRepository {
  private readonly client: SupabaseClient;

  constructor(options: SupabaseSessionRepositoryOptions) {
    this.client = createClient(options.url, options.serviceRoleKey, {
      auth: { ...SUPABASE_STATELESS_AUTH_OPTIONS }
    });
  }

  async create(session: CreateOpaqueSession): Promise<void> {
    const { error } = await this.client.from("cebola_auth_sessions").insert({
      token_hash: session.tokenHash,
      user_id: session.userId,
      expires_at: session.expiresAt.toISOString(),
      active_profile_id: session.activeProfileId
    });

    if (error?.code === "23505") {
      throw new SessionTokenCollisionError();
    }
    if (error) {
      throw new Error("Falha ao persistir sessão Cebola.");
    }
  }

  async findByTokenHash(tokenHash: string): Promise<OpaqueSessionRecord | null> {
    const { data, error } = await this.client
      .from("cebola_auth_sessions")
      .select("token_hash,user_id,expires_at,active_profile_id,revoked_at")
      .eq("token_hash", tokenHash)
      .maybeSingle<SessionRow>();

    if (error) {
      throw new Error("Falha ao consultar sessão Cebola.");
    }
    return data ? toRecord(data) : null;
  }

  async setActiveProfile(
    tokenHash: string,
    profileId: string | null,
    now: Date
  ): Promise<OpaqueSessionRecord | null> {
    const { data, error } = await this.client
      .from("cebola_auth_sessions")
      .update({ active_profile_id: profileId })
      .eq("token_hash", tokenHash)
      .is("revoked_at", null)
      .gt("expires_at", now.toISOString())
      .select("token_hash,user_id,expires_at,active_profile_id,revoked_at")
      .maybeSingle<SessionRow>();

    if (error) {
      throw new Error("Falha ao atualizar perfil da sessão Cebola.");
    }
    return data ? toRecord(data) : null;
  }

  async renew(tokenHash: string, newExpiresAt: Date, now: Date): Promise<void> {
    const { error } = await this.client
      .from("cebola_auth_sessions")
      .update({ expires_at: newExpiresAt.toISOString() })
      .eq("token_hash", tokenHash)
      .is("revoked_at", null)
      .gt("expires_at", now.toISOString());

    if (error) {
      throw new Error("Falha ao renovar sessão Cebola.");
    }
  }

  async revokeByTokenHash(tokenHash: string, revokedAt: Date): Promise<void> {
    const { error } = await this.client
      .from("cebola_auth_sessions")
      .update({
        revoked_at: revokedAt.toISOString(),
        active_profile_id: null
      })
      .eq("token_hash", tokenHash)
      .is("revoked_at", null);

    if (error) {
      throw new Error("Falha ao revogar sessão Cebola.");
    }
  }
}
