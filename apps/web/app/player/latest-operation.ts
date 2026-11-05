/**
 * Guarda de "última operação vence" para buscas e resoluções assíncronas do player.
 *
 * A troca de fonte/episódio dispara várias cadeias assíncronas encadeadas (busca de fontes,
 * resolução de link no debrid, espera de progresso). Um `AbortController` isolado, reatribuído a
 * cada chamada, não é suficiente: se uma chamada mais nova reatribui a referência antes da mais
 * antiga terminar de aguardar, a mais antiga pode ler um sinal que já não é o seu — ela precisa de
 * uma geração própria, capturada no momento em que começou, para nunca se confundir com uma
 * operação futura que por acaso reutilize o mesmo objeto.
 *
 * Cada `start()` aborta o controller da operação anterior e incrementa a geração global.
 * `isCurrent()` só é verdadeiro quando a geração capturada na criação do handle ainda é a mais
 * recente E o sinal daquele controller específico não foi abortado — a resposta tardia de uma
 * chamada superada nunca pode causar `setState` de resultado.
 */

export interface LatestOperationHandle {
  /** Sinal a repassar para `apiFetch`/`fetch`/qualquer espera cancelável desta operação. */
  readonly signal: AbortSignal;
  /** Verdadeiro somente enquanto esta for a operação mais recente e ela não tiver sido cancelada. */
  isCurrent(): boolean;
  /** Marca a operação como concluída normalmente, liberando a referência interna. */
  finish(): void;
}

export class LatestOperation {
  private controller: AbortController | null = null;
  private generation = 0;

  start(): LatestOperationHandle {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const generation = (this.generation += 1);

    return {
      signal: controller.signal,
      isCurrent: () => this.generation === generation && !controller.signal.aborted,
      finish: () => {
        if (this.controller === controller) this.controller = null;
      }
    };
  }

  /** Cancela a operação em andamento, se houver. Chamado ao fechar o player ou desmontar. */
  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }
}
