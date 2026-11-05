import type { AddonDescriptor, StremioConnection, StremioConnectionStatus } from "./types.js";

export interface SaveStremioConnection {
  readonly householdId: string;
  readonly authKey: string;
  readonly addons: readonly AddonDescriptor[];
  readonly syncedAt: Date;
}

export interface StremioConnectionRepository {
  save(record: SaveStremioConnection): Promise<void>;
  find(householdId: string): Promise<StremioConnection | null>;
  status(householdId: string): Promise<StremioConnectionStatus | null>;
  delete(householdId: string): Promise<void>;
}
