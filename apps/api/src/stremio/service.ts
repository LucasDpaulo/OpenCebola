import type { StremioStatusResponse } from "@cebola/contracts";
import { StremioApiClient, type RejectedAddon } from "./api-client.js";
import type { StremioConnectionRepository } from "./repository.js";
import { StremioIntegrationError, type AddonDescriptor } from "./types.js";

export class StremioService {
  readonly #api: StremioApiClient;
  readonly #repository: StremioConnectionRepository;
  readonly #now: () => Date;
  readonly #refreshAfterMs: number;
  readonly #refreshes = new Map<string, Promise<readonly AddonDescriptor[]>>();

  constructor(options: {
    readonly api: StremioApiClient;
    readonly repository: StremioConnectionRepository;
    readonly now?: () => Date;
    readonly refreshAfterMs?: number;
  }) {
    this.#api = options.api;
    this.#repository = options.repository;
    this.#now = options.now ?? (() => new Date());
    this.#refreshAfterMs = options.refreshAfterMs ?? 5 * 60_000;
  }

  async link(householdId: string, email: string, password: string): Promise<StremioStatusResponse> {
    const rejected: RejectedAddon[] = [];
    const linked = await this.#api.login(email, password, (entry) => rejected.push(entry));
    const syncedAt = this.#now();
    await this.#repository.save({ householdId, ...linked, syncedAt });
    return {
      linked: true,
      addonCount: linked.addons.length,
      syncedAt: syncedAt.toISOString(),
      rejected: rejected.slice(0, 50)
    };
  }

  async status(householdId: string): Promise<StremioStatusResponse> {
    const status = await this.#repository.status(householdId);
    // status não reconsulta o Stremio, então não tem descarte novo para relatar.
    return status === null
      ? { linked: false, addonCount: 0, syncedAt: null, rejected: [] }
      : { linked: true, addonCount: status.addonCount, syncedAt: status.syncedAt.toISOString(), rejected: [] };
  }

  async sync(householdId: string): Promise<StremioStatusResponse> {
    const connection = await this.#repository.find(householdId);
    if (connection === null) throw new StremioIntegrationError("NOT_LINKED");
    const rejected: RejectedAddon[] = [];
    const addons = await this.#api.pullAddons(connection.authKey, (entry) => rejected.push(entry));
    const syncedAt = this.#now();
    await this.#repository.save({ householdId, authKey: connection.authKey, addons, syncedAt });
    return {
      linked: true,
      addonCount: addons.length,
      syncedAt: syncedAt.toISOString(),
      rejected: rejected.slice(0, 50)
    };
  }

  async disconnect(householdId: string): Promise<void> {
    await this.#repository.delete(householdId);
  }

  async addons(householdId: string): Promise<readonly AddonDescriptor[]> {
    const connection = await this.#repository.find(householdId);
    if (connection === null) throw new StremioIntegrationError("NOT_LINKED");
    if (this.#now().getTime() - connection.syncedAt.getTime() < this.#refreshAfterMs) {
      return connection.addons;
    }

    const active = this.#refreshes.get(householdId);
    if (active) return active;
    const refresh = (async () => {
      try {
        const addons = await this.#api.pullAddons(connection.authKey);
        await this.#repository.save({
          householdId,
          authKey: connection.authKey,
          addons,
          syncedAt: this.#now()
        });
        return addons;
      } catch {
        // Uma indisponibilidade momentânea do Stremio não pode derrubar a reprodução: usa a
        // última coleção válida e tenta sincronizar novamente numa próxima consulta.
        return connection.addons;
      } finally {
        this.#refreshes.delete(householdId);
      }
    })();
    this.#refreshes.set(householdId, refresh);
    return refresh;
  }
}
