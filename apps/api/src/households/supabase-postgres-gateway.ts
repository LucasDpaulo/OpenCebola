import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  DatabaseScalar,
  DatabaseValues,
  PostgresGateway
} from "./postgres-repository.js";

export interface SupabasePostgresGatewayOptions {
  readonly url: string;
  readonly serviceRoleKey: string;
}

export const SUPABASE_STATELESS_DATABASE_OPTIONS = Object.freeze({
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false
});

interface SupabaseErrorLike {
  readonly code?: string;
  readonly message?: string;
}

const SAFE_DATABASE_MESSAGES = [
  "profile_limit_reached",
  "device_limit_reached",
  "household_not_found",
  "profile_not_found"
] as const;

function safeCode(error: SupabaseErrorLike): string {
  return typeof error.code === "string" && /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/.test(error.code)
    ? error.code
    : "database_error";
}

function safeReason(error: SupabaseErrorLike): string | null {
  if (typeof error.message !== "string") return null;
  return SAFE_DATABASE_MESSAGES.find((reason) => error.message?.includes(reason)) ?? null;
}

/** A database error that deliberately excludes details, hints and row values. */
export class SupabasePostgresGatewayError extends Error {
  readonly code: string;

  constructor(error: SupabaseErrorLike) {
    const reason = safeReason(error);
    super(reason === null ? "Supabase database operation failed" : reason);
    this.name = "SupabasePostgresGatewayError";
    this.code = safeCode(error);
  }
}

function throwDatabaseError(error: SupabaseErrorLike | null): void {
  if (error !== null) throw new SupabasePostgresGatewayError(error);
}

function requireOne<Row>(data: unknown): Row {
  if (data === null || data === undefined) {
    throw new SupabasePostgresGatewayError({ code: "PGRST116" });
  }

  if (Array.isArray(data)) {
    if (data.length !== 1) {
      throw new SupabasePostgresGatewayError({ code: "PGRST116" });
    }
    return data[0] as Row;
  }

  return data as Row;
}

interface QueryResult {
  readonly data: unknown;
  readonly error: SupabaseErrorLike | null;
}

interface FilterableQuery extends PromiseLike<QueryResult> {
  eq(column: string, value: DatabaseScalar): FilterableQuery;
  select(columns: string): FilterableQuery;
  maybeSingle(): PromiseLike<QueryResult>;
}

function applyFilters(
  query: FilterableQuery,
  filters: DatabaseValues
): FilterableQuery {
  let current = query;
  for (const [column, value] of Object.entries(filters)) {
    current = current.eq(column, value);
  }
  return current;
}

/**
 * Concrete server-side gateway. The service-role client is stateless and must
 * never be constructed in browser code.
 */
export class SupabasePostgresGateway implements PostgresGateway {
  readonly #client: SupabaseClient;

  constructor(options: SupabasePostgresGatewayOptions, client?: SupabaseClient) {
    this.#client = client ?? createClient(options.url, options.serviceRoleKey, {
      auth: { ...SUPABASE_STATELESS_DATABASE_OPTIONS }
    });
  }

  async insertOne<Row>(table: string, values: DatabaseValues): Promise<Row> {
    const { data, error } = await this.#client
      .from(table)
      .insert(values)
      .select("*")
      .single();
    throwDatabaseError(error);
    return requireOne<Row>(data);
  }

  async findOne<Row>(table: string, filters: DatabaseValues): Promise<Row | null> {
    const query = applyFilters(
      this.#client.from(table).select("*") as unknown as FilterableQuery,
      filters
    );
    const { data, error } = await query.maybeSingle();
    throwDatabaseError(error);
    return data === null ? null : (data as Row);
  }

  async findMany<Row>(table: string, filters: DatabaseValues): Promise<readonly Row[]> {
    const query = applyFilters(
      this.#client.from(table).select("*") as unknown as FilterableQuery,
      filters
    );
    const { data, error } = await query;
    throwDatabaseError(error);
    return (data ?? []) as readonly Row[];
  }

  async updateOne<Row>(
    table: string,
    filters: DatabaseValues,
    values: DatabaseValues
  ): Promise<Row | null> {
    const query = applyFilters(
      this.#client.from(table).update(values) as unknown as FilterableQuery,
      filters
    );
    const { data, error } = await query.select("*").maybeSingle();
    throwDatabaseError(error);
    return data === null ? null : (data as Row);
  }

  async deleteOne(table: string, filters: DatabaseValues): Promise<boolean> {
    const query = applyFilters(
      this.#client.from(table).delete() as unknown as FilterableQuery,
      filters
    );
    const { error } = await query;
    throwDatabaseError(error);
    return true;
  }

  async rpcOne<Row>(functionName: string, parameters: DatabaseValues): Promise<Row> {
    const { data, error } = await this.#client.rpc(functionName, parameters);
    throwDatabaseError(error);
    return requireOne<Row>(data);
  }

  async rpcMany<Row>(
    functionName: string,
    parameters: DatabaseValues
  ): Promise<readonly Row[]> {
    const { data, error } = await this.#client.rpc(functionName, parameters);
    throwDatabaseError(error);
    if (!Array.isArray(data)) {
      throw new SupabasePostgresGatewayError({ code: "PGRST102" });
    }
    return data as readonly Row[];
  }
}
