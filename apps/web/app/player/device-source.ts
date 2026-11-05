/** Successful torrent choices belong to this installation and profile, not account progress. */
export interface DeviceSourceKey { profileId: string; mediaType: string; mediaId: string; videoId: string }
export interface DeviceTorrent {
  kind: "torrent"; url: null; id: string; addonId: string; addonName: string; label: string;
  infoHash: string; fileIdx: number | null; filename?: string; trackers?: readonly string[];
  quality?: "4K" | "1080p" | "720p" | "480p" | "SD" | null;
}
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
const KEY = "cebola.deviceSources.v1";
const MAX_ENTRIES = 64;
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const identity = (key: DeviceSourceKey) => JSON.stringify([key.profileId, key.mediaType, key.mediaId, key.videoId]);
function storage(): Storage | null { try { return window.localStorage; } catch { return null; } }
function sanitize(value: unknown): DeviceTorrent | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!["id", "addonId", "addonName", "label"].every(k => typeof v[k] === "string" && (v[k] as string).length > 0 && (v[k] as string).length <= 1000) ||
      typeof v.infoHash !== "string" || !/^[a-f0-9]{40}$/i.test(v.infoHash) ||
      (v.fileIdx !== null && (!Number.isInteger(v.fileIdx) || Number(v.fileIdx) < 0 || Number(v.fileIdx) > 100000))) return null;
  const trackers = Array.isArray(v.trackers) ? v.trackers.flatMap(value => {
    try {
      if (typeof value !== "string" || value.length > 512) return [];
      const url = new URL(value);
      return url.protocol === "udp:" && !url.username && !url.password && !url.search && !url.hash ? [value] : [];
    } catch { return []; }
  }).slice(0, 20) : [];
  return { trackers, kind: "torrent", url: null, id: v.id as string, addonId: v.addonId as string,
    addonName: v.addonName as string, label: v.label as string, infoHash: v.infoHash.toLowerCase(), fileIdx: v.fileIdx as number | null,
    ...(typeof v.filename === "string" && v.filename.length <= 1000 ? { filename: v.filename } : {}),
    ...(["4K", "1080p", "720p", "480p", "SD", null].includes(v.quality as string | null) ? { quality: v.quality as DeviceTorrent["quality"] } : {}) };
}
type Entry = { key: string; at: number; source: DeviceTorrent };
function entries(store: Storage | null, now: number): Entry[] {
  try {
    const raw = store?.getItem(KEY);
    if (!raw || raw.length > 500000) return [];
    const items: unknown = JSON.parse(raw);
    if (!Array.isArray(items)) return [];
    return items.flatMap(v => {
      if (!v || typeof v.key !== "string" || typeof v.at !== "number" || !Number.isFinite(v.at) || v.at > now || now - v.at > MAX_AGE) return [];
      const source = sanitize(v.source);
      return source ? [{ key: v.key, at: v.at, source }] : [];
    }).slice(-MAX_ENTRIES);
  } catch { return []; }
}
export function readDeviceSource(key: DeviceSourceKey | null, store = storage(), now = Date.now()): DeviceTorrent | null {
  if (!key?.profileId) return null;
  return entries(store, now).find(e => e.key === identity(key))?.source ?? null;
}
export function rememberDeviceSource(key: DeviceSourceKey | null, source: unknown, store = storage(), now = Date.now()): void {
  if (!key?.profileId) return;
  const safe = sanitize(source);
  if (!safe) return;
  try { store?.setItem(KEY, JSON.stringify([...entries(store, now).filter(e => e.key !== identity(key)),
    { key: identity(key), at: now, source: safe }].slice(-MAX_ENTRIES))); } catch { /* best effort */ }
}
export function forgetDeviceSource(key: DeviceSourceKey | null, store = storage()): void {
  if (!key) return;
  try { store?.setItem(KEY, JSON.stringify(entries(store, Date.now()).filter(e => e.key !== identity(key)))); } catch { /* best effort */ }
}
