// A lógica de progresso mora em `app/progress/` (módulo protegido). Este arquivo só reexporta, para
// não quebrar quem ainda importa daqui; some quando as telas passarem a usar `app/progress`.
export { pontoDeRetomada } from "../progress/resume";
export type { ProgressoSalvo } from "../progress/resume";
export { deveGravar } from "../progress/tracker";
