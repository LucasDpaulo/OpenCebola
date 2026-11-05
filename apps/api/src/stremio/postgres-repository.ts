import type { PostgresGateway } from "../households/index.js";
import type { SaveStremioConnection, StremioConnectionRepository } from "./repository.js";
import {
  addonCollectionSchema,
  type StremioConnection,
  type StremioConnectionStatus
} from "./types.js";
import { StremioVault, type EncryptedValue } from "./vault.js";

interface ConnectionRow {
  household_id: string;
  auth_ciphertext: string;
  auth_iv: string;
  auth_tag: string;
  addons_ciphertext: string;
  addons_iv: string;
  addons_tag: string;
  addon_count: number;
  synced_at: string;
}

function context(householdId: string, value: "auth" | "addons"): string {
  return `cebola:stremio:${householdId}:${value}:v1`;
}

function encrypted(row: ConnectionRow, prefix: "auth" | "addons"): EncryptedValue {
  return {
    ciphertext: row[`${prefix}_ciphertext`],
    iv: row[`${prefix}_iv`],
    tag: row[`${prefix}_tag`]
  };
}

export class PostgresStremioConnectionRepository implements StremioConnectionRepository {
  readonly #gateway: PostgresGateway;
  readonly #vault: StremioVault;

  constructor(gateway: PostgresGateway, vault: StremioVault) {
    this.#gateway = gateway;
    this.#vault = vault;
  }

  async save(record: SaveStremioConnection): Promise<void> {
    const auth = this.#vault.encrypt(record.authKey, context(record.householdId, "auth"));
    const addons = this.#vault.encrypt(
      JSON.stringify(record.addons),
      context(record.householdId, "addons")
    );
    await this.#gateway.rpcOne<ConnectionRow>("cebola_upsert_stremio_connection", {
      p_household_id: record.householdId,
      p_auth_ciphertext: auth.ciphertext,
      p_auth_iv: auth.iv,
      p_auth_tag: auth.tag,
      p_addons_ciphertext: addons.ciphertext,
      p_addons_iv: addons.iv,
      p_addons_tag: addons.tag,
      p_addon_count: record.addons.length,
      p_synced_at: record.syncedAt.toISOString()
    });
  }

  async find(householdId: string): Promise<StremioConnection | null> {
    const row = await this.#gateway.findOne<ConnectionRow>("stremio_connections", {
      household_id: householdId
    });
    if (row === null) return null;
    const authKey = this.#vault.decrypt(encrypted(row, "auth"), context(householdId, "auth"));
    const addonsJson = this.#vault.decrypt(
      encrypted(row, "addons"),
      context(householdId, "addons")
    );
    const addons = addonCollectionSchema.parse(JSON.parse(addonsJson) as unknown);
    return { householdId, authKey, addons, syncedAt: new Date(row.synced_at) };
  }

  async status(householdId: string): Promise<StremioConnectionStatus | null> {
    const row = await this.#gateway.findOne<ConnectionRow>("stremio_connections", {
      household_id: householdId
    });
    return row === null
      ? null
      : { addonCount: row.addon_count, syncedAt: new Date(row.synced_at) };
  }

  async delete(householdId: string): Promise<void> {
    await this.#gateway.rpcOne<boolean>("cebola_delete_stremio_connection", {
      p_household_id: householdId
    });
  }
}
