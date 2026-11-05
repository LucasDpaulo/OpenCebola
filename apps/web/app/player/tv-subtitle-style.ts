/**
 * Estilo da legenda NA TV (padrão estilo Netflix). Função pura, usada pelos dois renderizadores
 * (overlay dos players nativos e Vidstack da TV Samsung) para os dois saírem iguais. PC e celular
 * não passam por aqui: seguem com o estilo de sempre.
 *
 * A TV Samsung tem uma única fonte de sistema (sans/serif/mono saem idênticas), por isso as
 * famílias são as fontes embutidas em `/fonts/subtitles` (declaradas em `styles.css`).
 */
export type TvSubtitleFontFace = "netflix" | "arial" | "roboto" | "serif" | "mono" | "casual";
export type TvSubtitleEdge = "netflix" | "outline" | "shadow" | "none";

export interface TvSubtitleStyle {
  readonly fontFamily: string;
  readonly fontWeight: number;
  readonly textShadow: string;
  /** `0 transparent` quando não há contorno de traço (`none` é inválido e o navegador descartaria a regra, mantendo o traço da classe). */
  readonly textStroke: string;
}

// "netflix": a Netflix Sans é proprietária; a Inter em negrito é a livre mais parecida (formas
// arredondadas, peso cheio). Arimo (métrica do Arial, a fonte de referência do guia de legendas da
// Netflix) fica como opção — em peso médio ela parecia fina e "reta" demais na TV.
const FONTS: Record<TvSubtitleFontFace, { family: string; weight: number }> = {
  netflix: { family: '"Cebola Legenda Inter", Inter, Arial, sans-serif', weight: 700 },
  arial: { family: '"Cebola Legenda Arimo", Arial, Helvetica, sans-serif', weight: 700 },
  roboto: { family: '"Cebola Legenda Roboto", Roboto, Arial, sans-serif', weight: 700 },
  serif: { family: '"Cebola Legenda Noto Serif", Georgia, serif', weight: 700 },
  mono: { family: '"Cebola Legenda Roboto Mono", monospace', weight: 700 },
  casual: { family: '"Cebola Legenda Comic Neue", "Comic Sans MS", cursive', weight: 700 }
};

const EDGES: Record<TvSubtitleEdge, { shadow: string; stroke: string }> = {
  // Sombra suave em volta (halo) + deslocada: legível sobre cena clara sem engrossar a letra.
  // Sombra projetada para baixo/direita e um halo escuro suave em volta, como na amostra do app
  // da Netflix — sem traço de contorno.
  netflix: {
    shadow: "0.04em 0.07em 0.1em rgba(0,0,0,0.85), 0 0 0.3em rgba(0,0,0,0.45)",
    stroke: "0 transparent"
  },
  outline: { shadow: "0 0.04em 0.12em rgba(0,0,0,0.6)", stroke: "0.06em #000" },
  shadow: { shadow: "0.06em 0.06em 0.18em rgba(0,0,0,0.95)", stroke: "0 transparent" },
  none: { shadow: "none", stroke: "0 transparent" }
};

/** Ausência (ou valor desconhecido) = padrão Netflix. */
export function resolveTvSubtitleStyle(fontFace?: string, edge?: string): TvSubtitleStyle {
  const font = FONTS[(fontFace as TvSubtitleFontFace) in FONTS ? (fontFace as TvSubtitleFontFace) : "netflix"];
  const border = EDGES[(edge as TvSubtitleEdge) in EDGES ? (edge as TvSubtitleEdge) : "netflix"];
  return { fontFamily: font.family, fontWeight: font.weight, textShadow: border.shadow, textStroke: border.stroke };
}

/** Tamanho na TV: base 4.6vh (~50 px em 1080p no "Médio") escalada pelo ajuste de tamanho. */
export function tvSubtitleFontSize(size: number): string {
  return `${(4.6 * size / 100).toFixed(3)}vh`;
}
