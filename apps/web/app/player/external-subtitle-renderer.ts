import { apiFetch, apiUrl } from "../api-client";
import { falasAtivasEm, parseVttCues, type FalaLegenda } from "./subtitle-cues";
import type { PlayerEvents } from "./native-player";

export async function readExternalSubtitle(url: string): Promise<string> {
  const base = apiUrl("");
  const signal = AbortSignal.timeout(15_000);
  const response = url.startsWith(base)
    ? await apiFetch(url.slice(base.length), { signal, headers: { Accept: "text/vtt" } })
    : await fetch(url, { signal });
  if (!response.ok) throw new Error("Não foi possível abrir esta legenda.");
  return response.text();
}

/** Usa o relógio do vídeo, inclusive ao pausar, buscar e ajustar a legenda para trás. */
export class ExternalSubtitleRenderer {
  #cues: readonly FalaLegenda[] = [];
  #offset = 0;
  #extra = 0;
  #position = 0;
  #signature = "";
  constructor(private readonly emit: (cues: PlayerEvents["subtitleCues"]) => void) {}

  load(text: string): void {
    const cues = parseVttCues(text);
    if (!cues.length) throw new Error("Esta legenda veio vazia ou em formato não suportado.");
    this.clear();
    this.#cues = cues;
    this.update(this.#position);
  }

  clear(): void {
    this.#cues = [];
    this.#signature = "";
    this.emit([]);
  }

  timing(offset: number, extra: number): void {
    this.#offset = Number.isFinite(offset) ? offset : 0;
    this.#extra = Number.isFinite(extra) ? Math.max(0, extra) : 0;
    this.update(this.#position);
  }

  update(position: number): void {
    this.#position = position;
    const cues = falasAtivasEm(this.#cues, position, this.#offset, this.#extra);
    const signature = cues.map((cue) => cue.id).join("|");
    if (signature === this.#signature) return;
    this.#signature = signature;
    this.emit(cues);
  }
}
