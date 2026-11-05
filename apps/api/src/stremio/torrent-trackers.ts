import ipaddr from "ipaddr.js";

/** Normalização sem DNS/requisições na Oracle. Destinos são revalidados pelo motor local. */
export function normalizeTorrentTrackers(sources: unknown): string[] {
  if (!Array.isArray(sources)) return [];
  const trackers = new Set<string>();
  for (const source of sources.slice(0, 128)) {
    if (typeof source !== "string" || !source.startsWith("tracker:")) continue;
    const value = source.slice(8);
    if (value.length > 2_048 || /[\s\u0000-\u001f\u007f]/.test(value)) continue;
    try {
      const url = new URL(value);
      if (!["http:", "https:", "udp:"].includes(url.protocol) ||
          url.username || url.password || url.hash) continue;
      const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
      if (!host || host === "localhost" || host.endsWith(".localhost") ||
          host.endsWith(".local") || host.endsWith(".internal") ||
          (!host.includes(".") && !host.includes(":"))) continue;
      if (ipaddr.isValid(host) && ipaddr.process(host).range() !== "unicast") continue;
      // UDP usa parser de esquema não especial; recusar hosts numéricos ambíguos.
      if (!ipaddr.isValid(host) && /^[0-9a-fx.:]+$/i.test(host)) continue;
      if (url.protocol === "udp:" && (!url.port || Number(url.port) < 1)) continue;
      trackers.add(url.href);
      if (trackers.size === 32) break;
    } catch { /* Uma fonte inválida não invalida o torrent. */ }
  }
  return [...trackers];
}

// O Torrentio manda `sources` em só parte das fontes (A Odisseia, 31/10/2026: 4 de 50). Sem tracker
// o motor local fica só no DHT, e na TV isso não acha peer em 30 s ("Torrent sem resposta"); com
// estes, o mesmo torrent abriu em 10 s. Só entram quando o add-on não manda nenhum.
const PUBLIC_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://explodie.org:6969/announce",
  "udp://tracker.dler.org:6969/announce",
  "udp://tracker.qu.ax:6969/announce"
];

export function torrentTrackers(sources: unknown): string[] {
  const trackers = normalizeTorrentTrackers(sources);
  return trackers.length > 0 ? trackers : [...PUBLIC_TRACKERS];
}
