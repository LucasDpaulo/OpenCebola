/**
 * Avançar/voltar do controle remoto da TV. Cada tecla só soma a um deslocamento pendente (a busca
 * real acontece depois de uma pausa), porque a TV Samsung rebufferiza a cada `seek` — e segurar a
 * tecla acelera o passo para atravessar o episódio sem apertar dezenas de vezes.
 */

/** Passo (em segundos) para quem segura a seta há `heldMs`: cresce por degraus até 5 min. */
export function tvHoldSeekStep(heldMs: number): number {
  const table: [number, number][] = [
    [1500, 10], [3000, 20], [4500, 30], [6000, 60], [7500, 90], [9000, 120], [10500, 180], [12000, 240]
  ];
  for (const [limit, step] of table) if (heldMs <= limit) return step;
  return 300;
}

/** Texto do deslocamento acumulado: "+30 s", "+1 min 30 s", "−5 min". */
export function formatTvSeekOffset(offsetSeconds: number): string {
  const rounded = Math.round(Math.abs(offsetSeconds));
  const sign = offsetSeconds < 0 ? "−" : offsetSeconds > 0 ? "+" : "";
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  const parts: string[] = [];
  if (minutes > 0) parts.push(`${minutes} min`);
  if (seconds > 0 || minutes === 0) parts.push(`${seconds} s`);
  return `${sign}${parts.join(" ")}`;
}
