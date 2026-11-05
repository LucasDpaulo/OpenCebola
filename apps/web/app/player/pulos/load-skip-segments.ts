import type { SkipSegment } from "./skip-segments";

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Falhas transitórias permitem nova consulta; uma resposta válida sem trechos continua vazia. */
export async function loadSkipSegments(
  request: () => Promise<Response>,
  signal: AbortSignal,
  delay: (ms: number, signal: AbortSignal) => Promise<void> = wait
): Promise<readonly SkipSegment[] | null> {
  for (let attempt = 0; attempt < 4 && !signal.aborted; attempt++) {
    try {
      const response = await request();
      if (signal.aborted) return null;
      if (!response.ok) {
        if (response.status < 500 && response.status !== 408 && response.status !== 429) return null;
        throw new Error("skip-times temporariamente indisponível");
      }
      const body = await response.json() as { segments?: unknown };
      if (!Array.isArray(body.segments)) throw new Error("Resposta inválida");
      if (signal.aborted) return null;
      return body.segments.flatMap((value): SkipSegment[] => {
        if (typeof value !== "object" || value === null) return [];
        const item = value as Partial<SkipSegment>;
        return (item.kind === "intro" || item.kind === "recap" || item.kind === "outro") &&
          typeof item.start === "number" && Number.isFinite(item.start) && item.start >= 0 &&
          typeof item.end === "number" && Number.isFinite(item.end) && item.end > item.start &&
          (item.episodeLength == null || (typeof item.episodeLength === "number" && Number.isFinite(item.episodeLength)))
          ? [{ kind: item.kind, start: item.start, end: item.end, episodeLength: item.episodeLength ?? null }] : [];
      });
    } catch {
      if (signal.aborted) return null;
      if (attempt < 3) await delay([1_000, 3_000, 10_000][attempt]!, signal);
    }
  }
  return null;
}
