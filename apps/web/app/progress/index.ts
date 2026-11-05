// MÓDULO PROTEGIDO — salvamento de progresso. Não alterar sem pedido explícito do Lucas (ver AGENTS.md).
// API pública: telas e players só importam daqui, nunca dos arquivos internos.
export { progressVideoId, findSavedProgress, progressForTitle } from "./identity";
export { buildProgressBody } from "./body";
export type { ProgressBodyInput, ProgressBodyResult } from "./body";
export { createProgressTracker, deveGravar } from "./tracker";
export type { ProgressReading, ProgressTracker, ProgressTrackerOptions } from "./tracker";
export { sendProgress, fetchProgressItems, fetchTitleProgress, hideProgress, mergeSavedProgress, retryPendingProgress } from "./client";
export type { SavedProgressItem, SendProgressOptions } from "./client";
export { pontoDeRetomada } from "./resume";
export type { ProgressoSalvo } from "./resume";
