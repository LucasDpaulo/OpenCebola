// O ponto salvo só volta para trás por escolha da pessoa. O tracker protege a retomada por 30 s
// (`resumeFrom`); depois disso aceita qualquer leitura e, como "salto para trás" grava na hora,
// um motor que quebrou e recomeçou do 0 apagaria no servidor o ponto onde a pessoa parou.
// Esta guarda embrulha o tracker sem alterá-lo (ele é módulo protegido).
import type { ProgressReading, ProgressTracker } from "../../progress";

/** Mesma margem do tracker: o motor costuma aterrissar um pouco antes do ponto pedido. */
const MARGEM = 5;

export interface GuardaDoPontoSalvo extends ProgressTracker {
  /** O motor recomeçou sozinho: leituras abaixo de `pontoSalvo` não gravam até a pessoa passar dele ou buscar de propósito. */
  recomecoForcado(pontoSalvo: number): void;
  /** A pessoa buscou um ponto de propósito (barra, ±10 s, voltar): libera a guarda. */
  buscaDaPessoa(): void;
}

export function criarGuardaDoPontoSalvo(tracker: ProgressTracker): GuardaDoPontoSalvo {
  let piso: number | null = null;

  return {
    resumeFrom: (seconds) => tracker.resumeFrom(seconds),
    lastReading: () => tracker.lastReading(),
    recomecoForcado(pontoSalvo) {
      if (Number.isFinite(pontoSalvo) && pontoSalvo > 0) piso = pontoSalvo;
    },
    buscaDaPessoa() {
      piso = null;
    },
    position(positionSeconds, durationSeconds) {
      if (piso !== null) {
        // Passou do ponto (ou chegou perto): o motor alcançou a retomada, a guarda cumpriu o papel.
        if (positionSeconds < piso - MARGEM) return;
        piso = null;
      }
      tracker.position(positionSeconds, durationSeconds);
    },
    flush(reading?: ProgressReading) {
      // Sem a leitura baixa o tracker grava a última boa que já tinha (ou nada).
      if (piso !== null && reading !== undefined && reading.positionSeconds < piso - MARGEM) {
        tracker.flush();
        return;
      }
      tracker.flush(reading);
    },
    ended(durationSeconds) {
      piso = null;
      tracker.ended(durationSeconds);
    }
  };
}
