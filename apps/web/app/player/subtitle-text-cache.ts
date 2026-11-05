/** Compartilha leitura entre sincronia e pulos. Falhas não ficam guardadas. */
export function createSubtitleTextCache(read: (url: string) => Promise<string | null>) {
  const pending = new Map<string, Promise<string | null>>();
  const cache = new Map<string, { text: string; expires: number }>();
  return (url: string): Promise<string | null> => {
    const known = cache.get(url);
    if (known && known.expires > Date.now()) return Promise.resolve(known.text);
    cache.delete(url);
    const existing = pending.get(url);
    if (existing) return existing;
    const request = Promise.resolve().then(() => read(url)).catch(() => null).then((text) => {
      if (text !== null && text.trim() !== "" && text.length <= 1_000_000) {
        if (cache.size >= 8) cache.delete(cache.keys().next().value!);
        cache.set(url, { text, expires: Date.now() + 5 * 60_000 });
      }
      return text;
    }).finally(() => pending.delete(url));
    pending.set(url, request);
    return request;
  };
}
