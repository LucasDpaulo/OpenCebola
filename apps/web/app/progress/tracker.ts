// MÓDULO PROTEGIDO — salvamento de progresso. Não alterar sem pedido explícito do Lucas (ver AGENTS.md).

/** De quanto em quanto tempo o progresso vai para a API. */
const INTERVALO_GRAVACAO = 15;
/** Quanto tempo, depois de `resumeFrom`, uma leitura baixa é tratada como o seek inicial. */
const PROTECAO_RETOMADA_MS = 30_000;
/** Margem do ponto de retomada: o motor costuma aterrissar um pouco antes do pedido. */
const MARGEM_RETOMADA = 5;
/** Depois de `ended`, só uma leitura entre estes limites (início + fim − margem) conta como rever. */
const MINIMO_PARA_REVER = 30;
const MARGEM_FIM = 20;

export interface ProgressReading {
  readonly positionSeconds: number;
  readonly durationSeconds: number;
}

/**
 * Gravar a cada segundo seria uma chamada por segundo numa VM de 1 OCPU. O salto para trás
 * também grava: quem voltou quer que a volta fique guardada.
 */
export function deveGravar(ultimoGravado: number, atual: number, intervalo: number = INTERVALO_GRAVACAO): boolean {
  return atual < ultimoGravado || atual - ultimoGravado >= intervalo;
}

function isValid(reading: ProgressReading): boolean {
  return Number.isFinite(reading.positionSeconds) && Number.isFinite(reading.durationSeconds) &&
    reading.durationSeconds >= 1 && reading.positionSeconds > 0;
}

export interface ProgressTracker {
  /** Retomada em `seconds`: por 30 s, leituras abaixo de `seconds − 5` são o seek inicial e não valem. */
  resumeFrom(seconds: number): void;
  /** Leitura do player (a cada tick). Grava a cada intervalo e quando a pessoa volta no vídeo. */
  position(positionSeconds: number, durationSeconds: number): void;
  /** Grava agora (pausa, fechar, trocar fonte ou cenário): a leitura dada ou a última válida. */
  flush(reading?: ProgressReading): void;
  /** Fim do vídeo: grava concluído. */
  ended(durationSeconds: number): void;
  /** Última leitura válida aceita, ou `null`. */
  lastReading(): ProgressReading | null;
}

export interface ProgressTrackerOptions {
  readonly save: (reading: ProgressReading, completed: boolean) => void;
  readonly intervalSeconds?: number;
  readonly now?: () => number;
}

/**
 * Decide QUANDO gravar; não sabe como (isso é do `body` e do `client`). Sem React e sem rede,
 * com relógio injetável — por isso dá para testar sem player.
 */
export function createProgressTracker(options: ProgressTrackerOptions): ProgressTracker {
  const { save, intervalSeconds = INTERVALO_GRAVACAO, now = () => Date.now() } = options;
  let last: ProgressReading | null = null;
  let lastSaved = 0;
  let finished = false;
  let resumeFloor = 0;
  let resumeUntil = 0;

  /** Guarda a leitura se ela vale; devolve se foi aceita. */
  function accept(reading: ProgressReading): boolean {
    if (!isValid(reading)) return false;
    // O player recém-aberto reporta posições baixas até o seek de retomada terminar. Gravá-las
    // apagaria no servidor o ponto em que a pessoa parou.
    if (resumeFloor > 0 && now() < resumeUntil && reading.positionSeconds < resumeFloor) return false;
    if (finished) {
      // Depois do fim o player ainda emite leituras (a final, ou o motor voltando ao começo). Isso
      // não é rever: só uma leitura bem dentro do vídeo reabre a gravação — senão fechar o player
      // trocaria o "concluído" por "1 s assistido".
      if (reading.positionSeconds < MINIMO_PARA_REVER ||
        reading.positionSeconds >= reading.durationSeconds - MARGEM_FIM) return false;
      finished = false;
    }
    last = { positionSeconds: reading.positionSeconds, durationSeconds: reading.durationSeconds };
    return true;
  }

  function write(): void {
    if (last === null) return;
    lastSaved = last.positionSeconds;
    save({ ...last }, finished);
  }

  return {
    resumeFrom(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) {
        resumeFloor = 0;
        return;
      }
      resumeFloor = seconds - MARGEM_RETOMADA;
      resumeUntil = now() + PROTECAO_RETOMADA_MS;
    },
    position(positionSeconds, durationSeconds) {
      if (!accept({ positionSeconds, durationSeconds })) return;
      if (deveGravar(lastSaved, positionSeconds, intervalSeconds)) write();
    },
    flush(reading) {
      if (reading !== undefined) accept(reading);
      write();
    },
    ended(durationSeconds) {
      const duration = Number.isFinite(durationSeconds) && durationSeconds >= 1
        ? durationSeconds : last?.durationSeconds ?? 0;
      if (duration < 1) return;
      finished = true;
      last = { positionSeconds: duration, durationSeconds: duration };
      write();
    },
    lastReading() {
      return last === null ? null : { ...last };
    }
  };
}
