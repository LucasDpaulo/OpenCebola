/**
 * Coordenador de busca incremental de fontes de reprodução.
 *
 * Hoje a busca de fontes espera todo mundo (servidor + cada add-on do navegador) antes de mostrar
 * qualquer coisa: um único add-on lento no navegador atrasa até o resultado do servidor, que
 * normalmente já chegou. `discoverStreams` publica cada lote assim que ele fica pronto — sem
 * esperar `Promise.allSettled` completar — e deduplica por `stream.id` para que quem chama sempre
 * receba a lista cumulativa e já sem repetição.
 *
 * Função pura de coordenação: não sabe nada de fetch, HTTP ou React. `server`, `browserTargets` e
 * `importTarget` são injetados como dependências que retornam promessas, exatamente para os testes
 * poderem usar promessas controladas e provar a ordem de publicação.
 */

export interface DiscoveredStream {
  readonly id: string;
}

export interface DiscoverStreamsOptions<TStream extends DiscoveredStream, TTarget> {
  /** Busca as fontes do servidor. Rejeição é isolada: não impede o lote do navegador. */
  readonly server: () => Promise<readonly TStream[]>;
  /** Lista os alvos que o navegador deve consultar (já filtrados por quem chama). */
  readonly browserTargets: () => Promise<readonly TTarget[]>;
  /** Consulta e importa um alvo do navegador. Cada alvo publica seu lote assim que resolve. */
  readonly importTarget: (target: TTarget) => Promise<readonly TStream[]>;
  /** Publicação é ignorada quando `signal` já estiver abortado. */
  readonly signal?: AbortSignal;
  /** Chamado a cada lote novo, com a lista cumulativa e deduplicada por `stream.id`. */
  readonly onBatch: (streams: readonly TStream[]) => void;
}

export async function discoverStreams<TStream extends DiscoveredStream, TTarget>(
  options: DiscoverStreamsOptions<TStream, TTarget>
): Promise<void> {
  const { server, browserTargets, importTarget, signal, onBatch } = options;
  const seen = new Map<string, TStream>();

  const publish = (streams: readonly TStream[]): void => {
    if (signal?.aborted) return;
    let changed = false;
    for (const stream of streams) {
      if (!seen.has(stream.id)) changed = true;
      seen.set(stream.id, stream);
    }
    if (!changed) return;
    onBatch([...seen.values()]);
  };

  const serverTask = (async (): Promise<void> => {
    try {
      publish(await server());
    } catch {
      // Falha isolada do servidor não pode apagar o lote do navegador nem impedir publicá-lo.
    }
  })();

  const browserTask = (async (): Promise<void> => {
    let targets: readonly TTarget[];
    try {
      targets = await browserTargets();
    } catch {
      return;
    }
    // Cada alvo publica assim que o seu próprio fetch termina; nada aqui espera os outros alvos
    // nem o servidor. `Promise.allSettled` só serve para aguardar todos terminarem antes de
    // encerrar a função — nunca para reter um lote já pronto.
    await Promise.allSettled(targets.map(async (target) => {
      try {
        publish(await importTarget(target));
      } catch {
        // Falha isolada de um alvo não apaga os lotes já publicados por outros.
      }
    }));
  })();

  await Promise.allSettled([serverTask, browserTask]);
}
