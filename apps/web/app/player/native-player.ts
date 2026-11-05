/**
 * A única fronteira nativa do sistema. A interface em React nunca fala com o libVLC nem com o
 * `<video>`: ela fala com isto, e quem implementa decide o motor.
 *
 * O contrato veio da spec (`2026-08-24-app-nativo-design.md`, seção "Interface do player") com
 * três ajustes que as medições de 26/08/2026 no Redmi Note 7 obrigaram:
 *
 *   1. `subtitleTracks()` existe. A spec previa só legenda externa, mas os arquivos medidos
 *      trazem faixas embutidas — inclusive PGS, que é imagem e não atravessa `<track>`.
 *   2. `capabilities()` relata o que ESTE aparelho conseguiu, não uma tabela de suposições.
 *   3. `state()` existe. A spec só tinha eventos, e interface em React precisa poder LER o
 *      estado ao montar — sem isso, um componente que aparece no meio da reprodução fica em
 *      branco até o próximo evento chegar.
 */

export interface PlayerSource {
  readonly url: string;
  /** Onde começar. É por aqui que a retomada acontece — não existe "seek logo após tocar". */
  readonly startAtSeconds: number;
  /** Legendas externas, vindas da API. As embutidas no arquivo aparecem em `subtitleTracks()`. */
  readonly subtitles: readonly { readonly id: string; readonly label: string; readonly language: string; readonly url: string }[];
  /** Ausente ou null mantém todas desligadas até uma escolha explícita. */
  readonly defaultSubtitleId?: string | null;
  /**
   * Pede o motor de reserva da plataforma, quando ela tem um (hoje só o PC: mpv no lugar do
   * GStreamer, para arquivos que o GStreamer não consegue ler). As demais ignoram.
   */
  readonly alternativeEngine?: boolean;
}

export interface PlayerTrack {
  readonly id: string;
  readonly label: string;
  readonly language: string | null;
}

/** Um capítulo cru do arquivo (ex.: MKV via libVLC), em segundos. */
export interface PlayerChapter {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

export interface PlayerCapabilities {
  readonly hevc: boolean;
  readonly ac3: boolean;
  readonly eac3: boolean;
  readonly dts: boolean;
  readonly mkv: boolean;
}

export interface PlayerState {
  readonly loaded: boolean;
  readonly playing: boolean;
  readonly positionSeconds: number;
  readonly durationSeconds: number;
  readonly audioTrackId: string | null;
  readonly subtitleTrackId: string | null;
}

/**
 * `position` chega uma vez por segundo, e é o que alimenta a barra e a gravação de progresso.
 * `error` carrega uma mensagem já pronta para a tela — quem implementa traduz o erro do motor.
 */
export interface PlayerEvents {
  position: number;
  ready: PlayerState;
  ended: void;
  error: string;
  /** Texto de legenda já sincronizado pelo motor nativo. */
  subtitleCues: readonly { readonly id: string; readonly text: string }[];
  tracksChanged: void;
}

export type PlayerListener<E extends keyof PlayerEvents> = (data: PlayerEvents[E]) => void;

/**
 * A CRIAÇÃO do player nunca espera a legenda: só a fonte escolhida importa. Antes, o efeito que
 * monta o player em `title-experience.tsx` também exigia `subtitleState === "ready"`, e cada
 * segundo gasto buscando legenda em `/v1/stremio/subtitles` virava tela em branco antes do vídeo
 * começar — mesmo quando a legenda nem carregava (serviço fora do ar).
 */
export function canLoadPlayerSource(selectedStreamId: string | null): boolean {
  return selectedStreamId !== null;
}

/**
 * Legenda que chega DEPOIS do `load()` não pode remontar o player: perderia a posição atual e
 * duplicaria a instância nativa por nada. Este objeto só sabe uma coisa — quais IDs de legenda
 * externa entraram no `load()` original — e quem chama decide o que fazer com uma legenda tardia
 * (hoje: avisar e pedir para reabrir, porque o contrato `NativePlayer` não tem "adicionar legenda
 * depois de carregado"; `selectSubtitleTrack` só resolve IDs que o motor já conhece).
 */
export class LateSubtitleGate {
  #loadedIds: ReadonlySet<string> = new Set();
  #hasLoaded = false;

  /** Chame com exatamente as legendas passadas ao `load()` desta sessão do player. */
  markLoaded(subtitles: readonly { readonly id: string }[]): void {
    this.#hasLoaded = true;
    this.#loadedIds = new Set(subtitles.map((subtitle) => subtitle.id));
  }

  /** Verdadeiro quando alguma legenda do array não estava entre as carregadas no `load()`. */
  hasLateSubtitles(subtitles: readonly { readonly id: string }[]): boolean {
    return this.#hasLoaded && subtitles.some((subtitle) => !this.#loadedIds.has(subtitle.id));
  }
}

export interface NativePlayer {
  load(source: PlayerSource): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(seconds: number): Promise<void>;
  audioTracks(): Promise<readonly PlayerTrack[]>;
  selectAudioTrack(id: string): Promise<void>;
  subtitleTracks(): Promise<readonly PlayerTrack[]>;
  /** Disponibiliza legendas externas que chegaram depois do início do vídeo. */
  addExternalSubtitles?(subtitles: PlayerSource["subtitles"], defaultSubtitleId?: string | null): Promise<void>;
  /**
   * `null` desliga a legenda. Depois da chamada só a faixa pedida fica ativa (ou nenhuma), embutida
   * ou externa; o adaptador mantém isso mesmo quando o motor liga uma faixa sozinho depois.
   */
  selectSubtitleTrack(id: string | null): Promise<void>;
  /** Faixas embutidas podem aceitar só atraso; a interface informa a limitação. */
  subtitleSettingsSupport?(): "all" | "timing";
  /**
   * Atraso e duração extra (em segundos) das legendas que o PRÓPRIO player desenha, para o ajuste
   * de sincronia valer também nos motores nativos. `offsetSeconds` positivo atrasa a fala;
   * `extraDurationSeconds` a mantém mais tempo na tela quando o suporte é "all".
   */
  setSubtitleTiming?(offsetSeconds: number, extraDurationSeconds: number): void | Promise<void>;
  /** Brilho da tela entre 0 e 1. Só plataformas móveis precisam implementar. */
  setBrightness?(level: number): Promise<void>;
  /** Alterna tela cheia usando o motor da plataforma, quando ele controla a superfície de vídeo. */
  toggleFullscreen?(): Promise<void>;
  /** Sai da tela cheia sem encerrar a reprodução. */
  exitFullscreen?(): Promise<void>;
  /** Alterna o áudio mudo e devolve o novo estado. */
  toggleMuted?(): Promise<boolean>;
  /** Ajusta o volume entre 0 e 1 e devolve o nível aplicado. */
  changeVolume?(delta: number): Promise<number>;
  /** Define diretamente o volume entre 0 e 1. */
  setVolume?(level: number): Promise<number>;
  /** Ajusta a velocidade de reprodução (ex: 0.75, 1, 1.25, 1.5, 2). */
  setPlaybackRate?(rate: number): Promise<void>;
  capabilities(): Promise<PlayerCapabilities>;
  /**
   * Capítulos do arquivo (hoje só MKV via libVLC no Android), quando o motor os expõe. Fallback
   * de "pular abertura/encerramento" (skip-segments.ts) usado só quando a API de skip-times não
   * tem segmento nenhum para o episódio.
   */
  chapters?(): Promise<readonly PlayerChapter[]>;
  /** Nome do motor em uso, para o registro de erros (ex.: "mpv", "gstreamer"). */
  engine?(): string;
  state(): PlayerState;
  /** Players persistentes podem devolver uma função para remover o listener ao fechar controles. */
  on<E extends keyof PlayerEvents>(event: E, listener: PlayerListener<E>): void | (() => void);
  destroy(): Promise<void>;
}
