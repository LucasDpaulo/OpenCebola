type Source = { kind: string; url: string | null; addonName?: string; label?: string; source?: string | null; readyNow?: boolean | null };
/** Links RD são serviços pagos; não tentar extrair um hash de URLs arbitrárias. */
export function isRealDebridSource(source: Source): boolean {
  if (source.kind !== "direct") return false;
  if (/\bRD\+|\breal[ -]?debrid\b/i.test([source.addonName, source.label, source.source].join(" "))) return true;
  if (source.readyNow != null && /torrentio/i.test(source.addonName ?? "")) return true;
  try {
    const url = new URL(source.url ?? "");
    return /(^|\.)(real-debrid\.com|realdebrid\.net)$/i.test(url.hostname) || /\/realdebrid(?:\/|$)/i.test(url.pathname);
  } catch { return false; }
}
export function sourcesForLocalEngine<T extends Source>(sources: readonly T[]): T[] {
  return sources.filter(source => !isRealDebridSource(source))
    .map(source => source.kind === "torrent" ? { ...source, readyNow: null } : source)
    .sort((a, b) => Number(b.kind === "torrent") - Number(a.kind === "torrent"));
}
