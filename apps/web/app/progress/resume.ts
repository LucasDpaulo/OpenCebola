// MÓDULO PROTEGIDO — salvamento de progresso. Não alterar sem pedido explícito do Lucas (ver AGENTS.md).

export interface ProgressoSalvo {
  readonly positionSeconds: number;
  readonly durationSeconds: number;
  readonly completed: boolean;
}

/** Volta um pouco antes do ponto salvo: retomar exatamente onde parou desorienta. */
const RECUO_SEGUNDOS = 10;
/** Abaixo disto não vale retomar — a pessoa mal começou. */
const MINIMO_PARA_RETOMAR = 30;
/** A esta distância do fim, o episódio conta como visto mesmo sem a marca de concluído. */
const FIM_SEGUNDOS = 20;

export function pontoDeRetomada(salvo: ProgressoSalvo | null): number {
  if (salvo === null || salvo.completed) return 0;
  if (salvo.positionSeconds < MINIMO_PARA_RETOMAR) return 0;
  const faltando = salvo.durationSeconds - salvo.positionSeconds;
  if (salvo.durationSeconds > 0 && faltando <= FIM_SEGUNDOS) return 0;
  return Math.max(0, salvo.positionSeconds - RECUO_SEGUNDOS);
}
