import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type {
  DatabaseValues,
  PostgresGateway
} from "../src/households/index.js";
import { PostgresLibraryRepository } from "../src/library/postgres-repository.js";

interface RecordedCall {
  readonly method: "rpcOne" | "rpcMany";
  readonly functionName: string;
  readonly parameters: DatabaseValues;
}

class RecordingGateway implements PostgresGateway {
  readonly calls: RecordedCall[] = [];
  readonly #results: unknown[];

  constructor(...results: unknown[]) {
    this.#results = [...results];
  }

  #next<Row>(): Row {
    return this.#results.shift() as Row;
  }

  async insertOne<Row>(_table: string, _values: DatabaseValues): Promise<Row> {
    throw new Error("unexpected insertOne");
  }

  async findOne<Row>(_table: string, _filters: DatabaseValues): Promise<Row | null> {
    throw new Error("unexpected findOne");
  }

  async findMany<Row>(_table: string, _filters: DatabaseValues): Promise<readonly Row[]> {
    throw new Error("unexpected findMany");
  }

  async updateOne<Row>(
    _table: string,
    _filters: DatabaseValues,
    _values: DatabaseValues
  ): Promise<Row | null> {
    throw new Error("unexpected updateOne");
  }

  async deleteOne(_table: string, _filters: DatabaseValues): Promise<boolean> {
    throw new Error("unexpected deleteOne");
  }

  async rpcOne<Row>(functionName: string, parameters: DatabaseValues): Promise<Row> {
    this.calls.push({ method: "rpcOne", functionName, parameters });
    return this.#next<Row>();
  }

  async rpcMany<Row>(
    functionName: string,
    parameters: DatabaseValues
  ): Promise<readonly Row[]> {
    this.calls.push({ method: "rpcMany", functionName, parameters });
    return this.#next<readonly Row[]>();
  }
}

const libraryRow = {
  id: "00000000-0000-4000-8000-000000000001",
  household_id: "10000000-0000-4000-8000-000000000001",
  profile_id: "20000000-0000-4000-8000-000000000001",
  addon_id: "community.cinemeta",
  media_id: "tt0111161",
  media_type: "movie" as const,
  name: "The Shawshank Redemption",
  poster_url: "https://images.example/poster.jpg",
  background_url: "https://images.example/background.jpg",
  description: "A story of hope and friendship.",
  release_info: "1994",
  created_at: "2026-09-18T12:00:00.000Z",
  updated_at: "2026-09-18T13:00:00.000Z"
};

test("list usa RPC com escopo completo e converte toda a linha", async () => {
  const gateway = new RecordingGateway([libraryRow]);
  const repository = new PostgresLibraryRepository(gateway);

  const items = await repository.list(libraryRow.household_id, libraryRow.profile_id);

  assert.deepEqual(gateway.calls, [{
    method: "rpcMany",
    functionName: "cebola_list_library",
    parameters: {
      p_household_id: libraryRow.household_id,
      p_profile_id: libraryRow.profile_id
    }
  }]);
  assert.deepEqual(items, [{
    id: libraryRow.id,
    householdId: libraryRow.household_id,
    profileId: libraryRow.profile_id,
    addonId: libraryRow.addon_id,
    mediaId: libraryRow.media_id,
    mediaType: "movie",
    name: libraryRow.name,
    posterUrl: libraryRow.poster_url,
    backgroundUrl: libraryRow.background_url,
    description: libraryRow.description,
    releaseInfo: libraryRow.release_info,
    createdAt: new Date(libraryRow.created_at),
    updatedAt: new Date(libraryRow.updated_at)
  }]);
});

test("upsert envia todos os campos em snake_case pela RPC e converte a resposta", async () => {
  const gateway = new RecordingGateway(libraryRow);
  const repository = new PostgresLibraryRepository(gateway);
  const record = {
    id: libraryRow.id,
    householdId: libraryRow.household_id,
    profileId: libraryRow.profile_id,
    addonId: libraryRow.addon_id,
    mediaId: libraryRow.media_id,
    mediaType: libraryRow.media_type,
    name: libraryRow.name,
    posterUrl: libraryRow.poster_url,
    backgroundUrl: libraryRow.background_url,
    description: libraryRow.description,
    releaseInfo: libraryRow.release_info,
    createdAt: new Date(libraryRow.created_at),
    updatedAt: new Date(libraryRow.updated_at)
  };

  const item = await repository.upsert(record);

  assert.deepEqual(gateway.calls, [{
    method: "rpcOne",
    functionName: "cebola_upsert_library_item",
    parameters: {
      p_id: record.id,
      p_household_id: record.householdId,
      p_profile_id: record.profileId,
      p_addon_id: record.addonId,
      p_media_id: record.mediaId,
      p_media_type: record.mediaType,
      p_name: record.name,
      p_poster_url: record.posterUrl,
      p_background_url: record.backgroundUrl,
      p_description: record.description,
      p_release_info: record.releaseInfo,
      p_created_at: record.createdAt.toISOString(),
      p_updated_at: record.updatedAt.toISOString()
    }
  }]);
  assert.equal(item.id, libraryRow.id);
  assert.equal(item.mediaId, libraryRow.media_id);
  assert.deepEqual(item.createdAt, record.createdAt);
  assert.deepEqual(item.updatedAt, record.updatedAt);
});

test("remove usa RPC escopada e devolve o booleano informado pelo banco", async () => {
  const gateway = new RecordingGateway(true);
  const repository = new PostgresLibraryRepository(gateway);

  const removed = await repository.remove(
    libraryRow.household_id,
    libraryRow.profile_id,
    libraryRow.media_type,
    libraryRow.media_id
  );

  assert.equal(removed, true);
  assert.deepEqual(gateway.calls, [{
    method: "rpcOne",
    functionName: "cebola_remove_library_item",
    parameters: {
      p_household_id: libraryRow.household_id,
      p_profile_id: libraryRow.profile_id,
      p_media_type: libraryRow.media_type,
      p_media_id: libraryRow.media_id
    }
  }]);
});

test("migration valida o esquema HTTPS sem diferenciar caixa e preserva a URL", async () => {
  const migration = await readFile(
    new URL("../../../infra/supabase/migrations/0008_profile_library.sql", import.meta.url),
    "utf8"
  );

  assert.match(migration, /starts_with\(lower\(poster_url\), 'https:\/\/'\)/);
  assert.match(migration, /starts_with\(lower\(background_url\), 'https:\/\/'\)/);
  assert.match(migration, /\n    p_poster_url,\n    p_background_url,/);
});
