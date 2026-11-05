// Ajustes de legenda: SINCRONIA é do vídeo, APARÊNCIA é do aparelho.
//
// Antes a chave do aparelho guardava os ajustes inteiros, sincronia inclusive, e o filme seguinte
// (sem cenário salvo nem continuidade) abria com ela: adiantar a legenda 2 s no filme A fazia o
// filme B abrir com +2 s naquele aparelho.
//
// REGRA:
// - `offset` e `extraDuration` vêm da continuidade do episódio anterior ou do cenário salvo DESTE
//   vídeo; sem nenhum dos dois, são 0. Nunca são gravados nem lidos da chave do aparelho (valores
//   antigos já gravados lá são ignorados).
// - `color`, `size`, `bg`, `font` seguem cenário/continuidade quando houver; sem eles, o que o
//   aparelho guardou. `position`, `fontFace` e `edge` são só do aparelho.
// Puro: o armazenamento entra por parâmetro, sem `window`. Esta é a única fonte da chave abaixo.

export interface SubtitleSettings {
  readonly offset: number;
  readonly extraDuration: number;
  readonly color: string;
  readonly size: number;
  readonly bg: "transparent" | "translucent" | "solid";
  readonly font: "sans" | "serif" | "mono";
  /**
   * Altura acima da posição padrão, em % da tela (0/ausente = padrão). Preferência SÓ do aparelho
   * (a altura certa no projetor não é a do celular): fica no `localStorage` e nunca vai no cenário
   * salvo na API — o contrato de lá não tem este campo e recusaria o salvamento inteiro (áudio,
   * legenda e posição do vídeo juntos). Ver `paraOCenario`.
   */
  readonly position?: number;
  /** Fonte da legenda NA TV (ausente = "netflix"). Só do aparelho, como `position`; ignorada fora da TV. */
  readonly fontFace?: "netflix" | "arial" | "roboto" | "serif" | "mono" | "casual";
  /** Contorno da legenda NA TV (ausente = "netflix"). Só do aparelho, como `position`. */
  readonly edge?: "netflix" | "outline" | "shadow" | "none";
}

export const DEFAULT_SUBTITLE_SETTINGS: SubtitleSettings = {
  offset: 0,
  extraDuration: 0,
  color: "#ffffff",
  size: 100,
  bg: "transparent",
  font: "sans"
};

export const CHAVE_DO_APARELHO = "cebola:player:subtitle_settings";

const BGS: readonly string[] = ["transparent", "translucent", "solid"];
const FONTS: readonly string[] = ["sans", "serif", "mono"];
const FONT_FACES: readonly string[] = ["netflix", "arial", "roboto", "serif", "mono", "casual"];
const EDGES: readonly string[] = ["netflix", "outline", "shadow", "none"];

const numero = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Lê do aparelho só aparência e preferências do aparelho; sincronia e valores inválidos ficam de fora. */
export function lerAjustesDoAparelho(armazenamento: Pick<Storage, "getItem"> | null): Partial<SubtitleSettings> {
  if (!armazenamento) return {};
  try {
    const texto = armazenamento.getItem(CHAVE_DO_APARELHO);
    const bruto: unknown = texto ? JSON.parse(texto) : null;
    if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return {};
    const r = bruto as Record<string, unknown>;
    const saida: { -readonly [K in keyof SubtitleSettings]?: SubtitleSettings[K] } = {};
    if (typeof r.color === "string") saida.color = r.color;
    if (numero(r.size)) saida.size = r.size;
    if (typeof r.bg === "string" && BGS.includes(r.bg)) saida.bg = r.bg as SubtitleSettings["bg"];
    if (typeof r.font === "string" && FONTS.includes(r.font)) saida.font = r.font as SubtitleSettings["font"];
    if (numero(r.position)) saida.position = r.position;
    if (typeof r.fontFace === "string" && FONT_FACES.includes(r.fontFace)) saida.fontFace = r.fontFace as SubtitleSettings["fontFace"];
    if (typeof r.edge === "string" && EDGES.includes(r.edge)) saida.edge = r.edge as SubtitleSettings["edge"];
    return saida;
  } catch {
    return {};
  }
}

/** Grava no aparelho tudo menos a sincronia (que é do vídeo). Erro de armazenamento é ignorado. */
export function gravarAjustesDoAparelho(armazenamento: Pick<Storage, "setItem"> | null, ajustes: SubtitleSettings): void {
  if (!armazenamento) return;
  try {
    const { offset: _offset, extraDuration: _extraDuration, ...doAparelho } = ajustes;
    armazenamento.setItem(CHAVE_DO_APARELHO, JSON.stringify(doAparelho));
  } catch { /* ignore */ }
}

/** Só os campos que são do aparelho (`position`, `fontFace`, `edge`), e só os definidos. */
export function soDoAparelho(aparelho: Partial<SubtitleSettings>): Partial<Pick<SubtitleSettings, "position" | "fontFace" | "edge">> {
  return {
    ...(aparelho.position !== undefined ? { position: aparelho.position } : {}),
    ...(aparelho.fontFace !== undefined ? { fontFace: aparelho.fontFace } : {}),
    ...(aparelho.edge !== undefined ? { edge: aparelho.edge } : {})
  };
}

export interface EntradaAjustes {
  readonly continuidade: SubtitleSettings | null;
  readonly salvo: SubtitleSettings | null;
  readonly aparelho: Partial<SubtitleSettings>;
}

/** Ajustes com que o vídeo abre: continuidade vence o cenário salvo; sem nenhum, sincronia 0. */
export function ajustesIniciais({ continuidade, salvo, aparelho }: EntradaAjustes): SubtitleSettings {
  const base = continuidade ?? salvo;
  if (base) {
    // Altura, fonte e contorno nunca vêm do servidor: valem os do aparelho, quando houver.
    return { ...DEFAULT_SUBTITLE_SETTINGS, ...base, ...soDoAparelho(aparelho) };
  }
  return { ...DEFAULT_SUBTITLE_SETTINGS, ...aparelho, offset: 0, extraDuration: 0 };
}

/** O que vai no cenário salvo na API: sem os campos só do aparelho (`position`, `fontFace`, `edge`). */
export function paraOCenario(ajustes: SubtitleSettings): SubtitleSettings {
  const { position: _position, fontFace: _fontFace, edge: _edge, ...compartilhados } = ajustes;
  return compartilhados;
}
