/**
 * Acesso tipado ao plugin nativo. Existe separado porque o `window.Capacitor` só aparece
 * dentro do app: no navegador toda função aqui devolve null, e a tela mostra o aviso em vez
 * de quebrar. É a mesma decisão do `isNativeRuntime` no cliente de API.
 */

export type FaixaNativa = {
  readonly id: number;
  readonly tipo: "audio" | "video" | "legenda" | "desconhecido";
  readonly codec: string | null;
  readonly codecOriginal: string | null;
  readonly idioma: string | null;
  readonly descricao: string | null;
  readonly canais?: number;
  readonly taxa?: number;
  readonly largura?: number;
  readonly altura?: number;
};

export type StatusNativo = {
  readonly evento: string;
  readonly hardware: boolean;
  /** Saídas de vídeo criadas pelo libVLC. Zero depois de tocar significa imagem não decodificada. */
  readonly vout: number;
  readonly tocando: boolean;
  readonly duracaoMs: number;
  readonly posicaoMs: number;
  readonly faixaAudioAtual: number;
  readonly faixas: readonly FaixaNativa[];
};

type PlayerPlugin = {
  // `load` e não `play`: o plugin cresceu para o contrato NativePlayer na fase 1b, e lá `play`
  // passou a significar "voltar a tocar depois da pausa". Esta tela só precisa começar do zero.
  load(options: {
    url: string; hardware: boolean; startAtSeconds: number;
    subtitles: readonly { url: string }[];
  }): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<StatusNativo>;
  selectTrack(options: { type: "audio" | "subtitle"; id: number }): Promise<{ ok: boolean }>;
};

export function player(): PlayerPlugin | null {
  if (typeof window === "undefined") return null;
  const ponte = (window as Window & {
    Capacitor?: { isNativePlatform?: () => boolean; Plugins?: { Player?: PlayerPlugin } };
  }).Capacitor;
  if (ponte?.isNativePlatform?.() !== true) return null;
  return ponte.Plugins?.Player ?? null;
}
