import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SUPABASE_STATELESS_DATABASE_OPTIONS,
  SupabasePostgresGateway,
  SupabasePostgresGatewayError
} from "../src/households/index.js";

test("database client configuration disables every browser-style session behavior", () => {
  assert.deepEqual(SUPABASE_STATELESS_DATABASE_OPTIONS, {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false
  });
});

interface FakeResponse {
  readonly data: unknown;
  readonly error: { code?: string; message?: string; details?: string } | null;
}

class FakeQueryBuilder implements PromiseLike<FakeResponse> {
  readonly operations: Array<readonly [string, ...unknown[]]> = [];

  constructor(private readonly response: FakeResponse) {}

  insert(values: unknown): this {
    this.operations.push(["insert", values]);
    return this;
  }

  update(values: unknown): this {
    this.operations.push(["update", values]);
    return this;
  }

  delete(): this {
    this.operations.push(["delete"]);
    return this;
  }

  select(columns: string): this {
    this.operations.push(["select", columns]);
    return this;
  }

  eq(column: string, value: unknown): this {
    this.operations.push(["eq", column, value]);
    return this;
  }

  single(): Promise<FakeResponse> {
    this.operations.push(["single"]);
    return Promise.resolve(this.response);
  }

  maybeSingle(): Promise<FakeResponse> {
    this.operations.push(["maybeSingle"]);
    return Promise.resolve(this.response);
  }

  then<TResult1 = FakeResponse, TResult2 = never>(
    onfulfilled?: ((value: FakeResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.response).then(onfulfilled, onrejected);
  }
}

class FakeSupabaseClient {
  readonly tables: string[] = [];
  readonly rpcCalls: Array<readonly [string, unknown]> = [];
  readonly builders: FakeQueryBuilder[] = [];
  readonly #responses: FakeResponse[];

  constructor(...responses: FakeResponse[]) {
    this.#responses = [...responses];
  }

  #builder(): FakeQueryBuilder {
    const builder = new FakeQueryBuilder(
      this.#responses.shift() ?? { data: null, error: null }
    );
    this.builders.push(builder);
    return builder;
  }

  from(table: string): FakeQueryBuilder {
    this.tables.push(table);
    return this.#builder();
  }

  async rpc(functionName: string, parameters: unknown): Promise<FakeResponse> {
    this.rpcCalls.push([functionName, parameters]);
    return this.#responses.shift() ?? { data: null, error: null };
  }
}

function gatewayWith(client: FakeSupabaseClient): SupabasePostgresGateway {
  return new SupabasePostgresGateway(
    { url: "https://example.supabase.co", serviceRoleKey: "server-secret" },
    client as unknown as SupabaseClient
  );
}

test("insertOne requests and returns exactly one row", async () => {
  const row = { id: "house-1", name: "Casa" };
  const client = new FakeSupabaseClient({ data: row, error: null });

  assert.deepEqual(await gatewayWith(client).insertOne("households", row), row);
  assert.deepEqual(client.tables, ["households"]);
  assert.deepEqual(client.builders[0]?.operations, [
    ["insert", row],
    ["select", "*"],
    ["single"]
  ]);
});

test("find and update apply every household-scoped equality filter", async () => {
  const row = { id: "device-1", household_id: "house-1", status: "active" };
  const client = new FakeSupabaseClient(
    { data: row, error: null },
    { data: row, error: null }
  );
  const gateway = gatewayWith(client);

  await gateway.findOne("devices", { id: "device-1", household_id: "house-1" });
  await gateway.updateOne(
    "devices",
    { id: "device-1", household_id: "house-1", status: "active" },
    { last_seen_at: "2026-08-18T21:00:00.000Z" }
  );

  assert.deepEqual(client.builders[0]?.operations, [
    ["select", "*"],
    ["eq", "id", "device-1"],
    ["eq", "household_id", "house-1"],
    ["maybeSingle"]
  ]);
  assert.deepEqual(client.builders[1]?.operations, [
    ["update", { last_seen_at: "2026-08-18T21:00:00.000Z" }],
    ["eq", "id", "device-1"],
    ["eq", "household_id", "house-1"],
    ["eq", "status", "active"],
    ["select", "*"],
    ["maybeSingle"]
  ]);
});

test("rpcOne normalizes a single-row array returned by PostgREST", async () => {
  const row = { id: "profile-1" };
  const client = new FakeSupabaseClient({ data: [row], error: null });
  const gateway = gatewayWith(client);

  assert.deepEqual(await gateway.rpcOne("cebola_create_profile_within_limit", { p_id: "x" }), row);
  assert.deepEqual(client.rpcCalls, [
    ["cebola_create_profile_within_limit", { p_id: "x" }]
  ]);
});

test("rpcMany preserves an ordered list returned by PostgREST", async () => {
  const rows = [{ id: "progress-2" }, { id: "progress-1" }];
  const client = new FakeSupabaseClient({ data: rows, error: null });
  const gateway = gatewayWith(client);

  assert.deepEqual(
    await gateway.rpcMany("cebola_list_watch_progress", { p_profile_id: "profile-1" }),
    rows
  );
  assert.deepEqual(client.rpcCalls, [
    ["cebola_list_watch_progress", { p_profile_id: "profile-1" }]
  ]);
});

test("database errors retain only safe code and allowlisted limit reason", async () => {
  const client = new FakeSupabaseClient({
    data: null,
    error: {
      code: "23514",
      message: "profile_limit_reached: secret-row-value",
      details: "sensitive database detail"
    }
  });

  await assert.rejects(gatewayWith(client).findMany("profiles", {}), (error: unknown) => {
    assert.ok(error instanceof SupabasePostgresGatewayError);
    assert.equal(error.code, "23514");
    assert.equal(error.message, "profile_limit_reached");
    assert.equal(error.message.includes("secret-row-value"), false);
    assert.equal(JSON.stringify(error).includes("sensitive database detail"), false);
    return true;
  });
});

test("unknown database messages are fully replaced", async () => {
  const client = new FakeSupabaseClient({
    data: null,
    error: { code: "XX000", message: "password and row value leaked here" }
  });

  await assert.rejects(gatewayWith(client).rpcOne("some_rpc", {}), (error: unknown) => {
    assert.ok(error instanceof SupabasePostgresGatewayError);
    assert.equal(error.code, "XX000");
    assert.equal(error.message, "Supabase database operation failed");
    return true;
  });
});
