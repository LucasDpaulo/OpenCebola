// De onde o vídeo começa: UMA regra para todos os aparelhos. Antes ela vivia duplicada no caminho
// nativo e no do navegador de title-experience.tsx, e os dois divergiam (só um respeitava "do começo").
// Puro: a preferência de pular abertura entra por parâmetro, nada de window/localStorage aqui.
import { pontoDeRetomada, type ProgressoSalvo } from "../../progress";

/** Preferência explícita para a vinheta inicial do One Piece, não detecção de propaganda. */
export function initialPlaybackPosition(videoId: string | undefined, requestedStart: number, autoSkip: boolean): number {
  return autoSkip && requestedStart === 0 && /^(?:tt0388629|tmdb:37854):/.test(videoId ?? "") ? 10 : requestedStart;
}

/** Segundos em que a vinheta termina quando a pessoa pula abertura (10), ou 0 se não há salto. */
export function inicioDaVinheta(videoId: string | undefined, pularAbertura: boolean): number {
  return initialPlaybackPosition(videoId, 0, pularAbertura);
}

export type MotivoDoInicio = "troca-de-fonte" | "do-comeco" | "retomada" | "comeco";

export interface PedidoDeInicio {
  readonly videoId: string | undefined;
  /** Posição de quem estava tocando quando a pessoa trocou de fonte; null sem troca. */
  readonly posicaoDaTroca: number | null;
  /** A pessoa pediu "assistir do começo". */
  readonly doComeco: boolean;
  readonly salvo: ProgressoSalvo | null;
  /** Preferência "pular abertura automaticamente" (liga o salto da vinheta, ver initialPlaybackPosition). */
  readonly pularAbertura: boolean;
}

export interface Inicio {
  readonly segundos: number;
  readonly motivo: MotivoDoInicio;
}

export function decidirInicio(pedido: PedidoDeInicio): Inicio {
  const { videoId, posicaoDaTroca, doComeco, salvo, pularAbertura } = pedido;
  // Trocar de fonte continua de onde a pessoa estava, mesmo que ela tenha pedido "do começo" antes.
  if (posicaoDaTroca !== null && Number.isFinite(posicaoDaTroca) && posicaoDaTroca > 0) {
    return { segundos: posicaoDaTroca, motivo: "troca-de-fonte" };
  }
  if (doComeco) {
    return { segundos: initialPlaybackPosition(videoId, 0, pularAbertura), motivo: "do-comeco" };
  }
  const retomada = pontoDeRetomada(salvo);
  if (retomada > 0) return { segundos: retomada, motivo: "retomada" };
  return { segundos: initialPlaybackPosition(videoId, 0, pularAbertura), motivo: "comeco" };
}
