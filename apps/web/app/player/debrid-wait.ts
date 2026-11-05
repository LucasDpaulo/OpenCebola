/** Espera cancelável: fechar/trocar o vídeo interrompe também o intervalo entre consultas. */
export function waitForDebrid(signal: AbortSignal, milliseconds = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("Cancelado", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function pollDebrid<T>(options: {
  signal: AbortSignal;
  read: () => Promise<T>;
  pending: (value: T) => boolean;
  onPending: (value: T) => void;
  wait?: (signal: AbortSignal) => Promise<void>;
}): Promise<T> {
  for (;;) {
    options.signal.throwIfAborted();
    const value = await options.read();
    options.signal.throwIfAborted();
    if (!options.pending(value)) return value;
    options.onPending(value);
    await (options.wait ?? waitForDebrid)(options.signal);
  }
}

export function isDebridPlaceholder(stream: { addonName: string; readyNow?: boolean | null }, duration: number): boolean {
  return Number.isFinite(duration) && duration > 0 && duration <= 90 &&
    (stream.readyNow === false || /torrentio|real.?debrid|\bRD\b/i.test(stream.addonName));
}
