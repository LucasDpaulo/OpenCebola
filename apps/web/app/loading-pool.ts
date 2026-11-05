/**
 * Carrega uma lista em paralelo com teto, publicando cada resultado assim que ele chega.
 *
 * O que isto substitui na home: lotes em lockstep — quatro catálogos, espera todos, mais dois,
 * espera todos. Dez catálogos viravam quatro rodadas em série, e cada rodada durava o tempo da
 * fonte MAIS LENTA dela. Uma fonte ruim segurava as três boas que já tinham respondido.
 *
 * Aqui o teto continua existindo — ninguém quer disparar dez consultas de add-on de uma vez —
 * mas quem termina libera a vaga na hora. A posição é preservada: cada carga escreve no índice
 * de onde saiu, então a ordem não depende de quem respondeu primeiro.
 */
export interface LoadingPool<T, R> {
  readonly items: readonly T[];
  /** Quantas cargas simultâneas no máximo. Abaixo de 1 vira sequencial, nunca nenhuma. */
  readonly limit: number;
  readonly load: (item: T, index: number) => Promise<R>;
  /** Chamado a cada carga concluída, com uma cópia da lista na ordem original. */
  readonly onProgress: (results: readonly (R | null)[]) => void;
  /** Consultado antes de puxar cada novo item. Serve para abortar no meio. */
  readonly shouldStop?: () => boolean;
}

export async function loadWithPool<T, R>(pool: LoadingPool<T, R>): Promise<void> {
  const { items, limit, load, onProgress, shouldStop } = pool;
  if (items.length === 0) return;

  const results: (R | null)[] = new Array(items.length).fill(null);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (shouldStop?.()) return;
      const index = next;
      if (index >= items.length) return;
      next += 1;
      try {
        results[index] = await load(items[index]!, index);
      } catch {
        // Uma fonte fora do ar não pode levar as outras junto. O `null` já está no lugar.
      }
      // FORA do try de propósito. Publicar só no sucesso significa que, se todas as fontes
      // falharem, quem chamou nunca é avisado e a tela fica com o que já estava lá — o código
      // em lotes que isto substituiu sempre publicava, mesmo o lote inteiro tendo falhado.
      //
      // E é uma CÓPIA: `results` continua sendo escrito depois desta chamada. Entregar o array
      // vivo faria o consumidor receber sempre a mesma referência (React descarta o render por
      // igualdade) e ver a lista que ele guardou mudar sozinha.
      onProgress([...results]);
    }
  };

  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
}
